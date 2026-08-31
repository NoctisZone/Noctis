// ============================================================================
// Noctis Zone — Real Cardano transaction submitter for
// contracts/cardano/validators/cto_governance.ak's VoidPendingProposal
// ============================================================================
// Governor-only. Voids a pending anchor found to be fraudulent within the
// 24h challenge window and slashes the relayer's bond, split 60/40
// treasury/ops — same ratio as every other forfeited bond in this codebase
// (nhop_challenge.ak, cto_sybil_challenge.ak).
//
// Data encoding reuses cardano-cto-anchor-submitter.ts's exported schemas
// and findCtoGovernanceUtxo/requireCtoDatum helpers — one source of truth
// for the on-chain datum shape across all four cto_governance submitters.
//
// What IS real here: Data encoding, UTXO lookup, transaction construction,
// bps arithmetic (verified to match cto_governance.ak's own
// treasury_bps=60/bps_denominator=100 floor-division exactly), and the
// new-datum state-transition logic are all built against Lucid Evolution's
// real, installed API.
//
// What is NOT tested: an actual end-to-end submission against a live
// Cardano node. Same honest boundary as every other submitter here.
// ============================================================================

import type { LucidEvolution, Network as LucidNetwork, SpendingValidator } from '@lucid-evolution/lucid';
import { Blockfrost, Constr, credentialToAddress, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import {
  type CtoGovernanceDatumData,
  CtoGovernanceDatumSchema,
  findCtoGovernanceUtxo,
  type ProposalAnchorData,
  requireCtoDatum,
  toHex,
} from './cardano-cto-anchor-submitter.js';
import { CTO_GOVERNANCE_REDEEMER } from './redeemer-indices.js';
import { settlementDatum } from './tier-a-schemas.js';

/** Same fixed figure as cto_governance.ak's own constant. */
const CHALLENGE_WINDOW_MS = 86_400_000n;

/**
 * VoidPendingProposal, by name — see `redeemer-indices.ts`, whose table a test
 * holds against the compiled blueprint. Raw Constr, because Data.Object always
 * encodes index 0.
 */
function voidPendingProposalRedeemer(currentTimestamp: bigint) {
  return new Constr(CTO_GOVERNANCE_REDEEMER.VoidPendingProposal, [currentTimestamp]);
}

// Same bare-enterprise-address construction cto_governance.ak's own
// paid_to() checks against (from_verification_key(key_hash), no stake
// credential) — matches the real on-chain check exactly, same helper
// pattern already used in cardano-cto-sybil-challenge-submitter.ts.
function pubKeyHashToAddress(network: LucidNetwork, keyHash: string): string {
  return credentialToAddress(network, { type: 'Key', hash: keyHash });
}

export interface CardanoCtoVoidProposalSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** cto_governance.ak's compiled PlutusV3 script CBOR. */
  compiledScriptCbor: string;
  /** Governor's private key — this redeemer is governor-signed for real, not just fee-payer. */
  governorPrivateKey: string;
  launchId: Uint8Array;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. The governance UTXO is authenticated against it — the datum
   * cannot be allowed to nominate its own authenticator. See
   * launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export class CardanoCtoVoidProposalSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: CardanoCtoVoidProposalSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network).then(
      (lucid) => {
        lucid.selectWallet.fromPrivateKey(config.governorPrivateKey);
        // Nothing awaits this until a method runs, so a caller that constructs the
        // submitter and then fails before calling one leaves the rejection with no
        // handler — and Node prints it to stderr after the real answer has already
        // been written to stdout. Attaching a no-op handler marks it handled
        // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
        // with the same error, which is the whole point (verified, not assumed).
        this.lucidPromise.catch(() => {});
        return lucid;
      },
    );
  }

  /**
   * Voids the launch's currently-active proposal and slashes the relayer's
   * bond. `currentTimestampMs` must be BEFORE anchor_timestamp + 24h —
   * enforced for real on-chain; checked here too so a caller gets a clear
   * error before spending a fee on a doomed submission (the window has
   * already elapsed — use ExecuteProposal or wait for ExpireProposal
   * instead).
   */
  async voidPendingProposal(currentTimestampMs: bigint, governorAddress: string): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const anchorUtxo = await findCtoGovernanceUtxo(
      lucid,
      this.scriptAddress,
      this.config.launchId,
      this.config.threadNftPolicyId,
    );
    const currentDatum = Data.from<CtoGovernanceDatumData>(requireCtoDatum(anchorUtxo), CtoGovernanceDatumSchema);

    const proposal = currentDatum.active_proposal;
    if (!proposal) {
      throw new Error("No active_proposal on this launch's cto_governance UTXO — nothing to void.");
    }
    if (proposal.execution_status !== 'PendingExecution') {
      throw new Error(
        `active_proposal.execution_status is '${proposal.execution_status}', not 'PendingExecution' — cannot void.`,
      );
    }
    const windowEndMs = proposal.anchor_timestamp + CHALLENGE_WINDOW_MS;
    if (currentTimestampMs >= windowEndMs) {
      throw new Error(
        `currentTimestampMs (${currentTimestampMs}) is at or past the 24h challenge window's end (${windowEndMs}) — VoidPendingProposal is no longer callable; use ExecuteProposal or ExpireProposal instead.`,
      );
    }
    if (currentDatum.pending_relayer_bond <= 0n) {
      throw new Error('pending_relayer_bond is not positive — nothing to slash.');
    }

    // Exact same floor-division split as cto_governance.ak's own
    // treasury_share/ops_share computation — must match precisely, since
    // paid_to() requires each output's real lovelace to be >= its share.
    const bond = currentDatum.pending_relayer_bond;

    const voidedProposal: ProposalAnchorData = { ...proposal, execution_status: 'Expired' };
    const newDatum: CtoGovernanceDatumData = {
      ...currentDatum,
      active_proposal: voidedProposal,
      pending_relayer_bond: 0n,
      pending_relayer_key_hash: '',
    };

    const continuingAssets = {
      ...anchorUtxo.assets,
      lovelace: (anchorUtxo.assets.lovelace ?? 0n) - bond,
    };

    // The whole bond, to the one address the governance datum names.
    const payoutAddress = pubKeyHashToAddress(this.config.network, currentDatum.payout_pub_key_hash);

    const validFrom = Number(currentTimestampMs) - 60_000;
    const validTo = Number(currentTimestampMs) + 60_000;

    const tx = await lucid
      .newTx()
      .collectFrom([anchorUtxo], Data.to(voidPendingProposalRedeemer(currentTimestampMs)))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<CtoGovernanceDatumData>(newDatum, CtoGovernanceDatumSchema),
        },
        continuingAssets,
      )
      .pay.ToAddressWithData(payoutAddress, { kind: 'inline', value: settlementDatum(anchorUtxo) }, { lovelace: bond })
      .addSigner(governorAddress)
      .validFrom(validFrom)
      .validTo(validTo)
      .complete();

    const signed = await tx.sign.withPrivateKey(this.config.governorPrivateKey).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { toHex };
