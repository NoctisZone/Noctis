// ============================================================================
// Noctis Zone — Real Cardano transaction submitter for
// contracts/cardano/validators/cto_governance.ak's AnchorVoteResult
// ============================================================================
// The Midnight-to-Cardano half of CTO governance's relay (item #15): once a
// proposal finalizes on Midnight's cto_governance.compact, its result needs
// to be anchored on cto_governance.ak so Cardano-side TriggerCTO/DissolveCTO
// checks (the cto_vote_verified() reference-input pattern, already built
// this session in bonding_curve.ak/bonding_curve_tier_b.ak/lp_escrow.ak/
// vesting.ak) have real evidence to check against.
//
// Same "open relay" design already implemented in cto_governance.ak —
// confirmed directly from its AnchorVoteResult and{} block (read 2026-07-19,
// this session): no signer/extra_signatories check exists anywhere in that
// redeemer. relayer_credential_hash is a self-attested audit field, not an
// enforced authorization — this submitter still needs a real wallet to pay
// the transaction fee/collateral, just not as a validator-required signer.
//
// Datum/redeemer schemas below are hand-mirrored from a FRESHLY REGENERATED
// contracts/cardano/plutus.json (`aiken build`, 2026-07-19 — the checked-in
// copy was stale relative to this session's own datum changes
// before this), field names/order/constructor indices read directly from
// the blueprint's real JSON, not from cto_governance.ak's source comments —
// same discipline cardano-anchor-submitter.ts already established (this
// codebase has drifted on exactly this point before).
//
// What IS real here: the Data encoding, UTXO lookup, transaction
// construction, and the new-datum state-transition logic (mirrored line-
// for-line from the validator's own and{} block, since the validator checks
// new_datum == expected_datum exactly) are all built against Lucid
// Evolution's real, installed API.
//
// What is NOT tested: an actual end-to-end submission against a live
// Cardano node — needs a funded relayer key and a deployed cto_governance
// anchor UTXO, neither of which exist in this dev environment. Same honest
// boundary as cardano-anchor-submitter.ts.
// ============================================================================

