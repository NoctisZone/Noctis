// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 5b
// Real Cardano transaction submitter for lp_escrow.ak's DEX-whitelist
// mechanism: ProposeDexChange (multisig-gated, starts the 72h public notice
// clock) and ExecuteDexChange (permissionless, applies the change once the
// notice period has elapsed).
// ============================================================================
// Verified directly against lp_escrow.ak's real redeemer logic (not
// assumed):
//   - ProposeDexChange requires `multisig_satisfied(signers, threshold,
//     self)` — a real M-of-N check over `self.extra_signatories`, NOT a
//     single governor-key check like most other redeemers in this
//     codebase. GRADTST3's real on-chain datum has `multisig_signers:
//     [governor_pub_key_hash]`, `multisig_threshold: 1` (a 1-of-1 multisig,
//     deploy-time choice), so signing with the governor's key alone
//     satisfies it here — that's this launch's specific config, not a
//     general rule.
//   - ProposeDexChange's `timestamp` field IS interval.contains-bound, but
//     the redeemer itself is NOT permissionless (multisig-gated) and is
//     therefore NOT subject to the validity_range_is_narrow() fix — only
//     ExecuteDexChange got that fix (verified directly in the file: the
//     helper call appears in ExecuteDexChange's and{} block, not
//     ProposeDexChange's). So the multisig may legitimately submit this
//     with a WIDE validity range and a BACKDATED `timestamp` claim — same
//     trusted-signer precedent already approved for ActivateCurve/
//     ExpireCurve backdating in this milestone's plan.
//   - ExecuteDexChange's `current_timestamp` must be genuinely
//     interval.contains-bound AND validity-range-narrow — it's
//     permissionless, so it must be called honestly with a real, narrow,
//     current validity range. It succeeds once `current_timestamp >=
//     pending.proposed_at + dex_change_notice_period` (259_200_000ms =
//     72h) — satisfiable immediately here because proposeDexChange() below
//     deliberately backdates `timestamp` by more than 72h.
//   - Neither redeemer has a value-movement check (own_continuing_datum
//     only verifies the DATUM matches, not the value) — both pay back the
//     exact same assets the input already held.
// ============================================================================

