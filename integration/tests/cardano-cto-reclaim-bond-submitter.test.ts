// Tests for cardano-cto-reclaim-bond-submitter.ts's
// CardanoCtoReclaimBondSubmitter — permissionless bond reclaim once the
// anchored proposal has been legitimately Executed or Expired. Same
// importOriginal partial-mock strategy as the other Lucid submitter tests.

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
import { CardanoCtoReclaimBondSubmitter } from '../cardano-cto-reclaim-bond-submitter.js';
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

function makeFakeTxBuilder(cborResult = 'reclaim-bond-tx-1') {
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
    ToAddress: vi.fn((...a: unknown[]) => {
      calls.payToAddress = a;
      return builder;
    }),
    // A settlement payout carries the reference of the input it settles, so
    // it is built with ToAddressWithData rather than ToAddress. Recorded into
    // the same list; the datum sits at index 1 and the assets at index 2.
    ToAddressWithData: vi.fn((...a: unknown[]) => {
      calls.payToAddress = a;
      return builder;
    }),
  };
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

const LAUNCH_ID_BYTES = new TextEncoder().encode('launch-cto-reclaim-1');
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

const RELAYER_HASH = fakeKeyHash(3);

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
    end_timestamp: 1_000_000n,
    anchor_timestamp: 1_000_000n,
    execution_status: 'Executed',
    target_dex_credential: null,
    allocation_amount: 0n,
    allocation_recipient_hash: toHex(fakeBytes(22)),
    relayer_credential_hash: RELAYER_HASH,
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
    last_executed_proposal: baseProposal(),
    pending_relayer_bond: 25_000_000n,
    pending_relayer_key_hash: RELAYER_HASH,
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

  return new CardanoCtoReclaimBondSubmitter({
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

describe('CardanoCtoReclaimBondSubmitter.reclaimRelayerBond — guard rails', () => {
  it('throws when active_proposal is null', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ active_proposal: null }), assets: {} }]);
    await expect(submitter.reclaimRelayerBond()).rejects.toThrow(/nothing to reclaim against/);
  });

  it('throws when the proposal is still PendingExecution', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ active_proposal: baseProposal({ execution_status: 'PendingExecution' }) }), assets: {} },
    ]);
    await expect(submitter.reclaimRelayerBond()).rejects.toThrow(/can only be reclaimed once/);
  });

  it('throws when pending_relayer_bond is not positive (already reclaimed or voided)', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ pending_relayer_bond: 0n }), assets: {} }]);
    await expect(submitter.reclaimRelayerBond()).rejects.toThrow(/nothing to reclaim/);
  });

  it('accepts Expired the same as Executed', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ active_proposal: baseProposal({ execution_status: 'Expired' }) }),
        assets: { lovelace: 25_000_000n },
      },
    ]);
    await expect(submitter.reclaimRelayerBond()).resolves.toEqual({ txHash: 'reclaim-bond-tx-1' });
  });
});

describe('CardanoCtoReclaimBondSubmitter.reclaimRelayerBond — happy path', () => {
  it('pays the full bond to the address derived from pending_relayer_key_hash', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ pending_relayer_bond: 25_000_000n }), assets: { lovelace: 25_000_000n } },
    ]);

    await submitter.reclaimRelayerBond();

    const expectedAddr = credentialToAddress('Preprod', { type: 'Key', hash: RELAYER_HASH });
    const [addr, , payment] = calls.payToAddress as [string, unknown, { lovelace: bigint }];
    expect(addr).toBe(expectedAddr);
    expect(payment.lovelace).toBe(25_000_000n);
  });

  it('decreases the continuing lovelace by exactly the bond amount', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ pending_relayer_bond: 25_000_000n }), assets: { lovelace: 30_000_000n } },
    ]);

    await submitter.reclaimRelayerBond();

    const [, , assetsArg] = calls.payToContract as [string, unknown, Record<string, bigint>];
    expect(assetsArg.lovelace).toBe(5_000_000n);
  });

  it('zeroes pending_relayer_bond and pending_relayer_key_hash', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: { lovelace: 25_000_000n } }]);

    await submitter.reclaimRelayerBond();

    const [, payload] = calls.payToContract as [string, { value: Record<string, unknown> }];
    expect(payload.value.pending_relayer_bond).toBe(0n);
    expect(payload.value.pending_relayer_key_hash).toBe('');
  });

  it('leaves active_proposal / last_executed_proposal untouched', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const proposal = baseProposal({ execution_status: 'Executed' });
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ active_proposal: proposal, last_executed_proposal: proposal }),
        assets: { lovelace: 25_000_000n },
      },
    ]);

    await submitter.reclaimRelayerBond();

    const [, payload] = calls.payToContract as [string, { value: Record<string, unknown> }];
    expect(payload.value.active_proposal).toEqual(proposal);
    expect(payload.value.last_executed_proposal).toEqual(proposal);
  });

  it('builds the redeemer as a raw Constr at index 6 with no fields', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: { lovelace: 25_000_000n } }]);

    await submitter.reclaimRelayerBond();

    const redeemer = calls.collectFrom![1] as { index: number; fields: unknown[] };
    expect(redeemer.index).toBe(6);
    expect(redeemer.fields).toEqual([]);
  });
});
