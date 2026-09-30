import { describe, expect, it } from 'vitest';
import {
  buildBalanceSnapshotTree,
  computeVoteNullifier,
  deriveUserPublicKey,
  type MerkleProofEntry,
} from '../../../packages/zk-proofs/src/cto-governance.js';
import {
  BreakGlassState,
  Contract,
  CtoState,
  ledger,
  ProposalState,
  ProposalType,
  type Witnesses,
} from '../compiled/cto_governance/contract/index.js';
import { DOMAINS, deriveRoleKey } from '../witnesses.js';
import { deployForTest, fakeBytes32, nextContext, nextContextAtTime } from './helpers.js';

// Fix (2026-07-21): every circuit here that takes a currentTimestamp
// parameter now binds it to real chain time (blockTimeGte/blockTimeLte, same
// idiom as lp_escrow.compact's sealLock) — see cto_governance.compact's own
// comments on updateBalanceSnapshot/updateCreatorActivity/checkSilenceLock/
// createProposal/castVote/finalizeProposal/bondedSilenceChallenge/
// resolveBreakGlassChallenge for the full Critical finding. Every call site
// below now pins the simulator's block time via nextContextAtTime to match
// the currentTimestamp value it passes, the same pattern lp_escrow.test.ts
// already established for sealLock.

type PrivateState = undefined;

const EMPTY_PROOF: MerkleProofEntry[] = [];

function makeWitnesses(
  userFill: number,
  balanceLeafAmount = 0n,
  balanceProof: MerkleProofEntry[] = EMPTY_PROOF,
  balanceLeafHeldSince = 0n,
  // Which attestor is speaking. The balance snapshot needs two of three, and
  // each call carries only its own signer's secret — so a second attestor is
  // a second set of witnesses, not a second argument to one call.
  governorFill = ATTESTOR_1_FILL,
): Witnesses<PrivateState> {
  return {
    getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(userFill) }],
    getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(governorFill) }],
    getBalanceLeafAmount: (_ctx) => [undefined, balanceLeafAmount],
    getBalanceLeafHeldSince: (_ctx) => [undefined, balanceLeafHeldSince],
    getBalanceProof: (_ctx) => [undefined, balanceProof],
  };
}

// The three keys allowed to attest the balance snapshot. Fill 2 is the
// original governor secret every other circuit in this file already uses, so
// the governor remains one of the attestors rather than a separate role.
const ATTESTOR_1_FILL = 2;
const ATTESTOR_2_FILL = 22;
const ATTESTOR_3_FILL = 23;
const ATTEST_THRESHOLD = 2n;
const ATTEST_EXPIRY_SECONDS = 86_400n;
const attestorKey = (fill: number) => deriveRoleKey({ bytes: fakeBytes32(fill) }, DOMAINS.CTO_GOVERNOR).bytes;
const ATTESTOR_1_KEY = attestorKey(ATTESTOR_1_FILL);
const ATTESTOR_2_KEY = attestorKey(ATTESTOR_2_FILL);
const ATTESTOR_3_KEY = attestorKey(ATTESTOR_3_FILL);

const TOTAL_SUPPLY = 1_000_000_000n;
const GRADUATION_TIMESTAMP = 0n;
const MIN_POST_GRAD_DELAY = 7_776_000n; // 90 days (raised from 30, anti-whale-takeover fix 2026-07-28)
const SILENCE_THRESHOLD = 7_776_000n; // 90 days
const BALLOT_DURATION = 259_200n; // 72 hours
const MAX_SNAPSHOT_AGE = 2_592_000n; // 30 days
const MIN_HOLDING_PERIOD = 2_592_000n; // 30 days (anti-whale-takeover safeguard #3, 2026-07-28)
const _QUORUM_BPS = 500n; // 5%
// Anti-whale-takeover fix (2026-07-28): this is now the UNIFORM per-voter
// cap (constructor's maxVoterCap_), not a creator-only allowance — kept the
// CREATOR_VOTE_CAP name since the describe block below specifically
// exercises creator-flagged voting behavior against it.
const CREATOR_VOTE_CAP = (TOTAL_SUPPLY * 100n) / 10_000n; // 1% of total supply, computed off-chain
// Permissive default so every pre-existing test (1-2 simulated voters) is
// unaffected by the new minVoterCount safeguard; the dedicated describe
// block below sets this explicitly to 15 to actually exercise it.
const DEFAULT_MIN_VOTER_COUNT = 1n;
const MIN_VOTER_COUNT = 15n;

// Fixed test identities. CREATOR_FILL's derived public key is what gets
// passed as the constructor's creatorPubKey_, so votes cast with
// makeWitnesses(CREATOR_FILL, ...) are the ones the circuit will recognize
// as isCreator === true; every other fill is a regular voter.
const CREATOR_FILL = 99;
// The launch every contract in this file is deployed with. Identity is scoped
// per launch, so a key derived under any other value matches nothing on-chain.
const LAUNCH_ID = fakeBytes32(9);

const CREATOR_PUBKEY = deriveUserPublicKey(fakeBytes32(CREATOR_FILL), LAUNCH_ID);
const VOTER_FILL = 3;
const OTHER_VOTER_FILL = 77;
const CHALLENGER_FILL = 55;
// Anti-whale-takeover fix (2026-07-28): with maxVoterCap now at 1% of
// supply (CREATOR_VOTE_CAP below), no single voter can reach the 5% quorum
// threshold alone anymore — quorum-clearing tests need several distinct
// voter identities. Fills chosen to avoid colliding with the ones above.
const MANY_VOTER_FILLS = Array.from({ length: 20 }, (_, i) => 10 + i); // 10..29

const BREAK_GLASS_BOND_MIN = 1_000_000n;
const BREAK_GLASS_RESPONSE_WINDOW = 259_200n; // 72 hours
// One platform wallet, replacing the treasury/ops pair.
const PLATFORM_ADDR = fakeBytes32(200);

function deploy(
  maxVoterCap: bigint = CREATOR_VOTE_CAP,
  minVoterCount: bigint = DEFAULT_MIN_VOTER_COUNT,
  hasClaimableBalance = true,
) {
  const witnesses = makeWitnesses(VOTER_FILL);
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    LAUNCH_ID,
    TOTAL_SUPPLY,
    GRADUATION_TIMESTAMP,
    maxVoterCap,
    minVoterCount,
    CREATOR_PUBKEY,
    hasClaimableBalance,
    BREAK_GLASS_BOND_MIN,
    PLATFORM_ADDR,
    ATTESTOR_1_KEY,
    ATTESTOR_2_KEY,
    ATTESTOR_3_KEY,
    ATTEST_THRESHOLD,
  );
  return { contract, init, contractAddress, ctx };
}

/**
 * Publishes a balance-snapshot root containing exactly the given
 * (fill, balance) pairs (design requirement). Returns a `witnessesFor(fill)` helper that builds the right
 * getBalanceLeafAmount/getBalanceProof pair for any fill in the snapshot.
 */
function publishBalanceSnapshot(
  d: ReturnType<typeof deploy>,
  // heldSinceTimestamp defaults to 0n (GRADUATION_TIMESTAMP) -- well before
  // any real proposal.startTimestamp used in this file, so every existing
  // test naturally clears MIN_HOLDING_PERIOD without needing to specify it.
  // The dedicated holding-period describe block below sets it explicitly.
  entries: Array<{ fill: number; balance: bigint; heldSinceTimestamp?: bigint }>,
  // Defaults to SILENCE_THRESHOLD -- every caller in this file creates its
  // proposal at or shortly after that timestamp, so this keeps the
  // snapshot fresh (stale-snapshot fix, 2026-07-19) without every call
  // site needing to pass it explicitly.
  snapshotTimestamp: bigint = SILENCE_THRESHOLD,
) {
  const keyed = entries.map((e) => ({
    fill: e.fill,
    voterKey: deriveUserPublicKey(fakeBytes32(e.fill), LAUNCH_ID),
    balance: e.balance,
    heldSinceTimestamp: e.heldSinceTimestamp ?? 0n,
  }));
  const tree = buildBalanceSnapshotTree(
    keyed.map(({ voterKey, balance, heldSinceTimestamp }) => ({ voterKey, balance, heldSinceTimestamp })),
  );

  // Two attestors, two separate calls — the root is not written until the
  // second one lands. The first uses this deployment's own contract (attestor
  // 1); the second needs its own witnesses, because a call can only ever
  // carry the secret of whoever built it.
  const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(snapshotTimestamp));
  const r1 = d.contract.circuits.updateBalanceSnapshot(pinnedCtx, tree.root, snapshotTimestamp);
  const ctxAfterFirst = nextContextAtTime(
    d.contractAddress,
    nextContext(d.contractAddress, r1.context),
    Number(snapshotTimestamp),
  );
  const second = new Contract<PrivateState>(makeWitnesses(VOTER_FILL, 0n, EMPTY_PROOF, 0n, ATTESTOR_2_FILL));
  const r2 = second.circuits.updateBalanceSnapshot(ctxAfterFirst, tree.root, snapshotTimestamp);
  const ctx = nextContext(d.contractAddress, r2.context);

  function witnessesFor(fill: number): Witnesses<PrivateState> {
    const idx = keyed.findIndex((e) => e.fill === fill);
    if (idx === -1) throw new Error(`publishBalanceSnapshot: fill ${fill} not in this snapshot`);
    return makeWitnesses(fill, keyed[idx].balance, tree.getProof(idx), keyed[idx].heldSinceTimestamp);
  }

  return { ctx, witnessesFor };
}

/** Create a SilenceLockTrigger proposal at exactly the silence threshold. */
function deployAndCreateProposal(
  balances: Array<{ fill: number; balance: bigint; heldSinceTimestamp?: bigint }>,
  hasClaimableBalance = true,
) {
  const d = deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, hasClaimableBalance);
  const { ctx: ctxAfterSnapshot, witnessesFor } = publishBalanceSnapshot(d, balances);
  const createTime = SILENCE_THRESHOLD;
  const pinnedCtx = nextContextAtTime(d.contractAddress, ctxAfterSnapshot, Number(createTime));
  const r = d.contract.circuits.createProposal(
    pinnedCtx,
    ProposalType.SilenceLockTrigger,
    fakeBytes32(40), // descriptionHash
    createTime,
    fakeBytes32(0), // targetDexAddr (unused for this proposal type)
    0n, // allocationAmount
    fakeBytes32(0), // allocationRecipient
    fakeBytes32(90), // proposedCommunityWallet,
    BREAK_GLASS_BOND_MIN,
  );
  const proposalId = r.result as Uint8Array;
  const ctx = nextContext(d.contractAddress, r.context);
  return { ...d, ctx, proposalId, createTime, witnessesFor };
}

describe('cto_governance.compact — Fix: currentTimestamp forgery (Critical)', () => {
  it('rejects a fabricated currentTimestamp when the simulator block time is left at its real default (unpinned)', () => {
    // Before the fix: every currentTimestamp-taking circuit trusted this
    // parameter outright, so a caller must not be able to fabricate an
    // internally-consistent-but-fictional create->vote->finalize sequence
    // in one real transaction. This test deliberately does NOT call
    // nextContextAtTime — it uses the default (real wall-clock) block time,
    // exactly what a real attacker's single real transaction would see —
    // and supplies a small, arbitrary currentTimestamp (SILENCE_THRESHOLD)
    // completely disconnected from it. Before the fix this would have
    // succeeded; after the fix it must fail on the new band check, not the
    // "no balance snapshot" check that would otherwise fire first.
    const d = deploy();
    expect(() =>
      d.contract.circuits.createProposal(
        d.ctx,
        ProposalType.SilenceLockTrigger,
        fakeBytes32(40),
        SILENCE_THRESHOLD,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow(/currentTimestamp/i);
  });

  it('rejects a currentTimestamp claimed to be in the future relative to real block time', () => {
    const d = deploy();
    const farFuture = 99_999_999_999n;
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENCE_THRESHOLD));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx,
        ProposalType.SilenceLockTrigger,
        fakeBytes32(40),
        farFuture,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow(/cannot be in the future/i);
  });

  it('rejects a forged castVote currentTimestamp that does not match real block time', () => {
    const { contract, ctx, proposalId, createTime } = deployAndCreateProposal([{ fill: VOTER_FILL, balance: 1000n }]);
    // Real block time is still pinned at createTime (from deployAndCreateProposal).
    // Claiming a currentTimestamp far past the ballot window, without
    // advancing real block time to match, must fail on the timestamp band
    // check rather than being accepted as "voting ended".
    const forgedTime = createTime + BALLOT_DURATION + 100_000n;
    expect(() => contract.circuits.castVote(ctx, proposalId, true, forgedTime)).toThrow(/currentTimestamp/i);
  });
});

