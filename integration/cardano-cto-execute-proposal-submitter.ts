// ============================================================================
// Noctis Zone — Real Cardano transaction submitter for
// contracts/cardano/validators/cto_governance.ak's ExecuteProposal
// ============================================================================
// Applies a passed, anchored proposal's real consequences (cto_state /
// community_wallet_hash) once the 24h challenge window has elapsed
// unvoided. Permissionless by design — see ExecuteProposal's own doc
// comment in cto_governance.ak: requiring a signature here would reopen the
// exact censorship risk the open-relay AnchorVoteResult design was built to
// avoid, since community_wallet_hash doesn't exist yet for a launch's first
// SilenceLockTrigger.
//
// Data encoding reuses cardano-cto-anchor-submitter.ts's exported schemas
// (CtoGovernanceDatumSchema, ProposalAnchorSchema, ProposalTypeSchema) and
// its findCtoGovernanceUtxo/requireCtoDatum helpers — same on-chain shape,
// one source of truth rather than four independently-drifting copies.
//
// What IS real here: Data encoding, UTXO lookup, transaction construction,
// and the new-datum state-transition logic (mirrored line-for-line from the
// validator's own and{} block, since it checks new_datum == expected_datum
// exactly) are all built against Lucid Evolution's real, installed API.
//
// What is NOT tested: an actual end-to-end submission against a live
// Cardano node — needs a real anchored, unexpired proposal on a deployed
// cto_governance UTXO, neither of which exist in this dev environment.
// Same honest boundary as every other submitter in this codebase.
// ============================================================================

import type { LucidEvolution, Network as LucidNetwork, SpendingValidator } from '@lucid-evolution/lucid';
import { Blockfrost, Constr, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import {
  type CtoGovernanceDatumData,
  CtoGovernanceDatumSchema,
  findCtoGovernanceUtxo,
  type ProposalAnchorData,
  requireCtoDatum,
  toHex,
} from './cardano-cto-anchor-submitter.js';
import { CTO_GOVERNANCE_REDEEMER } from './redeemer-indices.js';

/** Same fixed figures as cto_governance.ak's own constants — used here only
 *  for the fail-fast pre-check below, not re-derived on-chain (the
 *  validator enforces the real bound regardless of what this check does). */
const CHALLENGE_WINDOW_MS = 86_400_000n;
const EXECUTION_WINDOW_MS = 2_592_000_000n;

/**
 * ExecuteProposal, by name rather than by number.
 *
 * The index comes from `redeemer-indices.ts`, which a test checks against the
 * compiled blueprint — so adding a variant ahead of this one fails there
 * instead of silently sending a different redeemer. Built as a raw Constr
 * because Data.Object always encodes index 0; see
 * cardano-dv-allocation-anchor-submitter.ts's own header for that limitation.
 */
function executeProposalRedeemer(currentTimestamp: bigint) {
  return new Constr(CTO_GOVERNANCE_REDEEMER.ExecuteProposal, [currentTimestamp]);
}

export interface CardanoCtoExecuteProposalSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** cto_governance.ak's compiled PlutusV3 script CBOR — plutus.json's `validators[].compiledCode` for `cto_governance.cto_governance.spend`. */
  compiledScriptCbor: string;
  /** Pays the fee/collateral only — ExecuteProposal has no validator-checked signer. */
  callerPrivateKey: string;
  launchId: Uint8Array;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. The governance UTXO is authenticated against it — the datum
   * cannot be allowed to nominate its own authenticator. See
   * launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export class CardanoCtoExecuteProposalSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: CardanoCtoExecuteProposalSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network).then(
      (lucid) => {
        lucid.selectWallet.fromPrivateKey(config.callerPrivateKey);
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
   * Executes the launch's currently-active, passed proposal.
   * `currentTimestampMs` must fall within
   * [anchor_timestamp + 24h, anchor_timestamp + 30d] — enforced for real
   * on-chain; checked here too so a caller gets a clear error before
   * spending a transaction fee on a doomed submission.
   */
  async executeProposal(currentTimestampMs: bigint): Promise<{ txHash: string }> {
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
      throw new Error("No active_proposal on this launch's cto_governance UTXO — nothing to execute.");
    }
    if (proposal.outcome !== 'Passed') {
      throw new Error(`active_proposal.outcome is '${proposal.outcome}', not 'Passed' — cannot execute.`);
    }
    if (proposal.execution_status !== 'PendingExecution') {
      throw new Error(
        `active_proposal.execution_status is '${proposal.execution_status}', not 'PendingExecution' — cannot execute.`,
      );
    }
    const earliestMs = proposal.anchor_timestamp + CHALLENGE_WINDOW_MS;
    const latestMs = proposal.anchor_timestamp + EXECUTION_WINDOW_MS;
    if (currentTimestampMs < earliestMs || currentTimestampMs > latestMs) {
      throw new Error(
        `currentTimestampMs (${currentTimestampMs}) is outside the real executable window [${earliestMs}, ${latestMs}] — the challenge window hasn't elapsed yet, or the 30-day execution window has passed.`,
      );
    }

    const executedProposal: ProposalAnchorData = { ...proposal, execution_status: 'Executed' };

    // Mirrors ExecuteProposal's own state-transition logic line-for-line —
    // the validator checks new_datum == expected_datum exactly.
    const newCtoState =
      proposal.proposal_type === 'SilenceLockTrigger'
        ? 'CTOTriggered'
        : proposal.proposal_type === 'DissolveCTOProposal'
          ? 'CTODissolved'
          : currentDatum.cto_state;
    const newCommunityWalletHash =
      proposal.proposal_type === 'SilenceLockTrigger'
        ? proposal.allocation_recipient_hash
        : proposal.proposal_type === 'DissolveCTOProposal'
          ? ''
          : currentDatum.community_wallet_hash;

    const newDatum: CtoGovernanceDatumData = {
      ...currentDatum,
      cto_state: newCtoState,
      community_wallet_hash: newCommunityWalletHash,
      active_proposal: executedProposal,
      last_executed_proposal: executedProposal,
      // The ballot ran its course: the cooldown before the next starts here.
      last_ballot_end_timestamp: proposal.end_timestamp,
    };

    // No value moves — the continuing output keeps the anchor UTXO's own
    // assets (including any still-pending relayer bond) untouched.
    const validFrom = Number(currentTimestampMs) - 60_000;
    const validTo = Number(currentTimestampMs) + 60_000;

    const tx = await lucid
      .newTx()
      .collectFrom([anchorUtxo], Data.to(executeProposalRedeemer(currentTimestampMs)))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<CtoGovernanceDatumData>(newDatum, CtoGovernanceDatumSchema),
        },
        anchorUtxo.assets,
      )
      .validFrom(validFrom)
      .validTo(validTo)
      .complete();

    const signed = await tx.sign.withPrivateKey(this.config.callerPrivateKey).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { toHex };
