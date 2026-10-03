// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 6
// Real Cardano transaction submitter for vesting.ak's ClaimVested: a
// creator claiming their vested allocation. Shared by every Cardano launch,
// since vesting is one validator for all of them. A curve's creator fees are
// claimed from the curve's own submitter (tier-b-curve-submitter.ts).
// ============================================================================
// Creator-wallet-signed. ClaimVested requires the creator's signature
// (list.has(self.extra_signatories, datum.creator_pub_key_hash)), and the
// continuing output at vesting's own address must keep every token not yet
// claimable (vesting_tokens_retained()), so a claim pays only the creator
// and only what has vested.
//
// ClaimVested's current_timestamp IS bound to real chain time: the validator
// requires interval.contains(validity_range, current_timestamp) and a range
// no wider than max_validity_range_width. So the caller cannot choose it
// freely, the value is MILLISECONDS to match Cardano's own validity range,
// and this builder has to set the range itself — a transaction without one
// is refused by the script rather than merely being imprecise.
//
// Two signing shapes:
//   - claimVested(): the command-line path, signing with a decrypted creator
//     extended key (CML.PrivateKey.from_extended_bytes() +
//     sign.withPrivateKey()).
//   - claimVestedWithWallet(): a browser wallet, through
//     lucid.selectWallet.fromAPI(walletApi) + sign.withWallet().
// ============================================================================

import type {
  Assets,
  LucidEvolution,
  Network as LucidNetwork,
  SpendingValidator,
  TxSignBuilder,
  UTxO,
  WalletApi,
} from '@lucid-evolution/lucid';
import { Blockfrost, CML, Constr, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { settlementDatum, type ThreadNftRole, type VestingDatumData, VestingDatumSchema } from './launch-schemas.js';
import { type LaunchScopedDatum, selectLaunchUtxo } from './launch-utxo-lookup.js';
import { VESTING_REDEEMER } from './redeemer-indices.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Cardano's real ledger has no explicit-zero multi-asset entries — a
 *  computed-to-zero token quantity must be dropped from the assets map
 *  entirely, not passed through as 0 (same convention as
 *  vesting-start-submitter.ts's pruneZero). */
function pruneZero(assets: Assets): Assets {
  const out: Assets = {};
  for (const [unit, qty] of Object.entries(assets)) {
    if ((qty as bigint) !== 0n) out[unit] = qty as bigint;
  }
  return out;
}

function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

export interface VestingClaimsConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  vestingScriptCbor: string;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. Every state UTXO is authenticated against it — reading the
   * policy off the datum being checked would authenticate that datum against
   * itself. See launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export class VestingClaimsSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private vestingValidator: SpendingValidator;
  private vestingAddress: string;

  constructor(private config: VestingClaimsConfig) {
    this.vestingValidator = {
      type: 'PlutusV3',
      script: config.vestingScriptCbor,
    };
    this.vestingAddress = validatorToAddress(config.network, this.vestingValidator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  private async findUtxo<T extends LaunchScopedDatum>(
    lucid: LucidEvolution,
    address: string,
    role: ThreadNftRole,
    schema: unknown,
  ): Promise<{ utxo: UTxO; datum: T }> {
    const utxos = await lucid.utxosAt(address);
    return selectLaunchUtxo<T>(utxos, address, this.config.launchIdHex, role, schema, this.config.threadNftPolicyId);
  }

  /** Live on-chain vesting state, read straight from the chain. */
  async readVestingDatum(): Promise<VestingDatumData> {
    const lucid = await this.lucidPromise;
    const { datum } = await this.findUtxo<VestingDatumData>(lucid, this.vestingAddress, 'vesting', VestingDatumSchema);
    return datum;
  }

  /**
   * @param claimAmount  Token quantity to claim — caller must supply a
   *   value that satisfies the contract's own vested_to_date rule: nothing
   *   before vest_start_timestamp + vest_days, the whole token_allocation
   *   from then on.
   * @param currentTimestampMs  MILLISECONDS — see file header. Must fall
   *   inside the transaction's validity range, which this builder sets.
   */
  private async claimVestedCore(
    lucid: LucidEvolution,
    creatorAddress: string,
    claimAmount: bigint,
    currentTimestampMs: number,
  ): Promise<TxSignBuilder> {
    const { utxo: vestingUtxo, datum: vestingDatum } = await this.findUtxo<VestingDatumData>(
      lucid,
      this.vestingAddress,
      'vesting',
      VestingDatumSchema,
    );

    if (vestingDatum.vesting_state !== 'Vesting') {
      throw new Error(`Vesting is not in the Vesting state (state: ${vestingDatum.vesting_state}).`);
    }

    const newTotalClaimed = vestingDatum.claimed_tokens + claimAmount;
    const nextState = newTotalClaimed === vestingDatum.token_allocation ? 'FullyClaimed' : vestingDatum.vesting_state;
    const newVestingDatum: VestingDatumData = {
      ...vestingDatum,
      claimed_tokens: newTotalClaimed,
      vesting_state: nextState,
    };

    const tokenUnit = vestingDatum.token_policy_id + vestingDatum.token_asset_name;
    const newVestingAssets = pruneZero({
      ...vestingUtxo.assets,
      [tokenUnit]: (vestingUtxo.assets[tokenUnit] ?? 0n) - claimAmount,
    });

    // VestingRedeemer: ClaimVested is variant 1 of 8 (ClaimCommunityAllocation/ClaimCancelledAllocation added since this count was first written).
    const claimVestedRedeemer = new Constr(VESTING_REDEEMER.ClaimVested, [claimAmount, BigInt(currentTimestampMs)]);

    // The validator caps the range at max_validity_range_width (600,000ms).
    // A 240s buffer each way leaves room for build/sign/submit latency while
    // staying well inside that cap — the same window the curve's submitter
    // uses for its own chain-time-bound redeemers.
    const validFrom = currentTimestampMs - 240_000;
    const validTo = currentTimestampMs + 240_000;

    return lucid
      .newTx()
      .validFrom(validFrom)
      .validTo(validTo)
      .collectFrom([vestingUtxo], Data.to(claimVestedRedeemer))
      .attach.SpendingValidator(this.vestingValidator)
      .pay.ToContract(
        this.vestingAddress,
        {
          kind: 'inline',
          value: Data.to<VestingDatumData>(newVestingDatum, VestingDatumSchema),
        },
        newVestingAssets,
      )
      .pay.ToAddressWithData(
        creatorAddress,
        { kind: 'inline', value: settlementDatum(vestingUtxo) },
        { [tokenUnit]: claimAmount },
      )
      .addSigner(creatorAddress)
      .complete();
  }

  /** CLI-driven verification path — see file header. */
  async claimVested(
    creatorPrivateKeyExtendedHex: string,
    creatorAddress: string,
    claimAmount: bigint,
    currentTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(creatorPrivateKeyExtendedHex);
    const creatorUtxos = await lucid.utxosAt(creatorAddress);
    lucid.selectWallet.fromAddress(creatorAddress, creatorUtxos);

    const tx = await this.claimVestedCore(lucid, creatorAddress, claimAmount, currentTimestampMs);
    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** Real production path — see file header. */
  async claimVestedWithWallet(
    walletApi: WalletApi,
    claimAmount: bigint,
    currentTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const creatorAddress = await lucid.wallet().address();

    const tx = await this.claimVestedCore(lucid, creatorAddress, claimAmount, currentTimestampMs);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}