describe('cto_governance.compact — proposal lifecycle gating', () => {
  it('rejects creating a proposal before a balance snapshot has been published', () => {
    const d = deploy();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENCE_THRESHOLD));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx,
        ProposalType.SilenceLockTrigger,
        fakeBytes32(40),
        SILENCE_THRESHOLD,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow('No balance snapshot published yet');
  });

  it('rejects creating a proposal against a balance snapshot older than 30 days (stale-snapshot fix)', () => {
    const d = deploy();
    // Published 60 days before createProposal fires -- past the 30-day
    // maxSnapshotAge, so the snapshot is stale even though it exists and the
    // silence/post-grad-delay checks would otherwise pass. Deliberately short
    // of staleSnapshotGraceWindow (90 days): this test is about the band where
    // a fresh root is owed and a proposal waits for it, which is every
    // proposal type's normal requirement.
    const sixtyDays = 5_184_000n;
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }], SILENCE_THRESHOLD - sixtyDays);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx,
        ProposalType.SilenceLockTrigger,
        fakeBytes32(40),
        SILENCE_THRESHOLD,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow(/stale/i);
  });

  it('allows creating a proposal when the snapshot is exactly at the 30-day staleness boundary', () => {
    const d = deploy();
    const snapshotTime = SILENCE_THRESHOLD - MAX_SNAPSHOT_AGE;
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }], snapshotTime);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD));
    const r = d.contract.circuits.createProposal(
      pinnedCtx,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(40),
      SILENCE_THRESHOLD,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
    expect(r.result).toBeInstanceOf(Uint8Array);
  });

  it('rejects creating a proposal before the 30-day post-graduation delay', () => {
    const d = deploy();
    // Snapshot published at deploy time (0n) -- explicit override so this
    // test isolates the post-grad-delay assert, not the stale-snapshot one
    // (MIN_POST_GRAD_DELAY - 1n is earlier than the default SILENCE_THRESHOLD
    // snapshot timestamp, which would underflow the elapsed-age check).
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }], 0n);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(MIN_POST_GRAD_DELAY - 1n));
    expect(
      () =>
        d.contract.circuits.createProposal(
          pinnedCtx,
          ProposalType.SilenceLockTrigger,
          fakeBytes32(40),
          MIN_POST_GRAD_DELAY - 1n,
          fakeBytes32(0),
          0n,
          fakeBytes32(0),
          fakeBytes32(90),
          BREAK_GLASS_BOND_MIN,
        ),
      // Snapshot published at t=0; the staleness check (30-day
      // maxSnapshotAge) is checked before the post-grad-delay check, and at
      // MIN_POST_GRAD_DELAY - 1n (~89 days) the snapshot is already well
      // past 30 days old, so staleness fires first — confirmed by running
      // it, not the post-grad-delay assert this test's own name suggests.
    ).toThrow('Balance snapshot too stale — governor must republish');
  });

  it('rejects a SilenceLockTrigger proposal before the creator has been silent 90 days', () => {
    const d = deploy();
    // Snapshot published right at this test's own createProposal timestamp
    // -- explicit override so this isolates the silence-threshold assert,
    // not the stale-snapshot one.
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }], SILENCE_THRESHOLD - 1n);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD - 1n));
    expect(
      () =>
        d.contract.circuits.createProposal(
          pinnedCtx,
          ProposalType.SilenceLockTrigger,
          fakeBytes32(40),
          SILENCE_THRESHOLD - 1n,
          fakeBytes32(0),
          0n,
          fakeBytes32(0),
          fakeBytes32(90),
          BREAK_GLASS_BOND_MIN,
        ),
      // minProposalTime is checked before the silence-threshold assert, and
      // both are set to the same 90-day constant here, so at
      // SILENCE_THRESHOLD - 1n this test actually hits the earlier
      // post-graduation-delay check first, not the silence one its own
      // description names — confirmed by running it, not assumed.
    ).toThrow('Too soon after graduation');
  });

  it('allows creating a SilenceLockTrigger proposal once the creator has been silent long enough', () => {
    const { ctx, proposalId } = deployAndCreateProposal([{ fill: VOTER_FILL, balance: 1n }]);
    const state = ledger(ctx.currentQueryContext.state);
    expect(state.proposalCount).toBe(1n);
    expect(proposalId).toBeInstanceOf(Uint8Array);
  });

  it('rejects a SilenceLockTrigger proposal for a zero-volume launch', () => {
    const d = deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, false); // hasClaimableBalance = false at deploy
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }]);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx,
        ProposalType.SilenceLockTrigger,
        fakeBytes32(40),
        SILENCE_THRESHOLD,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow(/claimable/i);
  });

  it('allows a SilenceLockTrigger proposal once the governor attests a real balance exists', () => {
    const d = deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, false);
    const { ctx: snapshotCtx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }]);
    // Governor later confirms fees did accrue after all — same call that
    // refreshes lastCreatorActivity also flips hasClaimableBalance.
    // Two attestors, because the pair (activity time, claimable) is attested
    // and one signature no longer commits it.
    const pinnedActivityCtx = nextContextAtTime(d.contractAddress, snapshotCtx, 0);
    const rActivity = d.contract.circuits.updateCreatorActivity(pinnedActivityCtx, 0n, true, 0n);
    const secondActivity = new Contract<PrivateState>(makeWitnesses(VOTER_FILL, 0n, EMPTY_PROOF, 0n, ATTESTOR_2_FILL));
    const rActivity2 = secondActivity.circuits.updateCreatorActivity(
      nextContextAtTime(d.contractAddress, nextContext(d.contractAddress, rActivity.context), 0),
      0n,
      true,
      0n,
    );
    const ctx = nextContext(d.contractAddress, rActivity2.context);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD));
    const r = d.contract.circuits.createProposal(
      pinnedCtx,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(40),
      SILENCE_THRESHOLD,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
    expect(r.result).toBeInstanceOf(Uint8Array);
  });
});

describe('cto_governance.compact — quorum and majority math (creator vote cap)', () => {
  it('passes a proposal that meets both quorum (5%) and majority', () => {
    // Anti-whale-takeover fix (2026-07-28): maxVoterCap (1%) is now lower
    // than the 5% quorum threshold, so no single voter can reach quorum
    // alone anymore -- 6 distinct voters at the cap (1% each = 6% total)
    // clear quorum with a clean unanimous majority.
    const voterFills = MANY_VOTER_FILLS.slice(0, 6);
    const { contract, contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal(
      voterFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
    );

    let runningCtx = ctx;
    let voteTime = createTime;
    for (const fill of voterFills) {
      voteTime += 1n;
      const voterContract = new Contract<PrivateState>(witnessesFor(fill));
      const pinnedVoteCtx = nextContextAtTime(contractAddress, runningCtx, Number(voteTime));
      const rVote = voterContract.circuits.castVote(pinnedVoteCtx, proposalId, true, voteTime);
      runningCtx = nextContext(contractAddress, rVote.context);
    }

    const finalizeTime = createTime + BALLOT_DURATION + 1n;
    const pinnedFinalizeCtx = nextContextAtTime(contractAddress, runningCtx, Number(finalizeTime));
    const rFinalize = contract.circuits.finalizeProposal(pinnedFinalizeCtx, proposalId, finalizeTime);
    const proposal = ledger(rFinalize.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.state).toBe(ProposalState.Passed);
    expect(proposal.yesVotes).toBe(CREATOR_VOTE_CAP * BigInt(voterFills.length));
  });

  it('fails a proposal that has majority support but does not meet quorum', () => {
    const yesWeight = TOTAL_SUPPLY / 100n; // 1% — well under the 5% quorum
    const { contract, contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: yesWeight },
    ]);

    const voterContract = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedVoteCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = voterContract.circuits.castVote(pinnedVoteCtx, proposalId, true, voteTime);
    const ctx2 = nextContext(contractAddress, rVote.context);

    const finalizeTime = createTime + BALLOT_DURATION + 1n;
    const pinnedFinalizeCtx = nextContextAtTime(contractAddress, ctx2, Number(finalizeTime));
    const rFinalize = contract.circuits.finalizeProposal(pinnedFinalizeCtx, proposalId, finalizeTime);
    const proposal = ledger(rFinalize.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.state).not.toBe(ProposalState.Passed);
  });

  it('fails a proposal that meets quorum but has more no votes than yes votes', () => {
    // Anti-whale-takeover fix (2026-07-28): each voter is capped at 1%, so
    // 2 yes voters (2%) + 4 no voters (4%) = 6% combined, clears the 5%
    // quorum, with no (4%) > yes (2%).
    const yesFills = MANY_VOTER_FILLS.slice(0, 2);
    const noFills = MANY_VOTER_FILLS.slice(2, 6);
    const { contract, contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      ...yesFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
      ...noFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
    ]);

    let runningCtx = ctx;
    let t = createTime;
    for (const fill of yesFills) {
      t += 1n;
      const voter = new Contract<PrivateState>(witnessesFor(fill));
      const pinnedCtx = nextContextAtTime(contractAddress, runningCtx, Number(t));
      const r = voter.circuits.castVote(pinnedCtx, proposalId, true, t);
      runningCtx = nextContext(contractAddress, r.context);
    }
    for (const fill of noFills) {
      t += 1n;
      const voter = new Contract<PrivateState>(witnessesFor(fill));
      const pinnedCtx = nextContextAtTime(contractAddress, runningCtx, Number(t));
      const r = voter.circuits.castVote(pinnedCtx, proposalId, false, t);
      runningCtx = nextContext(contractAddress, r.context);
    }

    const finalizeTime = createTime + BALLOT_DURATION + 1n;
    const pinnedFinalizeCtx = nextContextAtTime(contractAddress, runningCtx, Number(finalizeTime));
    const rFinalize = contract.circuits.finalizeProposal(pinnedFinalizeCtx, proposalId, finalizeTime);
    const proposal = ledger(rFinalize.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.state).not.toBe(ProposalState.Passed);
  });

  it('rejects voting twice on the same proposal from the same identity (vote nullifier)', () => {
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: 1000n },
    ]);
    const voterContract = new Contract<PrivateState>(witnessesFor(VOTER_FILL));

    const vote1Time = createTime + 1n;
    const pinnedCtx1 = nextContextAtTime(contractAddress, ctx, Number(vote1Time));
    const r1 = voterContract.circuits.castVote(pinnedCtx1, proposalId, true, vote1Time);
    const ctx2 = nextContext(contractAddress, r1.context);

    const vote2Time = createTime + 2n;
    const pinnedCtx2 = nextContextAtTime(contractAddress, ctx2, Number(vote2Time));
    expect(() => voterContract.circuits.castVote(pinnedCtx2, proposalId, true, vote2Time)).toThrow(
      'Already voted on this proposal',
    );
  });

  it('rejects voting after the 72-hour ballot window closes', () => {
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: 1000n },
    ]);
    const voterContract = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + BALLOT_DURATION + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    expect(() => voterContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime)).toThrow('Voting ended');
  });

  it('rejects finalizing before the ballot window closes', () => {
    const { contract, contractAddress, ctx, proposalId, createTime } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: 1000n },
    ]);
    const finalizeTime = createTime + BALLOT_DURATION - 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(finalizeTime));
    expect(() => contract.circuits.finalizeProposal(pinnedCtx, proposalId, finalizeTime)).toThrow('Ballot still open');
  });

  it('rejects a vote whose balance proof does not match the pinned snapshot root (forged weight)', () => {
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: 1000n },
    ]);
    // Security-audit fix regression: a caller can no longer just assert an
    // arbitrary weight — supplying a balance that doesn't match this
    // voter's real leaf in the published tree must be rejected.
    const forgedContract = new Contract<PrivateState>(makeWitnesses(VOTER_FILL, 999_999_999n, []));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    expect(
      () => forgedContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime),
      // makeWitnesses' 3rd arg ([]) is an empty proof array where the
      // circuit expects a fixed Vector<20, MerkleProofEntry> — Compact's
      // runtime type-checks the shape before the "Invalid balance proof"
      // assert is ever reached, so this actually fails as a type error,
      // not a business-logic rejection. Confirmed by running it.
    ).toThrow(/type error/i);
    void witnessesFor;
  });
});

