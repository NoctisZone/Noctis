// Tests for cardano-cto-void-proposal-submitter.ts's
// CardanoCtoVoidProposalSubmitter — governor voids a fraudulent anchored
// proposal within the 24h challenge window and slashes the relayer's bond
// the whole bond to one payee. Same importOriginal partial-mock strategy as the
// other Lucid submitter tests.

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

import { credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { toHex } from '../cardano-cto-anchor-submitter.js';
import { CardanoCtoVoidProposalSubmitter } from '../cardano-cto-void-proposal-submitter.js';
import { threadNftAssetName } from '../tier-a-schemas.js';

function fakeBytes(fill: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(fill);
}
/** Real Ed25519 VerificationKeyHash length (28 bytes, Blake2b-224) — distinct from
 *  fakeBytes' 32-byte default (Blake2b-256, correct for description/proof-bundle
 *  hashes but NOT for key hashes credentialToAddress will actually parse). */
function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}

function makeFakeTxBuilder(cborResult = 'void-proposal-tx-1') {
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
  const payToAddressCalls: unknown[][] = [];
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      calls.payToContract = a;
      return builder;
    }),
    ToAddress: vi.fn((...a: unknown[]) => {
      payToAddressCalls.push(a);
      calls.payToAddress = payToAddressCalls as unknown as unknown[];
      return builder;
    }),
    // A settlement payout carries the reference of the input it settles, so
    // it is built with ToAddressWithData rather than ToAddress. Recorded into
    // the same list; the datum sits at index 1 and the assets at index 2.
    ToAddressWithData: vi.fn((...a: unknown[]) => {
      payToAddressCalls.push(a);
      calls.payToAddress = payToAddressCalls as unknown as unknown[];
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
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
  return { builder, calls, payToAddressCalls };
}

const LAUNCH_ID_BYTES = new TextEncoder().encode('launch-cto-void-1');
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
const PAYOUT_HASH = fakeKeyHash(4);

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
    payout_pub_key_hash: PAYOUT_HASH,
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

  return new CardanoCtoVoidProposalSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    compiledScriptCbor: '590000',
    governorPrivateKey: 'ed25519_sk1fakefakefake',
    launchId: LAUNCH_ID_BYTES,
    threadNftPolicyId: THREAD_POLICY,
  });
}

const GOVERNOR_ADDR = 'addr_test1governor';

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

const WITHIN_WINDOW_TS = ANCHOR_TS + CHALLENGE_WINDOW_MS - 1n;

describe('CardanoCtoVoidProposalSubmitter.voidPendingProposal — guard rails', () => {
  it('throws when active_proposal is null', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ active_proposal: null }), assets: {} }]);
    await expect(submitter.voidPendingProposal(WITHIN_WINDOW_TS, GOVERNOR_ADDR)).rejects.toThrow(/nothing to void/);
  });

  it('throws when the proposal is already Executed', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ active_proposal: baseProposal({ execution_status: 'Executed' }) }), assets: {} },
    ]);
    await expect(submitter.voidPendingProposal(WITHIN_WINDOW_TS, GOVERNOR_ADDR)).rejects.toThrow(
      /not 'PendingExecution'/,
    );
  });

  it('throws when called at or after the 24h challenge window has elapsed', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);
    const tooLate = ANCHOR_TS + CHALLENGE_WINDOW_MS;
    await expect(submitter.voidPendingProposal(tooLate, GOVERNOR_ADDR)).rejects.toThrow(/no longer callable/);
  });

  it('throws when pending_relayer_bond is not positive', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ pending_relayer_bond: 0n }), assets: {} }]);
    await expect(submitter.voidPendingProposal(WITHIN_WINDOW_TS, GOVERNOR_ADDR)).rejects.toThrow(/nothing to slash/);
  });
});

describe('CardanoCtoVoidProposalSubmitter.voidPendingProposal — happy path', () => {
  it('pays the WHOLE bond to the one address the datum names', async () => {
    const { builder, payToAddressCalls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ pending_relayer_bond: 25_000_000n }), assets: { lovelace: 25_000_000n } },
    ]);

    await submitter.voidPendingProposal(WITHIN_WINDOW_TS, GOVERNOR_ADDR);

    expect(payToAddressCalls).toHaveLength(1);
    const [payoutCall] = payToAddressCalls as [[string, unknown, { lovelace: bigint }]];
    expect(payoutCall[0]).toBe(credentialToAddress('Preprod', { type: 'Key', hash: PAYOUT_HASH }));
    expect(payoutCall[2].lovelace).toBe(25_000_000n);
  });

  it('pays a bond that does not divide evenly in full, with nothing left behind', async () => {
    const { builder, payToAddressCalls } = makeFakeTxBuilder();
    // The figure that used to floor a share and hand the remainder to a second
    // address. Nothing rounds now, so the whole odd amount goes to one payee.
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ pending_relayer_bond: 25_000_007n }), assets: { lovelace: 25_000_007n } },
    ]);

    await submitter.voidPendingProposal(WITHIN_WINDOW_TS, GOVERNOR_ADDR);

    expect(payToAddressCalls).toHaveLength(1);
    const [payoutCall] = payToAddressCalls as [[string, unknown, { lovelace: bigint }]];
    expect(payoutCall[2].lovelace).toBe(25_000_007n);
  });

  it('decreases the continuing lovelace by exactly the full bond amount', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ pending_relayer_bond: 25_000_000n }), assets: { lovelace: 30_000_000n } },
    ]);

    await submitter.voidPendingProposal(WITHIN_WINDOW_TS, GOVERNOR_ADDR);

    const [, , assetsArg] = calls.payToContract as [string, unknown, Record<string, bigint>];
    expect(assetsArg.lovelace).toBe(5_000_000n); // 30M - 25M bond
  });

  it('marks the proposal Expired and zeroes pending_relayer_bond/pending_relayer_key_hash', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: { lovelace: 25_000_000n } }]);

    await submitter.voidPendingProposal(WITHIN_WINDOW_TS, GOVERNOR_ADDR);

    const [, payload] = calls.payToContract as [string, { value: Record<string, unknown> }];
    expect(payload.value.pending_relayer_bond).toBe(0n);
    expect(payload.value.pending_relayer_key_hash).toBe('');
    const active = payload.value.active_proposal as Record<string, unknown>;
    expect(active.execution_status).toBe('Expired');
  });

  it('adds the governor as a required signer', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: { lovelace: 25_000_000n } }]);

    await submitter.voidPendingProposal(WITHIN_WINDOW_TS, GOVERNOR_ADDR);

    expect(calls.addSigner).toEqual([GOVERNOR_ADDR]);
  });

  it('builds the redeemer as a raw Constr at index 5 with the current_timestamp', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: { lovelace: 25_000_000n } }]);

    await submitter.voidPendingProposal(WITHIN_WINDOW_TS, GOVERNOR_ADDR);

    const redeemer = calls.collectFrom![1] as { index: number; fields: unknown[] };
    expect(redeemer.index).toBe(5);
    expect(redeemer.fields).toEqual([WITHIN_WINDOW_TS]);
  });
});