import type { LucidEvolution, Network as LucidNetwork, SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import { Blockfrost, CML, Constr, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { selectLaunchUtxo } from './launch-utxo-lookup.js';
import { LP_ESCROW_REDEEMER } from './redeemer-indices.js';
import { type LpEscrowDatumData, LpEscrowDatumSchema } from './tier-a-schemas.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Same conversion tier-a-curve-submitter.ts's activateCurve() already
 *  proved on real Preprod — reused verbatim rather than re-derived. */
function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

export type DexAction = 'ProposeAdd' | 'ProposeRemove';

export interface TierADexChangeConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  lpEscrowScriptCbor: string;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. Every state UTXO is authenticated against it — reading the
   * policy off the datum being checked would authenticate that datum against
   * itself. See launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export class TierADexChangeSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private lpEscrowValidator: SpendingValidator;
  private lpEscrowAddress: string;

  constructor(private config: TierADexChangeConfig) {
    this.lpEscrowValidator = {
      type: 'PlutusV3',
      script: config.lpEscrowScriptCbor,
    };
    this.lpEscrowAddress = validatorToAddress(config.network, this.lpEscrowValidator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  private async findLpEscrowUtxo(lucid: LucidEvolution): Promise<{ utxo: UTxO; datum: LpEscrowDatumData }> {
    const utxos = await lucid.utxosAt(this.lpEscrowAddress);
    const found = selectLaunchUtxo<LpEscrowDatumData>(
      utxos,
      this.lpEscrowAddress,
      this.config.launchIdHex,
      'lpEscrow',
      LpEscrowDatumSchema as never,
      this.config.threadNftPolicyId,
    );
    return found;
  }

  /**
   * @param targetDexScriptHashHex  The target DEX's payment credential
   *   script hash (hex) — e.g. Minswap V2's real poolScriptHash.
   * @param action  'ProposeAdd' | 'ProposeRemove'.
   * @param proposedAtMs  POSIX MILLISECONDS to claim as `timestamp` — see
   *   file header for why backdating this is legitimate here.
   */
  async proposeDexChange(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    targetDexScriptHashHex: string,
    action: DexAction,
    proposedAtMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const { utxo: lpUtxo, datum: lpDatum } = await this.findLpEscrowUtxo(lucid);

    if (lpDatum.pending_dex_change !== null) {
      throw new Error('lp_escrow already has a pending DEX change — resolve it (execute or cancel) first.');
    }

    // Raw Constr, not CredentialSchema's object-union convenience form —
    // this field is Data.Any() in the schema (pending_dex_change), so it's
    // built by hand matching Aiken's real Credential encoding directly:
    // VerificationKeyCredential=0, ScriptCredential=1 (verified against
    // Lucid Evolution's own CredentialSchema definition, which uses the
    // identical index order).
    const dexCredentialData = new Constr(1, [targetDexScriptHashHex]);
    const actionIndex = action === 'ProposeAdd' ? 0 : 1;
    const pendingDexChangeData = new Constr(0, [dexCredentialData, new Constr(actionIndex, []), BigInt(proposedAtMs)]);

    const newLpDatum: LpEscrowDatumData = {
      ...lpDatum,
      pending_dex_change: pendingDexChangeData as never,
    };

    // LpEscrowRedeemer: ProposeDexChange is variant 1 of 9 (see file header
    // for the full declaration-order list this indexes against).
    const proposeRedeemer = new Constr(LP_ESCROW_REDEEMER.ProposeDexChange, [
      dexCredentialData,
      new Constr(actionIndex, []),
      BigInt(proposedAtMs),
    ]);

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    // ProposeDexChange's own `timestamp` is interval.contains-bound (even
    // though the redeemer isn't permissionless) — the validity range must
    // genuinely contain proposedAtMs. Build a wide range spanning from
    // well before proposedAtMs to well after real "now", since a multisig
    // signer legitimately controls this claim (see file header).
    const nowMs = Date.now();
    const validFrom = Math.min(proposedAtMs - 60_000, nowMs - 600_000);
    const validTo = nowMs + 600_000;

    const tx = await lucid
      .newTx()
      .collectFrom([lpUtxo], Data.to(proposeRedeemer))
      .attach.SpendingValidator(this.lpEscrowValidator)
      .pay.ToContract(
        this.lpEscrowAddress,
        {
          kind: 'inline',
          value: Data.to<LpEscrowDatumData>(newLpDatum, LpEscrowDatumSchema),
        },
        lpUtxo.assets,
      )
      .validFrom(validFrom)
      .validTo(validTo)
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /**
   * @param currentTimestampMs  POSIX MILLISECONDS — must be a real, honest
   *   "now" claim. Permissionless + validity-width-bound, so the validity range
   *   built here is deliberately narrow and centered on real wall-clock
   *   time, not backdated/widened.
   */
  async executeDexChange(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    currentTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const { utxo: lpUtxo, datum: lpDatum } = await this.findLpEscrowUtxo(lucid);

    if (lpDatum.pending_dex_change === null) {
      throw new Error('lp_escrow has no pending DEX change to execute.');
    }
    const pending = lpDatum.pending_dex_change as unknown as Constr<Data>;
    const pendingCredential = pending.fields[0] as Constr<Data>;
    const pendingActionIndex = (pending.fields[1] as Constr<Data>).index;
    const _pendingProposedAt = pending.fields[2] as bigint;

    const newWhitelist =
      pendingActionIndex === 0
        ? [...lpDatum.dex_whitelist, this.credentialFromConstr(pendingCredential)]
        : lpDatum.dex_whitelist.filter(
            (c) => JSON.stringify(c) !== JSON.stringify(this.credentialFromConstr(pendingCredential)),
          );

    const newLpDatum: LpEscrowDatumData = {
      ...lpDatum,
      dex_whitelist: newWhitelist,
      pending_dex_change: null,
    };

    // LpEscrowRedeemer: ExecuteDexChange is variant 2 of 9.
    const executeRedeemer = new Constr(LP_ESCROW_REDEEMER.ExecuteDexChange, [BigInt(currentTimestampMs)]);

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    // Real, narrow (<=600,000ms), honest-"now" validity range.
    const validFrom = currentTimestampMs - 60_000;
    const validTo = currentTimestampMs + 60_000;

    const tx = await lucid
      .newTx()
      .collectFrom([lpUtxo], Data.to(executeRedeemer))
      .attach.SpendingValidator(this.lpEscrowValidator)
      .pay.ToContract(
        this.lpEscrowAddress,
        {
          kind: 'inline',
          value: Data.to<LpEscrowDatumData>(newLpDatum, LpEscrowDatumSchema),
        },
        lpUtxo.assets,
      )
      .validFrom(validFrom)
      .validTo(validTo)
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  private credentialFromConstr(c: Constr<Data>): { PubKeyCredential: [string] } | { ScriptCredential: [string] } {
    return c.index === 0
      ? { PubKeyCredential: [c.fields[0] as string] }
      : { ScriptCredential: [c.fields[0] as string] };
  }
}