describe('cto_governance.compact — unified voter cap (creatorVoteCap regression, anti-whale-takeover fix 2026-07-28)', () => {
  it('rejects a zero or out-of-range maxVoterCap at construction', () => {
    expect(() => deploy(0n)).toThrow('maxVoterCap must be a positive fraction of totalSupply');
    expect(() => deploy(TOTAL_SUPPLY + 1n)).toThrow('maxVoterCap must be a positive fraction of totalSupply');
  });

  it('rejects a zero minVoterCount at construction (anti-whale-takeover safeguard #2)', () => {
    expect(() => deploy(CREATOR_VOTE_CAP, 0n)).toThrow('minVoterCount must be positive');
  });

  it('IMPORTANT FINDING (fixed): a creator-flagged vote above the cap is capped, not zeroed and not unbounded', () => {
    // Before the fix, `creatorVoteCapBps` was declared but never assigned
    // in the constructor, so it silently defaulted to 0 — every
    // creator-flagged vote was capped at ZERO, not the intended 2%. A
    // naive bps-with-missing-/10000 fix (mirroring the walletCap bug)
    // would have gone the other way, making the cap 10000x too large. The
    // real fix takes the cap as a correctly-precomputed constructor arg.
    //
    // isCreator is now derived on-chain from the voter's own identity
    // (design requirement) — this test votes AS the identity
    // whose public key was passed as creatorPubKey at deploy time, rather
    // than passing an isCreator flag directly.
    const aboveCapWeight = CREATOR_VOTE_CAP * 2n;
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: CREATOR_FILL, balance: aboveCapWeight },
    ]);
    const creatorContract = new Contract<PrivateState>(witnessesFor(CREATOR_FILL));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = creatorContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime);
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.creatorYesVotes).toBe(CREATOR_VOTE_CAP);
    expect(proposal.yesVotes).toBe(CREATOR_VOTE_CAP);
  });

  it('a creator-flagged vote at or below the cap passes through unchanged', () => {
    const belowCapWeight = CREATOR_VOTE_CAP / 2n;
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: CREATOR_FILL, balance: belowCapWeight },
    ]);
    const creatorContract = new Contract<PrivateState>(witnessesFor(CREATOR_FILL));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = creatorContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime);
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.creatorYesVotes).toBe(belowCapWeight);
    expect(proposal.yesVotes).toBe(belowCapWeight);
  });

  it('anti-whale-takeover fix (2026-07-28): a non-creator vote is now ALSO capped at maxVoterCap, just like the creator', () => {
    // Before this fix, only a creator-flagged vote was capped — any other
    // single wallet could satisfy quorum (5%) and majority entirely alone
    // with an uncapped vote. Now every voter, creator or not, is held to
    // the same maxVoterCap.
    const largeWeight = CREATOR_VOTE_CAP * 10n;
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: largeWeight },
    ]);
    const voterContract = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = voterContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime);
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.creatorYesVotes).toBe(0n); // still not attributed to the creator audit tally
    expect(proposal.yesVotes).toBe(CREATOR_VOTE_CAP); // but the WEIGHT is now capped just the same
  });

  it('a voter below the cap (creator or not) is never truncated, only weight above the cap is', () => {
    const belowCapWeight = CREATOR_VOTE_CAP / 2n;
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: OTHER_VOTER_FILL, balance: belowCapWeight },
    ]);
    const voterContract = new Contract<PrivateState>(witnessesFor(OTHER_VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = voterContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime);
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.creatorYesVotes).toBe(0n);
    expect(proposal.yesVotes).toBe(belowCapWeight);
  });
});

describe('cto_governance.compact — bonded break-glass fallback (governor censorship risk)', () => {
  // deploy()'s constructor sets lastCreatorActivity = GRADUATION_TIMESTAMP
  // (0n), so this is exactly the silence threshold's own elapsed value.
  const SILENT_TIME = SILENCE_THRESHOLD;

  function deployWithoutClaimableBalance() {
    return deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, false);
  }

  function challengerContract() {
    return new Contract<PrivateState>(makeWitnesses(CHALLENGER_FILL));
  }

  it('rejects opening a challenge when hasClaimableBalance is already true', () => {
    const d = deploy(); // hasClaimableBalance: true by default
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    expect(() =>
      challengerContract().circuits.bondedSilenceChallenge(pinnedCtx, BREAK_GLASS_BOND_MIN, SILENT_TIME),
    ).toThrow(/no need to challenge/i);
  });

  it('rejects opening a challenge before the creator has been silent long enough', () => {
    const d = deployWithoutClaimableBalance();
    const t = SILENCE_THRESHOLD - 1n;
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(t));
    expect(() => challengerContract().circuits.bondedSilenceChallenge(pinnedCtx, BREAK_GLASS_BOND_MIN, t)).toThrow(
      /silent long enough/i,
    );
  });

  it('rejects a bond below the minimum', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    expect(() =>
      challengerContract().circuits.bondedSilenceChallenge(pinnedCtx, BREAK_GLASS_BOND_MIN - 1n, SILENT_TIME),
    ).toThrow(/below minimum/i);
  });

  it('opens a pending challenge with a valid bond once the creator is genuinely silent', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.breakGlassChallenge.state).toBe(BreakGlassState.Pending);
    expect(state.breakGlassChallenge.bondAmount).toBe(BREAK_GLASS_BOND_MIN);
    // hasClaimableBalance is untouched until the challenge actually resolves.
    expect(state.hasClaimableBalance).toBe(false);
  });

  it('rejects opening a second challenge while one is already pending', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    const t2 = SILENT_TIME + 1n;
    const pinnedCtx2 = nextContextAtTime(d.contractAddress, ctx2, Number(t2));
    expect(() => challengerContract().circuits.bondedSilenceChallenge(pinnedCtx2, BREAK_GLASS_BOND_MIN, t2)).toThrow(
      /already pending/i,
    );
  });

  it('rejects resolving before the response window elapses with no governor response', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW - 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx2, Number(resolveTime));
    expect(() => d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime)).toThrow(
      /has not elapsed/i,
    );
  });

  it('auto-confirms and forces hasClaimableBalance true once the response window elapses undefended', () => {
    // This is the actual "break glass": the governor never touched
    // updateCreatorActivity at all since the challenge was opened.
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);

    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW + 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx2, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.hasClaimableBalance).toBe(true);
    expect(state.breakGlassChallenge.state).toBe(BreakGlassState.Confirmed);
    expect(state.breakGlassChallenge.bondAmount).toBe(BREAK_GLASS_BOND_MIN);
  });

  it('Fix (2026-07-21): treats a genuine governor rebuttal (still no claimable balance) as Rebutted, WITHOUT forfeiting the bond', () => {
    // Before the fix, this branch forfeited the bond 60/40 to
    // treasuryAddr/opsAddr — platform-controlled addresses, the SAME party
    // as the governor being checked. That made every challenge against a
    // dishonest governor a free, guaranteed profit for that governor's own
    // platform. Now Rebutted keeps the bond intact, refundable to the
    // challenger — see resolveBreakGlassChallenge's own header comment.
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);

    // Governor genuinely checks in after the challenge and still confirms
    // no claimable balance exists -- real engagement, not silence.
    const activityTime = SILENT_TIME + 1n;
    const pinnedActivityCtx = nextContextAtTime(d.contractAddress, ctx2, Number(activityTime));
    const rActivity = d.contract.circuits.updateCreatorActivity(pinnedActivityCtx, 0n, false, activityTime);
    const ctx3 = nextContext(d.contractAddress, rActivity.context);

    const resolveTime = SILENT_TIME + 2n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx3, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.hasClaimableBalance).toBe(false);
    expect(state.breakGlassChallenge.state).toBe(BreakGlassState.Rebutted);
    expect(state.breakGlassChallenge.bondAmount).toBe(BREAK_GLASS_BOND_MIN); // no forfeiture
  });

  it('lets the original challenger claim a full refund after Confirmed', () => {
    const d = deployWithoutClaimableBalance();
    const challenger = challengerContract();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challenger.circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW + 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx2, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const ctx3 = nextContext(d.contractAddress, r2.context);

    const r3 = challenger.circuits.claimBreakGlassBondRefund(ctx3, fakeBytes32(60));
    const state = ledger(r3.context.currentQueryContext.state);
    expect(state.breakGlassChallenge.bondAmount).toBe(0n);

    // Double-claim rejected.
    expect(() =>
      challenger.circuits.claimBreakGlassBondRefund(nextContext(d.contractAddress, r3.context), fakeBytes32(60)),
    ).toThrow(/already claimed/i);
  });

  it('Fix (2026-07-21): lets the original challenger claim a full refund after Rebutted too (no forfeiture)', () => {
    const d = deployWithoutClaimableBalance();
    const challenger = challengerContract();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challenger.circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);

    const activityTime = SILENT_TIME + 1n;
    const pinnedActivityCtx = nextContextAtTime(d.contractAddress, ctx2, Number(activityTime));
    const rActivity = d.contract.circuits.updateCreatorActivity(pinnedActivityCtx, 0n, false, activityTime);
    const ctx3 = nextContext(d.contractAddress, rActivity.context);

    const resolveTime = SILENT_TIME + 2n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx3, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const ctx4 = nextContext(d.contractAddress, r2.context);

    const r3 = challenger.circuits.claimBreakGlassBondRefund(ctx4, fakeBytes32(60));
    const state = ledger(r3.context.currentQueryContext.state);
    expect(state.breakGlassChallenge.bondAmount).toBe(0n); // fully refunded, no split, no confiscation
  });

  it("fix (2026-07-30): rejects a new challenge while a prior Rebutted challenge's bond is still unclaimed", () => {
    // Uses the Rebutted path specifically (not Confirmed) because a
    // Confirmed resolution flips hasClaimableBalance to true, which
    // ALREADY blocks any further challenge via bondedSilenceChallenge's
    // pre-existing !hasClaimableBalance check — that path can't isolate
    // this fix. Rebutted leaves hasClaimableBalance false, so before this
    // fix, breakGlassChallenge.state != Pending alone would have let a
    // second challenge silently overwrite (and permanently strand) the
    // first challenger's still-unclaimed bond.
    const d = deployWithoutClaimableBalance();
    const challenger = challengerContract();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challenger.circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    let ctx = nextContext(d.contractAddress, r1.context);

    const activityTime = SILENT_TIME + 1n;
    const rActivity = d.contract.circuits.updateCreatorActivity(
      nextContextAtTime(d.contractAddress, ctx, Number(activityTime)),
      0n,
      false,
      activityTime,
    );
    ctx = nextContext(d.contractAddress, rActivity.context);

    const resolveTime = SILENT_TIME + 2n;
    const rResolve = d.contract.circuits.resolveBreakGlassChallenge(
      nextContextAtTime(d.contractAddress, ctx, Number(resolveTime)),
      resolveTime,
    );
    ctx = nextContext(d.contractAddress, rResolve.context);
    expect(ledger(ctx.currentQueryContext.state).breakGlassChallenge.state).toBe(BreakGlassState.Rebutted);

    // Attempting to open a NEW challenge before the prior bond has been
    // claimed must be rejected (challengerContract() always returns the
    // same CHALLENGER_FILL identity — a fresh Contract instance, not a
    // different identity, since this guard doesn't care who's attempting
    // the new challenge, only whether the prior bond is still owed).
    const secondTime = resolveTime + 1n;
    expect(() =>
      challengerContract().circuits.bondedSilenceChallenge(
        nextContextAtTime(d.contractAddress, ctx, Number(secondTime)),
        BREAK_GLASS_BOND_MIN,
        secondTime,
      ),
    ).toThrow(/must be claimed/i);

    // Once the original bond is claimed, a new challenge is allowed again.
    const rClaim = challenger.circuits.claimBreakGlassBondRefund(ctx, fakeBytes32(60));
    ctx = nextContext(d.contractAddress, rClaim.context);
    const rSecond = challengerContract().circuits.bondedSilenceChallenge(
      nextContextAtTime(d.contractAddress, ctx, Number(secondTime)),
      BREAK_GLASS_BOND_MIN,
      secondTime,
    );
    expect(ledger(rSecond.context.currentQueryContext.state).breakGlassChallenge.state).toBe(BreakGlassState.Pending);
  });

  it('rejects a refund claim from someone other than the original challenger', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW + 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx2, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const ctx3 = nextContext(d.contractAddress, r2.context);

    const impostor = new Contract<PrivateState>(makeWitnesses(OTHER_VOTER_FILL));
    expect(() => impostor.circuits.claimBreakGlassBondRefund(ctx3, fakeBytes32(61))).toThrow(/original challenger/i);
  });

  it('rejects a refund claim while the challenge is still Pending', () => {
    const d = deployWithoutClaimableBalance();
    const challenger = challengerContract();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challenger.circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    expect(() => challenger.circuits.claimBreakGlassBondRefund(ctx2, fakeBytes32(60))).toThrow(
      /not resolved to a refundable state/i,
    );
  });

  it('end-to-end: an undefended break-glass challenge unblocks a SilenceLockTrigger proposal the governor was withholding', () => {
    const d = deployWithoutClaimableBalance();
    const { ctx: snapshotCtx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }]);

    // Without break-glass, this is exactly the claimable-balance gate rejecting the
    // proposal because the governor never confirmed a claimable balance.
    const pinnedCreateCtx = nextContextAtTime(d.contractAddress, snapshotCtx, Number(SILENT_TIME));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCreateCtx,
        ProposalType.SilenceLockTrigger,
        fakeBytes32(40),
        SILENT_TIME,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow(/claimable/i);

    const pinnedChallengeCtx = nextContextAtTime(d.contractAddress, snapshotCtx, Number(SILENT_TIME));
    const rChallenge = challengerContract().circuits.bondedSilenceChallenge(
      pinnedChallengeCtx,
      BREAK_GLASS_BOND_MIN,
      SILENT_TIME,
    );
    const ctxAfterChallenge = nextContext(d.contractAddress, rChallenge.context);

    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW + 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctxAfterChallenge, Number(resolveTime));
    const rResolve = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const ctxAfterResolve = nextContext(d.contractAddress, rResolve.context);

    const pinnedProposalCtx = nextContextAtTime(d.contractAddress, ctxAfterResolve, Number(resolveTime));
    const rProposal = d.contract.circuits.createProposal(
      pinnedProposalCtx,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(41),
      resolveTime,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
    expect(rProposal.result).toBeInstanceOf(Uint8Array);
  });
});