import type { LucidEvolution, Network as LucidNetwork, SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import { Blockfrost, CredentialSchema, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { deriveAnchorReferenceHex, type TargetDexCredential } from './cto-anchor-reference.js';
import { selectLaunchUtxo } from './launch-utxo-lookup.js';
import { LpEscrowDatumSchema } from './tier-a-schemas.js';

// ============================================================================
// DATA SCHEMAS — mirror the fresh contracts/cardano/plutus.json exactly
// ============================================================================

export const CtoAnchorStateSchema = Data.Enum([
  Data.Literal('PreCTO'),
  Data.Literal('CTOTriggered'),
  Data.Literal('CTODissolved'),
]);

export const ProposalTypeSchema = Data.Enum([
  Data.Literal('SilenceLockTrigger'),
  Data.Literal('FundAllocation'),
  Data.Literal('DexMigration'),
  Data.Literal('WhitelistUpdate'),
  Data.Literal('DissolveCTOProposal'),
]);
export type ProposalTypeData = Data.Static<typeof ProposalTypeSchema>;

const ProposalOutcomeSchema = Data.Enum([Data.Literal('Passed'), Data.Literal('Failed')]);
export type ProposalOutcomeData = Data.Static<typeof ProposalOutcomeSchema>;

export const ExecutionStatusSchema = Data.Enum([
  Data.Literal('PendingExecution'),
  Data.Literal('Executed'),
  Data.Literal('Expired'),
]);
export type ExecutionStatusData = Data.Static<typeof ExecutionStatusSchema>;

/** target_dex_credential/active_proposal/last_executed_proposal are all real Option<T> fields on-chain — Data.Nullable is Lucid Evolution's own real Option encoding, already used elsewhere in this codebase (tier-a-schemas.ts's pending_dex_change). */
export const ProposalAnchorShape = Data.Object({
  proposal_type: ProposalTypeSchema,
  description_hash: Data.Bytes(),
  proof_bundle_hash: Data.Bytes(),
  yes_votes: Data.Integer(),
  no_votes: Data.Integer(),
  voter_count: Data.Integer(),
  creator_yes_votes: Data.Integer(),
  creator_no_votes: Data.Integer(),
  outcome: ProposalOutcomeSchema,
  start_timestamp: Data.Integer(),
  end_timestamp: Data.Integer(),
  anchor_timestamp: Data.Integer(),
  execution_status: ExecutionStatusSchema,
  target_dex_credential: Data.Nullable(CredentialSchema),
  allocation_amount: Data.Integer(),
  allocation_recipient_hash: Data.Bytes(),
  relayer_credential_hash: Data.Bytes(),
});
export type ProposalAnchorData = Data.Static<typeof ProposalAnchorShape>;
export const ProposalAnchorSchema = ProposalAnchorShape as unknown as ProposalAnchorData;

/**
 * This mirrors the same on-chain datum as tier-a-schemas' own
 * CtoGovernanceDatumShape, and exists separately only because that one models
 * active_proposal as Data.Any() -- genesis writes null and never needs the
 * nested shape, whereas this submitter has to build a real ProposalAnchor.
 * Both are checked against the compiled blueprint by the schema drift guard;
 * a second definition that nothing verifies is how this one came to be missing
 * min_voter_count and thread_nft_policy while sitting two positions out of
 * order, which no datum it built could have decoded.
 *
 * Fix (2026-07-19, full-suite security audit): CtoGovernanceDatum
 * gained 4 new fields for the bonded-challenge-window fix — see
 * cto_governance.ak's own doc comment on `pending_relayer_bond` for the
 * full mechanism. Re-verified against the freshly-regenerated plutus.json.
 */
export const CtoGovernanceDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  cto_state: CtoAnchorStateSchema,
  community_wallet_hash: Data.Bytes(),
  governor_credential_hash: Data.Bytes(),
  total_supply: Data.Integer(),
  quorum_bps: Data.Integer(),
  creator_vote_cap_bps: Data.Integer(),
  min_voter_count: Data.Integer(),
  active_proposal: Data.Nullable(ProposalAnchorShape),
  proposal_count: Data.Integer(),
  last_executed_proposal: Data.Nullable(ProposalAnchorShape),
  pending_relayer_bond: Data.Integer(),
  pending_relayer_key_hash: Data.Bytes(),
  payout_pub_key_hash: Data.Bytes(),
  thread_nft_policy: Data.Bytes(),
  // The deployed ballot width an anchored result's window must match exactly.
  // Carried through untouched by the spread below — no redeemer writes it.
  ballot_duration: Data.Integer(),
  // When this launch's last ballot closed, 0 if none ever has. Unlike
  // ballot_duration this IS written by this redeemer — see submitVoteResult,
  // which sets it from the ballot's own end so the next anchor is held a full
  // cooldown away whatever this one's outcome was.
  last_ballot_end_timestamp: Data.Integer(),
});
export type CtoGovernanceDatumData = Data.Static<typeof CtoGovernanceDatumShape>;
export const CtoGovernanceDatumSchema = CtoGovernanceDatumShape as unknown as CtoGovernanceDatumData;

/**
 * AnchorVoteResult — constructor index 0 of 8 real redeemer variants
 * (verified against the fresh blueprint, 2026-07-19 — this fix added
 * VoidPendingProposal/ReclaimRelayerBond, neither implemented by this
 * submitter yet). A plain Data.Object (defaults to Constr index 0) is
 * sufficient since this submitter only ever constructs this one variant —
 * same reasoning cardano-anchor-submitter.ts already established for
 * zk_anchor's AnchorCertificate.
 *
 * Fix: gained a trailing `relayer_bond` field — AnchorVoteResult now
 * requires a real ADA bond (>= 25 ADA, `min_relayer_bond` in
 * cto_governance.ak) paid into the contract's own continuing output, to
 * close the "forge a vote result for free" gap. See submitVoteResult's
 * own comment below for how the payment itself is constructed.
 */
const AnchorVoteResultRedeemerShape = Data.Object({
  proposal_type: ProposalTypeSchema,
  description_hash: Data.Bytes(),
  proposal_id: Data.Bytes(),
  yes_votes: Data.Integer(),
  no_votes: Data.Integer(),
  voter_count: Data.Integer(),
  creator_yes_votes: Data.Integer(),
  creator_no_votes: Data.Integer(),
  outcome: ProposalOutcomeSchema,
  start_timestamp: Data.Integer(),
  end_timestamp: Data.Integer(),
  anchor_timestamp: Data.Integer(),
  target_dex_credential: Data.Nullable(CredentialSchema),
  allocation_amount: Data.Integer(),
  allocation_recipient_hash: Data.Bytes(),
  relayer_credential_hash: Data.Bytes(),
  relayer_bond: Data.Integer(),
});
type AnchorVoteResultRedeemerData = Data.Static<typeof AnchorVoteResultRedeemerShape>;
const AnchorVoteResultRedeemerSchema = AnchorVoteResultRedeemerShape as unknown as AnchorVoteResultRedeemerData;

