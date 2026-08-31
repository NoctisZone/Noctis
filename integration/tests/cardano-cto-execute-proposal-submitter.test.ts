// Tests for cardano-cto-execute-proposal-submitter.ts's
// CardanoCtoExecuteProposalSubmitter — applies a passed, anchored
// proposal's real consequences once the 24h challenge window has elapsed
// unvoided. Same importOriginal partial-mock strategy as the other Lucid
// submitter tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return {
    ...actual,
    Lucid: vi.fn(),
    Data: {
      ...actual.Data,
      from: vi.fn((d: unknown) => d),
      to: vi.fn((d: unknown) => d),
    },
  };
});

import { Lucid } from '@lucid-evolution/lucid';
import { toHex } from '../cardano-cto-anchor-submitter.js';
import { CardanoCtoExecuteProposalSubmitter } from '../cardano-cto-execute-proposal-submitter.js';
import { threadNftAssetName } from '../tier-a-schemas.js';

function fakeBytes(fill: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

function makeFakeTxBuilder(cborResult = 'execute-proposal-tx-1') {
  const calls: Record<string, unknown[]> = {};
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
    return builder;
  });
  builder.attach = {
    SpendingValidator: vi.fn((...a: unknown[]) => {
      calls.attachSpendingValidator = a;
      return builder;
    }),
  };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      calls.payToContract = a;
      return builder;
    }),
  };
  builder.validFrom = vi.fn((...a: unknown[]) => {
    calls.validFrom = a;
    return builder;
  });
  builder.validTo = vi.fn((...a: unknown[]) => {
    calls.validTo = a;
    return builder;
  });
  builder.complete = vi.fn().mockResolvedValue({
    sign: {
      withPrivateKey: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue(cborResult),
        }),
      }),
    },
  });
  return { builder, calls };
}

const LAUNCH_ID_BYTES = new TextEncoder().encode('launch-cto-exec-1');
const LAUNCH_ID_HEX = toHex(LAUNCH_ID_BYTES);
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('ctoGovernance', LAUNCH_ID_HEX);
// A real UTXO always has a reference, and settlement outputs are tagged with
// it — a fixture without one describes a UTXO the chain cannot produce, and
// hides every code path that reads it.
const withThreadNft = <T extends { assets?: Record<string, bigint> }>(list: T[]): T[] =>
  list.map((u, i) => ({
    txHash: 'fe'.repeat(32),
    outputIndex: i,
    ...u,
    assets: { [THREAD_UNIT]: 1n, ...(u.assets ?? {}) },
  }));

const ANCHOR_TS = 1_000_000n;
const CHALLENGE_WINDOW_MS = 86_400_000n;
const EXECUTION_WINDOW_MS = 2_592_000_000n;

function baseProposal(overrides: Record<string, unknown> = {}) {
  return {
    proposal_type: 'FundAllocation',
    description_hash: toHex(fakeBytes(20)),
    proof_bundle_hash: toHex(fakeBytes(21)),
    yes_votes: 60_000n,
    no_votes: 10_000n,
    voter_count: 20n,
    creator_yes_votes: 0n,
    creator_no_votes: 0n,
    outcome: 'Passed',
    start_timestamp: 0n,
    end_timestamp: ANCHOR_TS,
    anchor_timestamp: ANCHOR_TS,
    execution_status: 'PendingExecution',
    target_dex_credential: null,
    allocation_amount: 0n,
    allocation_recipient_hash: toHex(fakeBytes(22)),
    relayer_credential_hash: toHex(fakeBytes(23)),
    ...overrides,
  };
}

function baseDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    cto_state: 'PreCTO',
    community_wallet_hash: toHex(fakeBytes(1)),
    governor_credential_hash: toHex(fakeBytes(2)),
    total_supply: 1_000_000_000n,
    quorum_bps: 500n,
    creator_vote_cap_bps: 100n,
    min_voter_count: 15n,
    active_proposal: baseProposal(),
    proposal_count: 1n,
    last_executed_proposal: null,
    pending_relayer_bond: 25_000_000n,
    pending_relayer_key_hash: toHex(fakeBytes(3)),
    payout_pub_key_hash: toHex(fakeBytes(4)),
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  utxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
) {
  const fakeLucid = {
    selectWallet: { fromPrivateKey: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(withThreadNft(utxos)),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return new CardanoCtoExecuteProposalSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    compiledScriptCbor: '590000',
    callerPrivateKey: 'ed25519_sk1fakefakefake',
    launchId: LAUNCH_ID_BYTES,
    threadNftPolicyId: THREAD_POLICY,
  });
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

const WITHIN_WINDOW_TS = ANCHOR_TS + CHALLENGE_WINDOW_MS + 1n;

describe('CardanoCtoExecuteProposalSubmitter.executeProposal — guard rails', () => {
  it('throws when active_proposal is null', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ active_proposal: null }), assets: {} }]);
    await expect(submitter.executeProposal(WITHIN_WINDOW_TS)).rejects.toThrow(/nothing to execute/);
  });

  it("throws when the proposal's outcome is Failed", async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ active_proposal: baseProposal({ outcome: 'Failed' }) }), assets: {} },
    ]);
    await expect(submitter.executeProposal(WITHIN_WINDOW_TS)).rejects.toThrow(/not 'Passed'/);
  });

  it('throws when the proposal is already Executed', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ active_proposal: baseProposal({ execution_status: 'Executed' }) }), assets: {} },
    ]);
    await expect(submitter.executeProposal(WITHIN_WINDOW_TS)).rejects.toThrow(/not 'PendingExecution'/);
  });

  it('throws when called before the 24h challenge window has elapsed', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);
    const tooEarly = ANCHOR_TS + CHALLENGE_WINDOW_MS - 1n;
    await expect(submitter.executeProposal(tooEarly)).rejects.toThrow(/outside the real executable window/);
  });

  it('throws when called after the 30-day execution window has passed', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);
    const tooLate = ANCHOR_TS + EXECUTION_WINDOW_MS + 1n;
    await expect(submitter.executeProposal(tooLate)).rejects.toThrow(/outside the real executable window/);
  });

  it('accepts a timestamp exactly at the challenge-window boundary', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);
    const exact = ANCHOR_TS + CHALLENGE_WINDOW_MS;
    await expect(submitter.executeProposal(exact)).resolves.toEqual({ txHash: 'execute-proposal-tx-1' });
  });
});

describe('CardanoCtoExecuteProposalSubmitter.executeProposal — happy path', () => {
  it('marks the proposal Executed and records it as last_executed_proposal, leaving cto_state untouched for a non-SilenceLock/DissolveCTO proposal type', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ active_proposal: baseProposal({ proposal_type: 'FundAllocation' }), cto_state: 'PreCTO' }),
        assets: {},
      },
    ]);

    await submitter.executeProposal(WITHIN_WINDOW_TS);

    const [, payload] = calls.payToContract as [string, { value: Record<string, unknown> }];
    expect(payload.value.cto_state).toBe('PreCTO');
    const active = payload.value.active_proposal as Record<string, unknown>;
    const lastExecuted = payload.value.last_executed_proposal as Record<string, unknown>;
    expect(active.execution_status).toBe('Executed');
    expect(lastExecuted.execution_status).toBe('Executed');
  });

  it('flips cto_state to CTOTriggered and sets community_wallet_hash for a SilenceLockTrigger proposal', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const recipient = toHex(fakeBytes(99));
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          active_proposal: baseProposal({ proposal_type: 'SilenceLockTrigger', allocation_recipient_hash: recipient }),
          cto_state: 'PreCTO',
        }),
        assets: {},
      },
    ]);

    await submitter.executeProposal(WITHIN_WINDOW_TS);

    const [, payload] = calls.payToContract as [string, { value: Record<string, unknown> }];
    expect(payload.value.cto_state).toBe('CTOTriggered');
    expect(payload.value.community_wallet_hash).toBe(recipient);
  });

  it('flips cto_state to CTODissolved and clears community_wallet_hash for a DissolveCTOProposal', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          active_proposal: baseProposal({ proposal_type: 'DissolveCTOProposal' }),
          cto_state: 'CTOTriggered',
          community_wallet_hash: toHex(fakeBytes(50)),
        }),
        assets: {},
      },
    ]);

    await submitter.executeProposal(WITHIN_WINDOW_TS);

    const [, payload] = calls.payToContract as [string, { value: Record<string, unknown> }];
    expect(payload.value.cto_state).toBe('CTODissolved');
    expect(payload.value.community_wallet_hash).toBe('');
  });

  it('does not move any value — continuing output keeps the exact same assets as the input', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: { lovelace: 27_000_000n } }]);

    await submitter.executeProposal(WITHIN_WINDOW_TS);

    const [, , assetsArg] = calls.payToContract as [string, unknown, Record<string, bigint>];
    expect(assetsArg.lovelace).toBe(27_000_000n);
  });

  it('builds the redeemer as a raw Constr at index 1 with the current_timestamp', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.executeProposal(WITHIN_WINDOW_TS);

    const redeemer = calls.collectFrom![1] as { index: number; fields: unknown[] };
    expect(redeemer.index).toBe(1);
    expect(redeemer.fields).toEqual([WITHIN_WINDOW_TS]);
  });
});