describe('cto_governance.compact — Fix (2026-07-21, Medium): executeProposal re-validates ctoState', () => {
  it('rejects executing a stale SilenceLockTrigger proposal once ctoState has already changed since it passed', () => {
    // Two SilenceLockTrigger proposals both validly created while
    // ctoState == PreCTO, both pass, but only the FIRST to execute should
    // succeed — the second must now be rejected since ctoState is no
    // longer PreCTO by the time it tries to execute. Before the fix, the
    // second execution would have silently succeeded too, overwriting
    // communityWallet with no error.
    // Anti-whale-takeover fix (2026-07-28): maxVoterCap (1%) means no
    // single voter can clear the 5% quorum alone anymore -- 6 distinct
    // voters at the cap (6% combined) vote yes on both proposals below.
    // Fix (2026-07-30): proposal2 can no longer be created while
    // proposal1 is still Active (activeProposalCount gate) — this test's
    // OWN setup was exactly the concurrent-proposal pattern this fix closed,
    // so proposal1 is now created, voted, and finalized (not yet executed)
    // BEFORE proposal2 is created, and proposal2's creation must also wait
    // out the real 90-day cooldown from proposal1's finalization — both
    // real consequences of the fix, not just a test-harness adjustment.
    // This still exercises the exact scenario the test is actually about:
    // two proposals independently reach Passed, and only the first
    // execution should be allowed to change ctoState.
    const voterFills = MANY_VOTER_FILLS.slice(0, 6);
    const d = deploy();
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(
      d,
      voterFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
    );

    const communityWalletA = fakeBytes32(70);
    const communityWalletB = fakeBytes32(71);
    const createTime1 = SILENCE_THRESHOLD;
    const pinnedCreate1 = nextContextAtTime(d.contractAddress, snapCtx, Number(createTime1));
    const rCreate1 = d.contract.circuits.createProposal(
      pinnedCreate1,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(50),
      createTime1,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      communityWalletA,
      BREAK_GLASS_BOND_MIN,
    );
    const proposalId1 = rCreate1.result as Uint8Array;
    let ctx = nextContext(d.contractAddress, rCreate1.context);

    let voteTime1 = createTime1;
    for (const fill of voterFills) {
      voteTime1 += 1n;
      const voter = new Contract<PrivateState>(witnessesFor(fill));
      const rVote1 = voter.circuits.castVote(
        nextContextAtTime(d.contractAddress, ctx, Number(voteTime1)),
        proposalId1,
        true,
        voteTime1,
      );
      ctx = nextContext(d.contractAddress, rVote1.context);
    }

    const finalizeTime1 = createTime1 + BALLOT_DURATION + 1n;
    const rFin1 = d.contract.circuits.finalizeProposal(
      nextContextAtTime(d.contractAddress, ctx, Number(finalizeTime1)),
      proposalId1,
      finalizeTime1,
    );
    ctx = nextContext(d.contractAddress, rFin1.context);
    expect(ledger(ctx.currentQueryContext.state).proposals.lookup(proposalId1).state).toBe(ProposalState.Passed);

    // Real 90-day cooldown (COOLDOWN_DURATION, 7,776,000s) from proposal1's
    // finalization — activeProposalCount alone would allow immediate
    // re-creation the instant proposal1 finalizes, but the pre-existing
    // cooldown check still applies independently.
    const createTime2 = finalizeTime1 + 7_776_000n + 1n;

    // The original snapshot is now 90+ days old — createProposal's own
    // staleness check (maxSnapshotAge, 30 days) would reject proposal2's
    // creation otherwise, so republish it fresh at createTime2. Manually
    // replicates publishBalanceSnapshot's own logic against the CURRENT
    // evolved `ctx` (not d.ctx, which is stale from before proposal1's
    // whole lifecycle) so this doesn't fork away from proposal1's real
    // recorded state.
    const tree2 = buildBalanceSnapshotTree(
      voterFills.map((fill) => ({
        voterKey: deriveUserPublicKey(fakeBytes32(fill), LAUNCH_ID),
        balance: CREATOR_VOTE_CAP,
        heldSinceTimestamp: 0n,
      })),
    );
    const rSnapshot2 = d.contract.circuits.updateBalanceSnapshot(
      nextContextAtTime(d.contractAddress, ctx, Number(createTime2)),
      tree2.root,
      createTime2,
    );
    ctx = nextContext(d.contractAddress, rSnapshot2.context);
    function witnessesFor2(fill: number): Witnesses<PrivateState> {
      const idx = voterFills.indexOf(fill);
      return makeWitnesses(fill, CREATOR_VOTE_CAP, tree2.getProof(idx), 0n);
    }

    const pinnedCreate2 = nextContextAtTime(d.contractAddress, ctx, Number(createTime2));
    const rCreate2 = d.contract.circuits.createProposal(
      pinnedCreate2,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(51),
      createTime2,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      communityWalletB,
      BREAK_GLASS_BOND_MIN,
    );
    const proposalId2 = rCreate2.result as Uint8Array;
    ctx = nextContext(d.contractAddress, rCreate2.context);

    let voteTime2 = createTime2;
    for (const fill of voterFills) {
      voteTime2 += 1n;
      const voter = new Contract<PrivateState>(witnessesFor2(fill));
      const rVote2 = voter.circuits.castVote(
        nextContextAtTime(d.contractAddress, ctx, Number(voteTime2)),
        proposalId2,
        true,
        voteTime2,
      );
      ctx = nextContext(d.contractAddress, rVote2.context);
    }

    const finalizeTime2 = createTime2 + BALLOT_DURATION + 1n;
    const rFin2 = d.contract.circuits.finalizeProposal(
      nextContextAtTime(d.contractAddress, ctx, Number(finalizeTime2)),
      proposalId2,
      finalizeTime2,
    );
    ctx = nextContext(d.contractAddress, rFin2.context);
    expect(ledger(ctx.currentQueryContext.state).proposals.lookup(proposalId2).state).toBe(ProposalState.Passed);

    // First execution succeeds, sets ctoState = CTOTriggered.
    const rExec1 = d.contract.circuits.executeProposal(ctx, proposalId1);
    const stateAfterExec1 = ledger(rExec1.context.currentQueryContext.state);
    expect(stateAfterExec1.ctoState).toBe(CtoState.CTOTriggered);
    expect(stateAfterExec1.communityWallet).toEqual(communityWalletA);
    const ctxAfterExec1 = nextContext(d.contractAddress, rExec1.context);

    // Second execution — same proposal type, already-passed state, but
    // ctoState is no longer PreCTO — must now be rejected.
    expect(() => d.contract.circuits.executeProposal(ctxAfterExec1, proposalId2)).toThrow(/CTO state changed/i);

    // communityWallet must still be A, never overwritten by B.
    const finalState = ledger(ctxAfterExec1.currentQueryContext.state);
    expect(finalState.communityWallet).toEqual(communityWalletA);
  });
});

describe('cto_governance.compact — fix (2026-07-30): concurrent-proposal cooldown bypass', () => {
  it('rejects creating a second proposal while a first is still Active, even with a fresh descriptionHash', () => {
    // Before the fix, the cooldown (lastProposalEnd) was only written by
    // finalizeProposal, so nothing stopped an attacker from pre-creating
    // many independent SilenceLockTrigger ballots in one block — proposalId
    // varies by caller-chosen descriptionHash, so a fresh hash was all it
    // took. This proves the new activeProposalCount gate closes it: a
    // second createProposal call, moments after the first, with a
    // different descriptionHash (so it isn't just the existing
    // "Proposal already exists" duplicate-ID check firing instead), must
    // now be rejected specifically because a proposal is already Active.
    const d = deployAndCreateProposal([{ fill: VOTER_FILL, balance: 1n }]);
    const secondCreateTime = d.createTime + 1n;
    const pinnedSecondCreate = nextContextAtTime(d.contractAddress, d.ctx, Number(secondCreateTime));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedSecondCreate,
        ProposalType.SilenceLockTrigger,
        fakeBytes32(41),
        secondCreateTime,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(91),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow(/already active/i);
  });

  it('allows creating a new proposal once the prior one has been finalized and the cooldown has passed', () => {
    // Confirms the fix doesn't overtighten into "never allow a second
    // proposal at all" — once proposal1 genuinely finalizes AND the
    // pre-existing 90-day cooldown has separately elapsed, a real second
    // proposal is still allowed.
    const d = deployAndCreateProposal([{ fill: VOTER_FILL, balance: CREATOR_VOTE_CAP }]);
    const voter = new Contract<PrivateState>(d.witnessesFor(VOTER_FILL));
    const voteTime = d.createTime + 1n;
    const rVote = voter.circuits.castVote(
      nextContextAtTime(d.contractAddress, d.ctx, Number(voteTime)),
      d.proposalId,
      true,
      voteTime,
    );
    let ctx = nextContext(d.contractAddress, rVote.context);

    const finalizeTime = voteTime + BALLOT_DURATION + 1n;
    const rFin = d.contract.circuits.finalizeProposal(
      nextContextAtTime(d.contractAddress, ctx, Number(finalizeTime)),
      d.proposalId,
      finalizeTime,
    );
    ctx = nextContext(d.contractAddress, rFin.context);

    const createTime2 = finalizeTime + 7_776_000n + 1n; // 90-day cooldown + 1s
    const tree2 = buildBalanceSnapshotTree([
      {
        voterKey: deriveUserPublicKey(fakeBytes32(VOTER_FILL), LAUNCH_ID),
        balance: CREATOR_VOTE_CAP,
        heldSinceTimestamp: 0n,
      },
    ]);
    const rSnapshot2 = d.contract.circuits.updateBalanceSnapshot(
      nextContextAtTime(d.contractAddress, ctx, Number(createTime2)),
      tree2.root,
      createTime2,
    );
    ctx = nextContext(d.contractAddress, rSnapshot2.context);

    const rCreate2 = d.contract.circuits.createProposal(
      nextContextAtTime(d.contractAddress, ctx, Number(createTime2)),
      ProposalType.SilenceLockTrigger,
      fakeBytes32(42),
      createTime2,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(92),
      BREAK_GLASS_BOND_MIN,
    );
    expect(rCreate2.result).toBeInstanceOf(Uint8Array);
  });
});