/** Same fixed figure as cto_governance.ak's own `min_relayer_bond`. */
export const MIN_RELAYER_BOND_LOVELACE = 25_000_000n;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ============================================================================
// PARAMS — one Midnight proposal's finalized result, ready to anchor
// ============================================================================

export interface VoteResultParams {
  proposalType: ProposalTypeData;
  descriptionHash: Uint8Array;
  /**
   * The Midnight ballot being relayed. It replaces the bundle reference this
   * interface used to carry: the validator DERIVES that reference now (see
   * cto-anchor-reference.ts), so supplying one was never a real choice — it
   * was an unchecked field that a forging relayer could fill with a genuine
   * reference borrowed from another launch's ballot.
   */
  proposalId: Uint8Array;
  yesVotes: bigint;
  noVotes: bigint;
  voterCount: bigint;
  creatorYesVotes: bigint;
  creatorNoVotes: bigint;
  outcome: ProposalOutcomeData;
  startTimestamp: bigint;
  endTimestamp: bigint;
  anchorTimestamp: bigint;
  // Real Lucid Evolution CredentialSchema-derived shape (verified against
  // the installed package's own .d.ts — "PubKeyCredential", not
  // "PublicKeyCredential" or "VerificationKeyCredential" as one might guess).
  targetDexCredential: { PubKeyCredential: [string] } | { ScriptCredential: [string] } | null;
  allocationAmount: bigint;
  allocationRecipientHash: string; // hex VerificationKeyHash
  relayerCredentialHash: string; // hex VerificationKeyHash — self-attested (open relay, no signature enforced)
  /** Real ADA bond, >= MIN_RELAYER_BOND_LOVELACE, paid into the contract's own continuing output — see submitVoteResult's own comment. */
  relayerBondLovelace: bigint;
}

/**
 * Lucid's credential shape to the reference derivation's own.
 *
 * Two encodings of the same idea, and the validator hashes a one-byte kind tag
 * that distinguishes them — so collapsing both arms to one tag here would build
 * a datum the validator rejects for a target DEX that is a plain payment key.
 */
