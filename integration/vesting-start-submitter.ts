// ============================================================================
// Noctis Zone — starting a creator's vesting schedule
// Real Cardano transaction submitter for vesting.ak's StartVesting.
// ============================================================================
// Vesting is one validator for every Cardano launch, so starting a schedule
// is the same transaction whichever curve the launch graduated from. It is
// independent of graduation itself: it checks the governor's signature, its
// own `vesting_state == NotStarted` and that its start time is the chain's
// now, never curve or escrow state, so it can run any time after mint and be
// retried on its own. A Cardano
// Launch's graduation, which runs it as its second transaction, lives in
// tier-b-graduation-submitter.ts.
//
// StartVesting requires the governor's signature, made with the same
// CML.PrivateKey.from_extended_bytes() + selectWallet.fromAddress() pattern
// the curve's activateCurve() (tier-b-curve-submitter.ts) established and
// proved on real Preprod.
//
// The start time is MILLISECONDS, matching Cardano's own validity range:
// `start_timestamp` is bound through interval.contains(self.validity_range,
// ...), so this builder sets a range and the value must fall inside it, and
// it is stored as `vest_start_timestamp`, which ClaimVested compares in ms.
// ============================================================================

import type { LucidEvolution, Network as LucidNetwork, SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import { CML, Constr, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { cardanoProvider } from './cardano-provider.js';
import { type ThreadNftRole, type VestingDatumData, VestingDatumSchema } from './launch-schemas.js';
import { selectLaunchUtxo } from './launch-utxo-lookup.js';
import { VESTING_REDEEMER } from './redeemer-indices.js';

/** Same conversion tier-b-curve-submitter.ts's activateCurve() uses, proved
 *  on real Preprod — reused verbatim rather than re-derived. */
function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = new Uint8Array(Buffer.from(extendedHex, 'hex'));
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

export interface VestingStartConfig {
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

/**
 * The creator's signing identity, needed only when the launch opted into
 * staking: seeding the pool spends its genesis UTXO via staking_pool.ak's
 * `TopUpPool`, the one value-increasing path that validator has, and that
 * redeemer requires the creator's signature. Graduation itself stays
 * permissionless — this is the pool contract's own rule, not the curve's.
 */
export interface CreatorSigner {
  address: string;
  privateKeyExtendedHex: string;
}

export class VestingStartSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private vestingValidator: SpendingValidator;
  private vestingAddress: string;

  constructor(private config: VestingStartConfig) {
    this.vestingValidator = { type: 'PlutusV3', script: config.vestingScriptCbor };
    this.vestingAddress = validatorToAddress(config.network, this.vestingValidator);
    this.lucidPromise = Lucid(cardanoProvider(config), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  /**
   * This launch's own UTXO in one role, authenticated by its thread NFT.
   *
   * vesting.ak is unparameterized, so every launch's vesting UTXO sits at one
   * shared address. Matching on the datum's `launch_id` alone matched a claim
   * anyone could author, and taking the first match meant a second UTXO
   * answering to the same launch was silently passed over. See
   * launch-utxo-lookup.ts.
   */
  private async findUtxo<T extends { launch_id: string; thread_nft_policy: string }>(
    lucid: LucidEvolution,
    address: string,
    role: ThreadNftRole,
    schema: unknown,
  ): Promise<{ utxo: UTxO; datum: T }> {
    const utxos = await lucid.utxosAt(address);
    return selectLaunchUtxo<T>(utxos, address, this.config.launchIdHex, role, schema, this.config.threadNftPolicyId);
  }

  /**
   * StartVesting (vesting.ak). Independent of graduation (see file header),
   * so this can be called any time after mint, and retried on its own if it
   * fails.
   *
   * @param vestStartTimestampMs  MILLISECONDS.
   */
  async startVesting(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    vestStartTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;

    const { utxo: vestingUtxo, datum: vestingDatum } = await this.findUtxo<VestingDatumData>(
      lucid,
      this.vestingAddress,
      'vesting',
      VestingDatumSchema,
    );

    if (vestingDatum.vesting_state !== 'NotStarted') {
      throw new Error(`Vesting is not NotStarted (state: ${vestingDatum.vesting_state}) — StartVesting already ran.`);
    }

    const newVestingDatum: VestingDatumData = {
      ...vestingDatum,
      vesting_state: 'Vesting',
      vest_start_timestamp: BigInt(vestStartTimestampMs),
    };

    const startVestingRedeemer = new Constr(VESTING_REDEEMER.StartVesting, [BigInt(vestStartTimestampMs)]);

    const vestValidFrom = vestStartTimestampMs - 240_000;
    const vestValidTo = vestStartTimestampMs + 240_000;

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const tx = await lucid
      .newTx()
      .validFrom(vestValidFrom)
      .validTo(vestValidTo)
      .collectFrom([vestingUtxo], Data.to(startVestingRedeemer))
      .attach.SpendingValidator(this.vestingValidator)
      .pay.ToContract(
        this.vestingAddress,
        {
          kind: 'inline',
          value: Data.to<VestingDatumData>(newVestingDatum, VestingDatumSchema),
        },
        vestingUtxo.assets,
      )
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();

    return { txHash };
  }
}