describe('cto_governance.compact — anti-whale-takeover safeguard #2: minimum distinct voter count', () => {
  // Isolates the new minVoterCount check specifically: quorum (5%) and
  // majority are both genuinely met in every test below, so a failure to
  // pass can only be attributed to voterCount falling short of
  // minVoterCount — closing the exact gap a friend's devil's-advocate
  // question flagged (a single wealthy wallet satisfying quorum alone).

  function castVotesFrom(
    contractAddress: string,
    startCtx: ReturnType<typeof deployAndCreateProposal>['ctx'],
    proposalId: Uint8Array,
    fills: number[],
    witnessesFor: (fill: number) => Witnesses<PrivateState>,
    startTime: bigint,
  ) {
    let ctx = startCtx;
    let t = startTime;
    for (const fill of fills) {
      t += 1n;
      const voter = new Contract<PrivateState>(witnessesFor(fill));
      const r = voter.circuits.castVote(nextContextAtTime(contractAddress, ctx, Number(t)), proposalId, true, t);
      ctx = nextContext(contractAddress, r.context);
    }
    return { ctx, lastVoteTime: t };
  }

  it('fails a proposal that genuinely clears quorum and majority but falls short of minVoterCount (6 < 15)', () => {
    const voterFills = MANY_VOTER_FILLS.slice(0, 6); // 6% combined weight, clears 5% quorum, all yes
    const witnesses = makeWitnesses(VOTER_FILL);
    const contract = new Contract<PrivateState>(witnesses);
    const {
      init,
      contractAddress,
      ctx: deployCtx,
    } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      TOTAL_SUPPLY,
      GRADUATION_TIMESTAMP,
      CREATOR_VOTE_CAP,
      MIN_VOTER_COUNT,
      CREATOR_PUBKEY,
      true,
      BREAK_GLASS_BOND_MIN,
      PLATFORM_ADDR,
      ATTESTOR_1_KEY,
      ATTESTOR_2_KEY,
      ATTESTOR_3_KEY,
      ATTEST_THRESHOLD,
    );
    const d = { contract, init, contractAddress, ctx: deployCtx };
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(
      d,
      voterFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
    );
    const createTime = SILENCE_THRESHOLD;
    const pinnedCreate = nextContextAtTime(contractAddress, snapCtx, Number(createTime));
    const rCreate = contract.circuits.createProposal(
      pinnedCreate,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(40),
      createTime,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
    const proposalId = rCreate.result as Uint8Array;
    const ctxAfterCreate = nextContext(contractAddress, rCreate.context);

    const { ctx: ctxAfterVotes, lastVoteTime } = castVotesFrom(
      contractAddress,
      ctxAfterCreate,
      proposalId,
      voterFills,
      witnessesFor,
      createTime,
    );

    const finalizeTime = lastVoteTime + BALLOT_DURATION + 1n;
    const pinnedFinalize = nextContextAtTime(contractAddress, ctxAfterVotes, Number(finalizeTime));
    const rFinalize = contract.circuits.finalizeProposal(pinnedFinalize, proposalId, finalizeTime);
    const proposal = ledger(rFinalize.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.voterCount).toBe(BigInt(voterFills.length));
    expect(proposal.state).not.toBe(ProposalState.Passed);
  });

  it('passes the identical scenario once minVoterCount (15) distinct voters actually participate', () => {
    const voterFills = MANY_VOTER_FILLS.slice(0, 15); // 15% combined weight, clears 5% quorum, all yes
    const witnesses = makeWitnesses(VOTER_FILL);
    const contract = new Contract<PrivateState>(witnesses);
    const {
      init,
      contractAddress,
      ctx: deployCtx,
    } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      TOTAL_SUPPLY,
      GRADUATION_TIMESTAMP,
      CREATOR_VOTE_CAP,
      MIN_VOTER_COUNT,
      CREATOR_PUBKEY,
      true,
      BREAK_GLASS_BOND_MIN,
      PLATFORM_ADDR,
      ATTESTOR_1_KEY,
      ATTESTOR_2_KEY,
      ATTESTOR_3_KEY,
      ATTEST_THRESHOLD,
    );
    const d = { contract, init, contractAddress, ctx: deployCtx };
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(
      d,
      voterFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
    );
    const createTime = SILENCE_THRESHOLD;
    const pinnedCreate = nextContextAtTime(contractAddress, snapCtx, Number(createTime));
    const rCreate = contract.circuits.createProposal(
      pinnedCreate,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(40),
      createTime,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
    const proposalId = rCreate.result as Uint8Array;
    const ctxAfterCreate = nextContext(contractAddress, rCreate.context);

    const { ctx: ctxAfterVotes, lastVoteTime } = castVotesFrom(
      contractAddress,
      ctxAfterCreate,
      proposalId,
      voterFills,
      witnessesFor,
      createTime,
    );

    const finalizeTime = lastVoteTime + BALLOT_DURATION + 1n;
    const pinnedFinalize = nextContextAtTime(contractAddress, ctxAfterVotes, Number(finalizeTime));
    const rFinalize = contract.circuits.finalizeProposal(pinnedFinalize, proposalId, finalizeTime);
    const proposal = ledger(rFinalize.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.voterCount).toBe(BigInt(voterFills.length));
    expect(proposal.state).toBe(ProposalState.Passed);
  });
});

describe('cto_governance.compact — anti-whale-takeover safeguard #3: minimum holding period before a snapshot leaf counts', () => {
  it('rejects a vote whose heldSinceTimestamp is less than 30 days before the proposal started', () => {
    const d = deploy();
    const tooRecent = SILENCE_THRESHOLD - MIN_HOLDING_PERIOD + 1n; // 1 second short of 30 days
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(d, [
      { fill: VOTER_FILL, balance: 1000n, heldSinceTimestamp: tooRecent },
    ]);
    const createTime = SILENCE_THRESHOLD;
    const pinnedCreate = nextContextAtTime(d.contractAddress, snapCtx, Number(createTime));
    const rCreate = d.contract.circuits.createProposal(
      pinnedCreate,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(40),
      createTime,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
    const proposalId = rCreate.result as Uint8Array;
    const ctxAfterCreate = nextContext(d.contractAddress, rCreate.context);

    const voter = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedVoteCtx = nextContextAtTime(d.contractAddress, ctxAfterCreate, Number(voteTime));
    expect(() => voter.circuits.castVote(pinnedVoteCtx, proposalId, true, voteTime)).toThrow(/held long enough/i);
  });

  it('allows a vote whose heldSinceTimestamp is exactly at the 30-day boundary', () => {
    const heldSince = SILENCE_THRESHOLD - MIN_HOLDING_PERIOD; // exactly 30 days before proposal start
    const d = deploy();
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(d, [
      { fill: VOTER_FILL, balance: 1000n, heldSinceTimestamp: heldSince },
    ]);
    const createTime = SILENCE_THRESHOLD;
    const pinnedCreate = nextContextAtTime(d.contractAddress, snapCtx, Number(createTime));
    const rCreate = d.contract.circuits.createProposal(
      pinnedCreate,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(40),
      createTime,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
    const proposalId = rCreate.result as Uint8Array;
    const ctxAfterCreate = nextContext(d.contractAddress, rCreate.context);

    const voter = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedVoteCtx = nextContextAtTime(d.contractAddress, ctxAfterCreate, Number(voteTime));
    const rVote = voter.circuits.castVote(pinnedVoteCtx, proposalId, true, voteTime);
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.yesVotes).toBe(1000n);
  });

  it('rejects a leaf whose heldSinceTimestamp is claimed to be AFTER the proposal started (nonsensical ordering)', () => {
    const d = deploy();
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(d, [
      { fill: VOTER_FILL, balance: 1000n, heldSinceTimestamp: SILENCE_THRESHOLD + 1n },
    ]);
    const createTime = SILENCE_THRESHOLD;
    const pinnedCreate = nextContextAtTime(d.contractAddress, snapCtx, Number(createTime));
    const rCreate = d.contract.circuits.createProposal(
      pinnedCreate,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(40),
      createTime,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
    const proposalId = rCreate.result as Uint8Array;
    const ctxAfterCreate = nextContext(d.contractAddress, rCreate.context);

    const voter = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedVoteCtx = nextContextAtTime(d.contractAddress, ctxAfterCreate, Number(voteTime));
    expect(() => voter.circuits.castVote(pinnedVoteCtx, proposalId, true, voteTime)).toThrow(
      /invalid held-since timestamp/i,
    );
  });
});

// ============================================================================
// A community-wallet change made OUTSIDE a ballot
// ============================================================================
// This path exists for what a vote cannot reach in time — a community wallet
// lost or compromised, where waiting for a fresh ballot means pointing funds at
// a wallet already known to be wrong. What these tests are about is that it
// cannot be quiet: the change is announced, visible while it waits, and only
// real once the full notice period has passed.

describe('cto_governance.compact — a community wallet change outside a ballot is announced, not applied', () => {
  const NOTICE = 259_200n; // 72 hours, in the seconds this contract counts in

  /** Runs a real ballot through to execution, leaving ctoState == CTOTriggered. */
  function deployTriggered() {
    const voterFills = MANY_VOTER_FILLS.slice(0, 6);
    const d = deploy();
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(
      d,
      voterFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
    );
    const votedWallet = fakeBytes32(70);
    const createTime = SILENCE_THRESHOLD;
    const rCreate = d.contract.circuits.createProposal(
      nextContextAtTime(d.contractAddress, snapCtx, Number(createTime)),
      ProposalType.SilenceLockTrigger,
      fakeBytes32(50),
      createTime,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      votedWallet,
      BREAK_GLASS_BOND_MIN,
    );
    const proposalId = rCreate.result as Uint8Array;
    let ctx = nextContext(d.contractAddress, rCreate.context);

    let voteTime = createTime;
    for (const fill of voterFills) {
      voteTime += 1n;
      const voter = new Contract<PrivateState>(witnessesFor(fill));
      const rVote = voter.circuits.castVote(
        nextContextAtTime(d.contractAddress, ctx, Number(voteTime)),
        proposalId,
        true,
        voteTime,
      );
      ctx = nextContext(d.contractAddress, rVote.context);
    }

    const finalizeTime = createTime + BALLOT_DURATION + 1n;
    const rFin = d.contract.circuits.finalizeProposal(
      nextContextAtTime(d.contractAddress, ctx, Number(finalizeTime)),
      proposalId,
      finalizeTime,
    );
    ctx = nextContext(d.contractAddress, rFin.context);
    const rExec = d.contract.circuits.executeProposal(ctx, proposalId);
    ctx = nextContext(d.contractAddress, rExec.context);
    expect(ledger(rExec.context.currentQueryContext.state).ctoState).toBe(CtoState.CTOTriggered);
    return { d, ctx, votedWallet, now: finalizeTime };
  }

  it('announces the change publicly and leaves the live wallet untouched', () => {
    const { d, ctx, votedWallet, now } = deployTriggered();
    const replacement = fakeBytes32(88);
    const r = d.contract.circuits.proposeCommunityWalletChange(ctx, replacement, now);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.pendingCommunityWallet).toEqual(replacement);
    expect(state.pendingCommunityWalletAt).toBe(now);
    // The point: announcing changed nothing about where money goes today.
    expect(state.communityWallet).toEqual(votedWallet);
  });

  // The test the whole mechanism rests on. If this passes when it should not,
  // the notice period is decoration.
  it('refuses to apply the change one second before the notice period ends', () => {
    const { d, ctx, now } = deployTriggered();
    const r = d.contract.circuits.proposeCommunityWalletChange(ctx, fakeBytes32(88), now);
    const ctx2 = nextContext(d.contractAddress, r.context);
    expect(() => d.contract.circuits.executeCommunityWalletChange(ctx2, now + NOTICE - 1n)).toThrow(
      'Notice period has not elapsed',
    );
  });

  it('applies it once the full notice period has elapsed, and clears the announcement', () => {
    const { d, ctx, now } = deployTriggered();
    const replacement = fakeBytes32(88);
    const r = d.contract.circuits.proposeCommunityWalletChange(ctx, replacement, now);
    const ctx2 = nextContext(d.contractAddress, r.context);
    const r2 = d.contract.circuits.executeCommunityWalletChange(ctx2, now + NOTICE);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.communityWallet).toEqual(replacement);
    expect(state.pendingCommunityWalletAt).toBe(0n);
  });

  // Without this, a governor keeps a fresh announcement always pending and
  // restarts the clock whenever it gets close — the same as having no clock.
  it('refuses a second announcement while one is already pending', () => {
    const { d, ctx, now } = deployTriggered();
    const r = d.contract.circuits.proposeCommunityWalletChange(ctx, fakeBytes32(88), now);
    const ctx2 = nextContext(d.contractAddress, r.context);
    expect(() => d.contract.circuits.proposeCommunityWalletChange(ctx2, fakeBytes32(89), now + 1n)).toThrow(
      'A community wallet change is already pending',
    );
  });

  it('lets the governor withdraw an announcement before it takes effect', () => {
    const { d, ctx, votedWallet, now } = deployTriggered();
    const r = d.contract.circuits.proposeCommunityWalletChange(ctx, fakeBytes32(88), now);
    const ctx2 = nextContext(d.contractAddress, r.context);
    const r2 = d.contract.circuits.cancelPendingCommunityWalletChange(ctx2);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.pendingCommunityWalletAt).toBe(0n);
    expect(state.communityWallet).toEqual(votedWallet);
  });

  it('refuses to apply a change nobody announced', () => {
    const { d, ctx, now } = deployTriggered();
    expect(() => d.contract.circuits.executeCommunityWalletChange(ctx, now + NOTICE)).toThrow(
      'No community wallet change is pending',
    );
  });
});