function toReferenceCredential(target: VoteResultParams['targetDexCredential']): TargetDexCredential {
  if (target === null) {
    return null;
  }
  if ('PubKeyCredential' in target) {
    return { kind: 'VerificationKey', hashHex: target.PubKeyCredential[0] };
  }
  return { kind: 'Script', hashHex: target.ScriptCredential[0] };
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface CardanoCtoAnchorSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** cto_governance.ak's compiled PlutusV3 script CBOR — plutus.json's `validators[].compiledCode` for `cto_governance.cto_governance.spend`. One fixed address shared by every launch (CLAUDE.md's Contract Architecture table). */
  compiledScriptCbor: string;
  /** Relayer's private key — pays the fee/collateral. AnchorVoteResult itself is permissionless (open relay), so this key is never required as a validator-checked signer, only as the transaction's real payer. */
  relayerPrivateKey: string;
  /**
   * lp_escrow.ak's compiled PlutusV3 script CBOR.
   *
   * Not spent, and not attached as a validator — only used to derive the
   * address the launch's LP escrow UTXO sits at, so it can be read as a
   * reference input. AnchorVoteResult learns when the launch graduated from
   * that UTXO's `lock_timestamp`, which `SealLock` writes at graduation, and
   * refuses a ballot that opened before the launch was eligible to hold one.
   */
  lpEscrowScriptCbor: string;
  launchId: Uint8Array;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. The governance UTXO is authenticated against it — the datum
   * cannot be allowed to nominate its own authenticator. See
   * launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

/** Shared with cardano-cto-execute-proposal-submitter.ts /
 *  cardano-cto-void-proposal-submitter.ts / cardano-cto-reclaim-bond-submitter.ts
 *  — all four submitters read the same cto_governance.ak UTXO shape, so the
 *  lookup-by-launch_id scan lives in one place rather than four. */
export function requireCtoDatum(utxo: UTxO): string {
  if (!utxo.datum) {
    throw new Error(
      'CTO governance UTXO has no inline datum (unexpected — findCtoGovernanceUtxo should only return UTXOs with one).',
    );
  }
  return utxo.datum;
}

export async function findCtoGovernanceUtxo(
  lucid: LucidEvolution,
  scriptAddress: string,
  launchId: Uint8Array,
  threadNftPolicyId: string,
): Promise<UTxO> {
  const utxos = await lucid.utxosAt(scriptAddress);
  const launchIdHex = toHex(launchId);
  return selectLaunchUtxo<CtoGovernanceDatumData>(
    utxos,
    scriptAddress,
    launchIdHex,
    'ctoGovernance',
    CtoGovernanceDatumSchema as never,
    threadNftPolicyId,
  ).utxo;
}

/**
 * The launch's own LP escrow UTXO, for AnchorVoteResult to read graduation
 * time from.
 *
 * Authenticated by the launch's LP escrow thread NFT, which is what
 * `selectLaunchUtxo` checks — the validator does the same on its side, and it
 * has to: a reference input is never spent, so no validator runs on it, and
 * anyone can pay a UTXO carrying a forged datum to that address.
 */
export async function findLpEscrowUtxo(
  lucid: LucidEvolution,
  lpEscrowAddress: string,
  launchId: Uint8Array,
  threadNftPolicyId: string,
): Promise<UTxO> {
  const utxos = await lucid.utxosAt(lpEscrowAddress);
  return selectLaunchUtxo<{ launch_id: string; thread_nft_policy: string }>(
    utxos,
    lpEscrowAddress,
    toHex(launchId),
    'lpEscrow',
    LpEscrowDatumSchema as never,
    threadNftPolicyId,
  ).utxo;
}

export class CardanoCtoAnchorSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;
  private lpEscrowAddress: string;

  constructor(private config: CardanoCtoAnchorSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lpEscrowAddress = validatorToAddress(config.network, {
      type: 'PlutusV3',
      script: config.lpEscrowScriptCbor,
    });
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network).then(
      (lucid) => {
        lucid.selectWallet.fromPrivateKey(config.relayerPrivateKey);
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

  private requireDatum(utxo: UTxO): string {
    return requireCtoDatum(utxo);
  }

  private async findAnchorUtxo(lucid: LucidEvolution, launchId: Uint8Array): Promise<UTxO> {
    return findCtoGovernanceUtxo(lucid, this.scriptAddress, launchId, this.config.threadNftPolicyId);
  }

  /**
   * Submits AnchorVoteResult for one finalized Midnight proposal.
   * Requires the anchor's active_proposal to currently be null (the
   * validator's own datum.active_proposal == None check) — callers must
   * ensure ClearProposal has run since any prior anchor before calling
   * this again, same as the validator itself requires.
   *
   * Fix: AnchorVoteResult no longer mutates cto_state/
   * community_wallet_hash directly — that's ExecuteProposal's job now,
   * once the 24h challenge window has elapsed unvoided (see
   * cardano-cto-execute-proposal-submitter.ts, TODO — not yet built;
   * ExecuteProposal/VoidPendingProposal/ReclaimRelayerBond have no
   * submitter in this codebase yet). This call now also requires posting
   * a real ADA bond (>= MIN_RELAYER_BOND_LOVELACE) into the contract's
   * own continuing output, closing the "forge a vote result for free" gap.
   */
  async submitVoteResult(params: VoteResultParams): Promise<{ txHash: string }> {
    if (params.relayerBondLovelace < MIN_RELAYER_BOND_LOVELACE) {
      throw new Error(
        `relayerBondLovelace (${params.relayerBondLovelace}) is below the required floor (${MIN_RELAYER_BOND_LOVELACE})`,
      );
    }

    const lucid = await this.lucidPromise;
    const anchorUtxo = await this.findAnchorUtxo(lucid, this.config.launchId);
    const currentDatum = Data.from<CtoGovernanceDatumData>(this.requireDatum(anchorUtxo), CtoGovernanceDatumSchema);

    // The validator derives this from ITS OWN datum's launch id and ballot
    // ordinal, then checks the continuing datum equals what it expects — so
    // this has to be computed, not chosen, and computed from the same two
    // fields read off the UTXO being spent rather than from config.
    const proofBundleHash = deriveAnchorReferenceHex({
      launchIdHex: currentDatum.launch_id,
      proposalCount: currentDatum.proposal_count,
      proposalIdHex: toHex(params.proposalId),
      ballot: {
        proposalType: params.proposalType,
        descriptionHashHex: toHex(params.descriptionHash),
        yesVotes: params.yesVotes,
        noVotes: params.noVotes,
        voterCount: params.voterCount,
        creatorYesVotes: params.creatorYesVotes,
        creatorNoVotes: params.creatorNoVotes,
        outcome: params.outcome,
        startTimestamp: params.startTimestamp,
        endTimestamp: params.endTimestamp,
        targetDexCredential: toReferenceCredential(params.targetDexCredential),
      },
    });

    const proposalAnchor: ProposalAnchorData = {
      proposal_type: params.proposalType,
      description_hash: toHex(params.descriptionHash),
      proof_bundle_hash: proofBundleHash,
      yes_votes: params.yesVotes,
      no_votes: params.noVotes,
      voter_count: params.voterCount,
      creator_yes_votes: params.creatorYesVotes,
      creator_no_votes: params.creatorNoVotes,
      outcome: params.outcome,
      start_timestamp: params.startTimestamp,
      end_timestamp: params.endTimestamp,
      anchor_timestamp: params.anchorTimestamp,
      execution_status: 'PendingExecution',
      target_dex_credential: params.targetDexCredential,
      allocation_amount: params.allocationAmount,
      allocation_recipient_hash: params.allocationRecipientHash,
      relayer_credential_hash: params.relayerCredentialHash,
    };

    // Mirrors AnchorVoteResult's own state-transition logic line-for-line
    // (cto_governance.ak, read 2026-07-19) — the validator checks
    // `new_datum == expected_datum` exactly, so this MUST match it exactly.
    // cto_state/community_wallet_hash are untouched here — only the
    // pending-bond fields and the proposal record change.
    const newDatum: CtoGovernanceDatumData = {
      ...currentDatum,
      active_proposal: proposalAnchor,
      proposal_count: currentDatum.proposal_count + 1n,
      pending_relayer_bond: params.relayerBondLovelace,
      pending_relayer_key_hash: params.relayerCredentialHash,
      // The ballot's end starts the cooldown before the next one may open.
      // Written for every outcome, so a failed ballot cannot be cleared and
      // immediately retried. A spread alone would carry the PREVIOUS value
      // through and the validator's equality check would refuse it.
      last_ballot_end_timestamp: params.endTimestamp,
    };

    const redeemerData: AnchorVoteResultRedeemerData = {
      proposal_type: params.proposalType,
      description_hash: toHex(params.descriptionHash),
      proposal_id: toHex(params.proposalId),
      yes_votes: params.yesVotes,
      no_votes: params.noVotes,
      voter_count: params.voterCount,
      creator_yes_votes: params.creatorYesVotes,
      creator_no_votes: params.creatorNoVotes,
      outcome: params.outcome,
      start_timestamp: params.startTimestamp,
      end_timestamp: params.endTimestamp,
      anchor_timestamp: params.anchorTimestamp,
      target_dex_credential: params.targetDexCredential,
      allocation_amount: params.allocationAmount,
      allocation_recipient_hash: params.allocationRecipientHash,
      relayer_credential_hash: params.relayerCredentialHash,
      relayer_bond: params.relayerBondLovelace,
    };

    // The bond is real lovelace added to the continuing output's
    // value on top of whatever the anchor UTXO already held — matches
    // cto_governance.ak's bond_received check
    // (own_output.lovelace == own_input.lovelace + relayer_bond).
    const continuingAssets = {
      ...anchorUtxo.assets,
      lovelace: (anchorUtxo.assets.lovelace ?? 0n) + params.relayerBondLovelace,
    };

    // AnchorVoteResult requires validity_range_is_narrow (cto_governance.ak,
    // max width 600_000ms) on top of interval.contains(range,
    // anchor_timestamp) — same pattern as tier-a-curve-submitter.ts's
    // ActivateCurve, but bounded much tighter to satisfy the narrow-range
    // check. anchor_timestamp is expected to be the real submission time,
    // so a small symmetric margin around it is sufficient.
    const lpEscrowUtxo = await findLpEscrowUtxo(
      lucid,
      this.lpEscrowAddress,
      this.config.launchId,
      this.config.threadNftPolicyId,
    );

    const anchorTimestampMs = Number(params.anchorTimestamp);
    const validFrom = anchorTimestampMs - 60_000;
    const validTo = anchorTimestampMs + 60_000;

    const tx = await lucid
      .newTx()
      .collectFrom([anchorUtxo], Data.to<AnchorVoteResultRedeemerData>(redeemerData, AnchorVoteResultRedeemerSchema))
      .attach.SpendingValidator(this.validator)
      // Read-only: the validator reads graduation time from here and the UTXO
      // is left untouched. Without it the anchor cannot be built at all,
      // which is the intended shape — a ballot has no eligibility to check
      // against if nothing says when the launch graduated.
      .readFrom([lpEscrowUtxo])
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<CtoGovernanceDatumData>(newDatum, CtoGovernanceDatumSchema),
        },
        continuingAssets,
      )
      .validFrom(validFrom)
      .validTo(validTo)
      .complete();

    const signed = await tx.sign.withPrivateKey(this.config.relayerPrivateKey).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { toHex };