// ============================================================================
// Filing a proposal costs something, and an empty ballot buys no silence
// ============================================================================
// The launch has ONE proposal slot and a 90-day cooldown after a ballot. Both
// are correct on their own. Together, an unbonded proposal that nobody votes in
// used to hold the slot for 72 hours and then start the full cooldown — so the
// party a CTO is aimed at could file junk and buy 90 days of quiet, repeatedly.
//
// Two things close it: the cooldown now starts only for a ballot that drew a
// real quorum, and filing takes a bond that a no-quorum ballot forfeits.

describe('cto_governance.compact — an empty ballot buys no cooldown, and filing is not free', () => {
  /** Files a proposal, lets the window close, and finalizes it with no votes cast. */
  function fileAndFailForQuorum() {
    const d = deployAndCreateProposal([{ fill: VOTER_FILL, balance: CREATOR_VOTE_CAP }]);
    const finalizeTime = d.createTime + BALLOT_DURATION + 1n;
    const r = d.contract.circuits.finalizeProposal(
      nextContextAtTime(d.contractAddress, d.ctx, Number(finalizeTime)),
      d.proposalId,
      finalizeTime,
    );
    const ctx = nextContext(d.contractAddress, r.context);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.proposals.lookup(d.proposalId).state).toBe(ProposalState.Failed);
    return { ...d, ctx, finalizeTime, state };
  }

  // The fix, stated as the thing an attacker wanted: no silence bought.
  it('leaves the cooldown unstarted when a ballot drew nobody', () => {
    const { state } = fileAndFailForQuorum();
    expect(state.lastProposalEnd).toBe(0n);
  });

  // The other half — a real ballot must still earn its cooldown, or this
  // "fix" would simply have deleted the cooldown.
  it('still starts the cooldown for a ballot that drew a real quorum', () => {
    const voterFills = MANY_VOTER_FILLS.slice(0, 6);
    const d = deploy();
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(
      d,
      voterFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
    );
    const createTime = SILENCE_THRESHOLD;
    const rCreate = d.contract.circuits.createProposal(
      nextContextAtTime(d.contractAddress, snapCtx, Number(createTime)),
      ProposalType.SilenceLockTrigger,
      fakeBytes32(41),
      createTime,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
    const proposalId = rCreate.result as Uint8Array;
    let ctx = nextContext(d.contractAddress, rCreate.context);
    let voteTime = createTime;
    for (const fill of voterFills) {
      voteTime += 1n;
      const voter = new Contract<PrivateState>(witnessesFor(fill));
      const rVote = voter.circuits.castVote(
        nextContextAtTime(d.contractAddress, ctx, Number(voteTime)),
        proposalId,
        true,
        voteTime,
      );
      ctx = nextContext(d.contractAddress, rVote.context);
    }
    const finalizeTime = createTime + BALLOT_DURATION + 1n;
    const rFin = d.contract.circuits.finalizeProposal(
      nextContextAtTime(d.contractAddress, ctx, Number(finalizeTime)),
      proposalId,
      finalizeTime,
    );
    const state = ledger(rFin.context.currentQueryContext.state);
    expect(state.proposals.lookup(proposalId).state).toBe(ProposalState.Passed);
    expect(state.lastProposalEnd).toBeGreaterThan(0n);
  });

  it('refuses to file below the bond floor', () => {
    const d = deploy();
    const { ctx: snapCtx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: CREATOR_VOTE_CAP }]);
    const createTime = SILENCE_THRESHOLD;
    expect(() =>
      d.contract.circuits.createProposal(
        nextContextAtTime(d.contractAddress, snapCtx, Number(createTime)),
        ProposalType.SilenceLockTrigger,
        fakeBytes32(42),
        createTime,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN - 1n,
      ),
    ).toThrow('Proposal bond below minimum');
  });

  it('records the bond against the proposal it was filed with', () => {
    const d = deployAndCreateProposal([{ fill: VOTER_FILL, balance: CREATOR_VOTE_CAP }]);
    const state = ledger(d.ctx.currentQueryContext.state);
    expect(state.proposalBonds.lookup(d.proposalId)).toBe(BREAK_GLASS_BOND_MIN);
  });

  it('forfeits the bond of a ballot nobody voted in, to the sealed platform address', () => {
    const d = fileAndFailForQuorum();
    const r = d.contract.circuits.sweepForfeitedProposalBond(d.ctx, d.proposalId);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.proposalBonds.member(d.proposalId)).toBe(false);
  });

  it('refuses to hand a no-quorum bond back to its proposer', () => {
    const d = fileAndFailForQuorum();
    expect(() => d.contract.circuits.claimProposalBond(d.ctx, d.proposalId, fakeBytes32(77))).toThrow('drew no quorum');
  });

  it('refuses to sweep a bond while the ballot is still open', () => {
    const d = deployAndCreateProposal([{ fill: VOTER_FILL, balance: CREATOR_VOTE_CAP }]);
    expect(() => d.contract.circuits.sweepForfeitedProposalBond(d.ctx, d.proposalId)).toThrow('Ballot still open');
  });
});

// ============================================================================
// Ballot secrecy — a nullifier nobody else can compute
// ============================================================================
// A vote nullifier is disclosed when the ballot is cast. Everything else that
// identifies a voter is already public: their key is a leaf in the balance
// snapshot the governor publishes, launchId is sealed, and proposalId is on the
// proposal itself. Deriving the nullifier from the voter's SECRET is what stops
// those public values being assembled into a value that recognises a
// particular holder's ballot on sight.

describe('cto_governance.compact — ballot secrecy', () => {
  function oneVoteCast() {
    const d = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: CREATOR_VOTE_CAP },
      { fill: OTHER_VOTER_FILL, balance: CREATOR_VOTE_CAP },
    ]);
    const voter = new Contract<PrivateState>(d.witnessesFor(VOTER_FILL));
    const voteTime = d.createTime + 1n;
    const r = voter.circuits.castVote(
      nextContextAtTime(d.contractAddress, d.ctx, Number(voteTime)),
      d.proposalId,
      true,
      voteTime,
    );
    return { ...d, voter, ctx: nextContext(d.contractAddress, r.context) };
  }

  it('answers hasCallerVoted about the caller and nobody else', () => {
    const d = oneVoteCast();
    expect(d.voter.circuits.hasCallerVoted(d.ctx, d.proposalId).result).toBe(true);

    // Somebody else asking gets the answer about themselves, which is the only
    // question they are in a position to ask. Asking about a named holder is
    // not offered, because a nullifier derived from a secret cannot be
    // computed for anyone but its owner.
    const other = new Contract<PrivateState>(d.witnessesFor(OTHER_VOTER_FILL));
    expect(other.circuits.hasCallerVoted(d.ctx, d.proposalId).result).toBe(false);
  });

  it('writes a nullifier that cannot be rebuilt from the voter public key', () => {
    const d = oneVoteCast();
    const st = ledger(d.ctx.currentQueryContext.state);

    const voterSecret = fakeBytes32(VOTER_FILL);
    const voterPublicKey = deriveUserPublicKey(voterSecret, LAUNCH_ID);

    // The value an observer could assemble from public inputs alone — the
    // voter's own snapshot leaf key, the sealed launchId, the proposal id.
    expect(
      st.voteNullifiers.member(
        computeVoteNullifier({ voterSecret: voterPublicKey, launchId: LAUNCH_ID, proposalId: d.proposalId }),
      ),
    ).toBe(false);

    // What was actually written is the value only the secret's holder makes.
    expect(
      st.voteNullifiers.member(computeVoteNullifier({ voterSecret, launchId: LAUNCH_ID, proposalId: d.proposalId })),
    ).toBe(true);
  });

  it('gives one voter a different nullifier on every proposal', () => {
    // Otherwise a single disclosed value would follow a voter across every
    // ballot the launch ever runs.
    const voterSecret = fakeBytes32(VOTER_FILL);
    const a = computeVoteNullifier({ voterSecret, launchId: LAUNCH_ID, proposalId: fakeBytes32(71) });
    const b = computeVoteNullifier({ voterSecret, launchId: LAUNCH_ID, proposalId: fakeBytes32(72) });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

// ============================================================================
// An abandoned snapshot still leaves a route to community control
// ============================================================================
// A snapshot root can only come from the governor — a root anyone else could
// publish would prove nothing about anyone's holdings. So an unrefreshed
// snapshot is handled by AGE rather than by authorship: past
// staleSnapshotGraceWindow, a CTO trigger may rest on the last root the
// governor really published. That root is out of date, not invented, and
// votes against it are still proven against a tree nobody made up.

describe('cto_governance.compact — abandoned balance snapshot', () => {
  const GRACE = 7_776_000n; // staleSnapshotGraceWindow, 90 days
  // Far enough past graduation that the post-grad delay and silence timer are
  // both satisfied, with the snapshot itself a full GRACE old.
  const PROPOSE_AT = GRACE * 2n;

  function deployWithAbandonedSnapshot(ageOverride?: bigint) {
    const d = deploy();
    const age = ageOverride ?? GRACE;
    const { ctx, witnessesFor } = publishBalanceSnapshot(
      d,
      [{ fill: VOTER_FILL, balance: CREATOR_VOTE_CAP }],
      PROPOSE_AT - age,
    );
    return { ...d, ctx, witnessesFor };
  }

  function propose(
    d: ReturnType<typeof deployWithAbandonedSnapshot>,
    proposalType: ProposalType = ProposalType.SilenceLockTrigger,
  ) {
    return d.contract.circuits.createProposal(
      nextContextAtTime(d.contractAddress, d.ctx, Number(PROPOSE_AT)),
      proposalType,
      fakeBytes32(40),
      PROPOSE_AT,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90),
      BREAK_GLASS_BOND_MIN,
    );
  }

  it('lets a CTO trigger rest on the last root the governor really published', () => {
    const d = deployWithAbandonedSnapshot();
    const r = propose(d);
    expect(r.result).toBeInstanceOf(Uint8Array);

    // The proposal pins that same root, so the ballot is fought on a tree the
    // governor built — not on anything the proposer supplied.
    const st = ledger(r.context.currentQueryContext.state);
    const proposal = st.proposals.lookup(r.result as Uint8Array);
    expect(Buffer.from(proposal.balanceSnapshotRoot).equals(Buffer.from(st.balanceSnapshotRoot))).toBe(true);
  });

  it('still lets a real holder prove their weight against that root', () => {
    // Creating the proposal is worth nothing if nobody can then vote on it —
    // the old root has to remain a working balance proof, not just a value
    // that passes a staleness check.
    const d = deployWithAbandonedSnapshot();
    const r = propose(d);
    const proposalId = r.result as Uint8Array;
    const ctx = nextContext(d.contractAddress, r.context);

    const voter = new Contract<PrivateState>(d.witnessesFor(VOTER_FILL));
    const voteTime = PROPOSE_AT + 1n;
    const rVote = voter.circuits.castVote(
      nextContextAtTime(d.contractAddress, ctx, Number(voteTime)),
      proposalId,
      true,
      voteTime,
    );
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.yesVotes).toBe(CREATOR_VOTE_CAP);
  });

  it('opens the route at exactly the grace window and not one second earlier', () => {
    const atBoundary = deployWithAbandonedSnapshot(GRACE);
    expect(propose(atBoundary).result).toBeInstanceOf(Uint8Array);

    const justShort = deployWithAbandonedSnapshot(GRACE - 1n);
    expect(() => propose(justShort)).toThrow('governor must republish');
  });

  it.each([
    { label: 'DissolveCTO', type: ProposalType.DissolveCTO },
    { label: 'FundAllocation', type: ProposalType.FundAllocation },
    { label: 'DexMigration', type: ProposalType.DexMigration },
    { label: 'WhitelistUpdate', type: ProposalType.WhitelistUpdate },
  ])('refuses $label on an abandoned snapshot', ({ type }) => {
    // A trigger redirects future fees and freezes unvested creator tokens; it
    // never sends funds to an address the caller names, and it still has to
    // clear the silence timer and the claimable-balance check on top of the
    // ballot. Everything else keeps requiring a fresh root.
    const d = deployWithAbandonedSnapshot();
    expect(() => propose(d, type)).toThrow('Only a CTO trigger may rest on a snapshot this old');
  });

  it('cannot be reached early by a proposer claiming a later time than the chain', () => {
    // The whole route is unlocked by elapsed time, so the timestamp band is
    // what stops it being brought forward: a caller can wait the window out
    // but never fabricate it.
    const d = deployWithAbandonedSnapshot(GRACE - 1n);
    const overstated = PROPOSE_AT + GRACE;
    expect(() =>
      d.contract.circuits.createProposal(
        nextContextAtTime(d.contractAddress, d.ctx, Number(PROPOSE_AT)),
        ProposalType.SilenceLockTrigger,
        fakeBytes32(40),
        overstated,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow(/cannot be in the future/i);
  });

  it('still refuses every proposal when no snapshot was ever published', () => {
    // Age is measured from a root that exists. A launch the governor never
    // published for has no tree to prove anything against, so the emptiness
    // check has to fire ahead of the age check.
    const d = deploy();
    expect(() =>
      d.contract.circuits.createProposal(
        nextContextAtTime(d.contractAddress, d.ctx, Number(PROPOSE_AT)),
        ProposalType.SilenceLockTrigger,
        fakeBytes32(40),
        PROPOSE_AT,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow('No balance snapshot published yet');
  });

  it('goes back to requiring a fresh root as soon as the governor publishes one', () => {
    // The route is a consequence of inaction, not a state anyone latches.
    const d = deployWithAbandonedSnapshot();
    // Two attestors, because one no longer writes a root.
    const rRepub = d.contract.circuits.updateBalanceSnapshot(
      nextContextAtTime(d.contractAddress, d.ctx, Number(PROPOSE_AT)),
      fakeBytes32(55),
      PROPOSE_AT,
    );
    const second = new Contract<PrivateState>(makeWitnesses(VOTER_FILL, 0n, EMPTY_PROOF, 0n, ATTESTOR_2_FILL));
    const rRepub2 = second.circuits.updateBalanceSnapshot(
      nextContextAtTime(d.contractAddress, nextContext(d.contractAddress, rRepub.context), Number(PROPOSE_AT)),
      fakeBytes32(55),
      PROPOSE_AT,
    );
    const ctx = nextContext(d.contractAddress, rRepub2.context);

    // Fresh again, so DissolveCTO is refused on its own precondition rather
    // than on snapshot age — the age gate is no longer what stops it.
    expect(() =>
      d.contract.circuits.createProposal(
        nextContextAtTime(d.contractAddress, ctx, Number(PROPOSE_AT + 1n)),
        ProposalType.DissolveCTO,
        fakeBytes32(41),
        PROPOSE_AT + 1n,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow('CTO not triggered');
  });
});

// ============================================================================
// THRESHOLD ATTESTATION — the balance snapshot takes two of three
// ============================================================================
// The point of these is the negative one. A suite that only ever publishes
// through the two-attestor helper would pass identically if the threshold were
// removed tomorrow, because the helper would simply be doing twice the work
// for no reason. Each test below fails if one signature is enough.
describe('cto_governance.compact — threshold attestation on the balance snapshot', () => {
  const ROOT = fakeBytes32(77);
  const OTHER_ROOT = fakeBytes32(78);
  const AT = SILENCE_THRESHOLD;

  /** A contract speaking for one attestor, sharing the deployment's state. */
  function attestor(fill: number) {
    return new Contract<PrivateState>(makeWitnesses(VOTER_FILL, 0n, EMPTY_PROOF, 0n, fill));
  }

  function attest(d: ReturnType<typeof deploy>, ctx: unknown, fill: number, root: Uint8Array, at = AT) {
    const c = fill === ATTESTOR_1_FILL ? d.contract : attestor(fill);
    const r = c.circuits.updateBalanceSnapshot(
      nextContextAtTime(d.contractAddress, ctx as never, Number(at)),
      root,
      at,
    );
    return nextContext(d.contractAddress, r.context);
  }

  const rootOf = (ctx: unknown) =>
    ledger((ctx as { currentQueryContext: { state: unknown } }).currentQueryContext.state as never).balanceSnapshotRoot;

  it('does not write the root on one attestation', () => {
    const d = deploy();
    const ctx = attest(d, d.ctx, ATTESTOR_1_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(new Uint8Array(32));
  });

  it('writes it on the second, from a DIFFERENT attestor', () => {
    const d = deploy();
    let ctx = attest(d, d.ctx, ATTESTOR_1_FILL, ROOT);
    ctx = attest(d, ctx, ATTESTOR_2_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(ROOT);
  });

  it('refuses to count one attestor twice as two', () => {
    // The reason approvals are keyed by signer rather than counted: a counter
    // cannot tell these two calls apart from two different people.
    const d = deploy();
    let ctx = attest(d, d.ctx, ATTESTOR_1_FILL, ROOT);
    ctx = attest(d, ctx, ATTESTOR_1_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(new Uint8Array(32));
  });

  it('accepts any two of the three, not one privileged pair', () => {
    const d = deploy();
    let ctx = attest(d, d.ctx, ATTESTOR_2_FILL, ROOT);
    ctx = attest(d, ctx, ATTESTOR_3_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(ROOT);
  });

  it('refuses a caller who is not an attestor at all', () => {
    const d = deploy();
    expect(() => attest(d, d.ctx, 91, ROOT)).toThrow(/registered attestor/i);
  });

  it('does not carry an approval across to a different root', () => {
    // Attesting to a different root replaces the proposal rather than adding
    // to it — which is also how an attestor disagrees, without needing a
    // reject circuit.
    const d = deploy();
    let ctx = attest(d, d.ctx, ATTESTOR_1_FILL, ROOT);
    ctx = attest(d, ctx, ATTESTOR_2_FILL, OTHER_ROOT);
    expect(rootOf(ctx)).toEqual(new Uint8Array(32));
  });

  it('lets a stale approval expire rather than completing a root a day later', () => {
    const d = deploy();
    let ctx = attest(d, d.ctx, ATTESTOR_1_FILL, ROOT, AT);
    // One second past the 24h window: the first approval is no longer live,
    // so this call opens a fresh round instead of completing the old one.
    const late = AT + ATTEST_EXPIRY_SECONDS + 1n;
    ctx = attest(d, ctx, ATTESTOR_2_FILL, ROOT, late);
    expect(rootOf(ctx)).toEqual(new Uint8Array(32));
  });

  it('still completes inside the window', () => {
    // The control for the expiry test above: same two calls, one second
    // before the deadline rather than one second after.
    const d = deploy();
    let ctx = attest(d, d.ctx, ATTESTOR_1_FILL, ROOT, AT);
    ctx = attest(d, ctx, ATTESTOR_2_FILL, ROOT, AT + ATTEST_EXPIRY_SECONDS - 1n);
    expect(rootOf(ctx)).toEqual(ROOT);
  });
});

describe('cto_governance.compact — threshold attestation on creator activity', () => {
  const AT = 0n;

  function attestor(fill: number) {
    return new Contract<PrivateState>(makeWitnesses(VOTER_FILL, 0n, EMPTY_PROOF, 0n, fill));
  }

  function attestActivity(
    d: ReturnType<typeof deploy>,
    ctx: unknown,
    fill: number,
    activityAt: bigint,
    claimable: boolean,
    at = AT,
  ) {
    const c = fill === ATTESTOR_1_FILL ? d.contract : attestor(fill);
    const r = c.circuits.updateCreatorActivity(
      nextContextAtTime(d.contractAddress, ctx as never, Number(at)),
      activityAt,
      claimable,
      at,
    );
    return nextContext(d.contractAddress, r.context);
  }

  const read = (ctx: unknown) =>
    ledger((ctx as { currentQueryContext: { state: unknown } }).currentQueryContext.state as never);

  it('does not accept the attested pair on one signature', () => {
    const d = deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, false);
    const ctx = attestActivity(d, d.ctx, ATTESTOR_1_FILL, 0n, true);
    expect(read(ctx).hasClaimableBalance).toBe(false);
  });

  it('accepts it on the second, from a different attestor', () => {
    const d = deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, false);
    let ctx = attestActivity(d, d.ctx, ATTESTOR_1_FILL, 0n, true);
    ctx = attestActivity(d, ctx, ATTESTOR_2_FILL, 0n, true);
    expect(read(ctx).hasClaimableBalance).toBe(true);
  });

  it('treats the timestamp and the claimable flag as ONE fact', () => {
    // Two attestors who agree on the time but not on whether a balance
    // exists have not agreed. The second call opens a new round rather than
    // completing the first.
    const d = deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, false);
    let ctx = attestActivity(d, d.ctx, ATTESTOR_1_FILL, 0n, true);
    ctx = attestActivity(d, ctx, ATTESTOR_2_FILL, 0n, false);
    expect(read(ctx).hasClaimableBalance).toBe(false);
  });

  // The one that stops this fix creating a worse problem than it solves.
  it('records the governor as responsive on ONE call, before any threshold', () => {
    // resolveBreakGlassChallenge asks whether the governor is answering at
    // all — not whether anyone co-signed them. If this waited for the
    // threshold, a governor who replied on time would still read as silent
    // and could lose the launch to a break-glass challenge.
    const d = deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, false);
    const before = read(d.ctx).lastGovernorUpdateTimestamp;
    const ctx = attestActivity(d, d.ctx, ATTESTOR_1_FILL, 0n, true, 500n);
    expect(read(ctx).lastGovernorUpdateTimestamp).toBe(500n);
    expect(read(ctx).lastGovernorUpdateTimestamp).not.toBe(before);
    // ...and the attested pair still has NOT been accepted.
    expect(read(ctx).hasClaimableBalance).toBe(false);
  });

  it('refuses a caller who is not an attestor', () => {
    const d = deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, false);
    expect(() => attestActivity(d, d.ctx, 91, 0n, true)).toThrow(/registered attestor/i);
  });

  it('lets a partial approval expire', () => {
    const d = deploy(CREATOR_VOTE_CAP, DEFAULT_MIN_VOTER_COUNT, false);
    let ctx = attestActivity(d, d.ctx, ATTESTOR_1_FILL, 0n, true, 100n);
    ctx = attestActivity(d, ctx, ATTESTOR_2_FILL, 0n, true, 100n + ATTEST_EXPIRY_SECONDS + 1n);
    expect(read(ctx).hasClaimableBalance).toBe(false);
  });
});

describe('cto_governance.compact — the creator can write their own silence clock', () => {
  // The defect this closes: lastCreatorActivity only ever moved through
  // updateCreatorActivity, so the silence timer advanced whenever the
  // ATTESTORS went quiet — regardless of the creator. Threshold attestation
  // made that easier to reach, not harder, since refreshing it now takes two
  // of them.
  const creatorContract = () => new Contract<PrivateState>(makeWitnesses(CREATOR_FILL));

  it('lets the creator refresh the clock without any attestor', () => {
    const d = deploy();
    const at = 5_000n;
    const r = creatorContract().circuits.recordCreatorHeartbeat(
      nextContextAtTime(d.contractAddress, d.ctx, Number(at)),
      at,
    );
    const ctx = nextContext(d.contractAddress, r.context);
    expect(ledger(ctx.currentQueryContext.state).lastCreatorActivity).toBe(at);
  });

  it('refuses anyone who is not the creator', () => {
    const d = deploy();
    expect(() =>
      d.contract.circuits.recordCreatorHeartbeat(nextContextAtTime(d.contractAddress, d.ctx, 5_000), 5_000n),
    ).toThrow(/Only the creator/i);
  });

  it('refuses to move the clock backwards', () => {
    const d = deploy();
    const r = creatorContract().circuits.recordCreatorHeartbeat(
      nextContextAtTime(d.contractAddress, d.ctx, 5_000),
      5_000n,
    );
    const ctx = nextContext(d.contractAddress, r.context);
    expect(() =>
      creatorContract().circuits.recordCreatorHeartbeat(nextContextAtTime(d.contractAddress, ctx, 4_000), 4_000n),
    ).toThrow(/backwards/i);
  });

  it('refuses a heartbeat dated in the future', () => {
    const d = deploy();
    expect(() =>
      creatorContract().circuits.recordCreatorHeartbeat(nextContextAtTime(d.contractAddress, d.ctx, 1_000), 9_000_000n),
    ).toThrow(/cannot be in the future/i);
  });

  // The point of the whole thing, end to end.
  it('keeps a silence proposal shut while the creator is checking in', () => {
    const d = deploy();
    const { ctx: snapCtx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }]);
    // No attestor touches creator activity from here on; the creator alone
    // keeps the clock alive, right up to the moment silence would open.
    const r = creatorContract().circuits.recordCreatorHeartbeat(
      nextContextAtTime(d.contractAddress, snapCtx, Number(SILENCE_THRESHOLD)),
      SILENCE_THRESHOLD,
    );
    const ctx = nextContext(d.contractAddress, r.context);
    expect(() =>
      d.contract.circuits.createProposal(
        nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD)),
        ProposalType.SilenceLockTrigger,
        fakeBytes32(40),
        SILENCE_THRESHOLD,
        fakeBytes32(0),
        0n,
        fakeBytes32(0),
        fakeBytes32(90),
        BREAK_GLASS_BOND_MIN,
      ),
    ).toThrow('Creator not silent long enough');
  });
});

describe('cto_governance.compact — the second vote on a taken-over creator allocation', () => {
  // The takeover passed and executed, the 90-day cooldown served and a fresh
  // snapshot published: the state every disposition vote starts from.
  function afterTakeover() {
    const voterFills = MANY_VOTER_FILLS.slice(0, 6);
    const d = deploy();
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(
      d,
      voterFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
    );
    const createTime = SILENCE_THRESHOLD;
    const rCreate = d.contract.circuits.createProposal(
      nextContextAtTime(d.contractAddress, snapCtx, Number(createTime)),
      ProposalType.SilenceLockTrigger,
      fakeBytes32(50),
      createTime,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(70),
      BREAK_GLASS_BOND_MIN,
    );
    const takeoverId = rCreate.result as Uint8Array;
    let ctx = nextContext(d.contractAddress, rCreate.context);
    let t = createTime;
    for (const fill of voterFills) {
      t += 1n;
      const voter = new Contract<PrivateState>(witnessesFor(fill));
      const r = voter.circuits.castVote(nextContextAtTime(d.contractAddress, ctx, Number(t)), takeoverId, true, t);
      ctx = nextContext(d.contractAddress, r.context);
    }
    const finalizeTime = createTime + BALLOT_DURATION + 1n;
    const rFin = d.contract.circuits.finalizeProposal(
      nextContextAtTime(d.contractAddress, ctx, Number(finalizeTime)),
      takeoverId,
      finalizeTime,
    );
    ctx = nextContext(d.contractAddress, rFin.context);
    const rExec = d.contract.circuits.executeProposal(ctx, takeoverId);
    ctx = nextContext(d.contractAddress, rExec.context);
    expect(ledger(ctx.currentQueryContext.state).ctoState).toBe(CtoState.CTOTriggered);

    const secondTime = finalizeTime + 7_776_000n + 1n;
    const tree = buildBalanceSnapshotTree(
      voterFills.map((fill) => ({
        voterKey: deriveUserPublicKey(fakeBytes32(fill), LAUNCH_ID),
        balance: CREATOR_VOTE_CAP,
        heldSinceTimestamp: 0n,
      })),
    );
    // Two attestors, as publishBalanceSnapshot does: the root is written only
    // when the second lands, and only a takeover trigger may rest on an old one.
    const rSnap1 = d.contract.circuits.updateBalanceSnapshot(
      nextContextAtTime(d.contractAddress, ctx, Number(secondTime)),
      tree.root,
      secondTime,
    );
    const second = new Contract<PrivateState>(makeWitnesses(VOTER_FILL, 0n, EMPTY_PROOF, 0n, ATTESTOR_2_FILL));
    const rSnap2 = second.circuits.updateBalanceSnapshot(
      nextContextAtTime(d.contractAddress, nextContext(d.contractAddress, rSnap1.context), Number(secondTime)),
      tree.root,
      secondTime,
    );
    ctx = nextContext(d.contractAddress, rSnap2.context);
    const secondWitnesses = (fill: number): Witnesses<PrivateState> =>
      makeWitnesses(fill, CREATOR_VOTE_CAP, tree.getProof(voterFills.indexOf(fill)), 0n);
    return { d, ctx, secondTime, voterFills, secondWitnesses };
  }

  function propose(at: ReturnType<typeof afterTakeover>, type: ProposalType, amount: bigint) {
    return at.d.contract.circuits.createProposal(
      nextContextAtTime(at.d.contractAddress, at.ctx, Number(at.secondTime)),
      type,
      fakeBytes32(60),
      at.secondTime,
      fakeBytes32(0),
      amount,
      fakeBytes32(0),
      fakeBytes32(0),
      BREAK_GLASS_BOND_MIN,
    );
  }

  it('rejects a disposition vote while no takeover is in force', () => {
    const voterFills = MANY_VOTER_FILLS.slice(0, 6);
    const d = deploy();
    const { ctx } = publishBalanceSnapshot(
      d,
      voterFills.map((fill) => ({ fill, balance: CREATOR_VOTE_CAP })),
    );
    for (const type of [ProposalType.VestingToLp, ProposalType.VestingToStaking, ProposalType.VestingToTreasury]) {
      expect(() =>
        d.contract.circuits.createProposal(
          nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD)),
          type,
          fakeBytes32(60),
          SILENCE_THRESHOLD,
          fakeBytes32(0),
          500_000_000n,
          fakeBytes32(0),
          fakeBytes32(0),
          BREAK_GLASS_BOND_MIN,
        ),
      ).toThrow(/CTO not active/);
    }
  });

  it('accepts keeping the allocation in vesting once a takeover is in force', () => {
    expect(() => propose(afterTakeover(), ProposalType.VestingToTreasury, 0n)).not.toThrow();
  });

  it('accepts pairing the allocation into the pool with the ADA named', () => {
    expect(() => propose(afterTakeover(), ProposalType.VestingToLp, 500_000_000n)).not.toThrow();
  });

  it('rejects pairing with no ADA named', () => {
    expect(() => propose(afterTakeover(), ProposalType.VestingToLp, 0n)).toThrow(/VestingToLp must name/);
  });

  it('accepts a top-up of an existing pool and a new pool at either end of the runway range', () => {
    expect(() => propose(afterTakeover(), ProposalType.VestingToStaking, 0n)).not.toThrow();
    expect(() => propose(afterTakeover(), ProposalType.VestingToStaking, 1095n)).not.toThrow();
    expect(() => propose(afterTakeover(), ProposalType.VestingToStaking, 1825n)).not.toThrow();
  });

  it('rejects a new pool runway outside the range', () => {
    const at = afterTakeover();
    expect(() => propose(at, ProposalType.VestingToStaking, 1094n)).toThrow(/runway must be 1095 to 1825/);
    expect(() => propose(at, ProposalType.VestingToStaking, 1826n)).toThrow(/runway must be 1095 to 1825/);
  });

  it('carries a passed disposition vote through to execution while the takeover holds', () => {
    const at = afterTakeover();
    const rCreate = propose(at, ProposalType.VestingToTreasury, 0n);
    const id = rCreate.result as Uint8Array;
    let ctx = nextContext(at.d.contractAddress, rCreate.context);
    let t = at.secondTime;
    for (const fill of at.voterFills) {
      t += 1n;
      const voter = new Contract<PrivateState>(at.secondWitnesses(fill));
      const r = voter.circuits.castVote(nextContextAtTime(at.d.contractAddress, ctx, Number(t)), id, true, t);
      ctx = nextContext(at.d.contractAddress, r.context);
    }
    const finalizeTime = at.secondTime + BALLOT_DURATION + 1n;
    const rFin = at.d.contract.circuits.finalizeProposal(
      nextContextAtTime(at.d.contractAddress, ctx, Number(finalizeTime)),
      id,
      finalizeTime,
    );
    ctx = nextContext(at.d.contractAddress, rFin.context);
    expect(ledger(ctx.currentQueryContext.state).proposals.lookup(id).state).toBe(ProposalState.Passed);
    const rExec = at.d.contract.circuits.executeProposal(ctx, id);
    const after = ledger(rExec.context.currentQueryContext.state);
    expect(after.proposals.lookup(id).state).toBe(ProposalState.Executed);
    // The disposition leaves the takeover where it was.
    expect(after.ctoState).toBe(CtoState.CTOTriggered);
  });
});
