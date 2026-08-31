// Tests for cardano-cto-anchor-submitter.ts's CardanoCtoAnchorSubmitter —
// anchors a finalized Midnight CTO proposal result onto cto_governance.ak's
// AnchorVoteResult redeemer (permissionless, but requires a real
// ADA relayer bond per the fix this file's own header documents — the
// exact "forge a vote result for free" gap closure worth testing). Same
// importOriginal partial-mock strategy as the other Lucid submitters tests.

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

import { Data, Lucid } from '@lucid-evolution/lucid';
import type { VoteResultParams } from '../cardano-cto-anchor-submitter.js';
import { CardanoCtoAnchorSubmitter, MIN_RELAYER_BOND_LOVELACE, toHex } from '../cardano-cto-anchor-submitter.js';
import { type LpEscrowDatumData, LpEscrowDatumSchema, threadNftAssetName } from '../tier-a-schemas.js';

function fakeBytes(fill: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

function makeFakeTxBuilder() {
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
  builder.readFrom = vi.fn((...a: unknown[]) => {
    calls.readFrom = a;
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
          submit: vi.fn().mockResolvedValue('cto-anchor-tx-1'),
        }),
      }),
    },
  });
  return { builder, calls };
}

const LAUNCH_ID_BYTES = new TextEncoder().encode('launch-cto-1');
const LAUNCH_ID_HEX = toHex(LAUNCH_ID_BYTES);
// A real launch's governance UTXO carries its thread NFT; a fixture without
// one describes a UTXO that cannot exist.
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('ctoGovernance', LAUNCH_ID_HEX);
const LP_THREAD_UNIT = THREAD_POLICY + threadNftAssetName('lpEscrow', LAUNCH_ID_HEX);

/**
 * The launch's LP escrow UTXO, which AnchorVoteResult now reads graduation
 * time from. `lock_timestamp` is what SealLock writes at graduation; the
 * ballot in these tests opens well after the 90-day delay that follows it.
 */
const LP_ESCROW_UTXO = {
  txHash: 'ee'.repeat(32),
  outputIndex: 0,
  assets: { [LP_THREAD_UNIT]: 1n, lovelace: 2_000_000n },
  datum: Data.to<LpEscrowDatumData>(
    {
      launch_id: LAUNCH_ID_HEX,
      lock_timestamp: 1_000n,
      lock_duration: 31_536_000_000n,
      lp_state: 'Locked',
      governor_pub_key_hash: toHex(fakeBytes(2)),
      community_wallet_hash: toHex(fakeBytes(1)),
      cto_triggered: false,
      fee_recipient_pub_key_hash: toHex(fakeBytes(3)),
      dex_whitelist: [],
      multisig_signers: [],
      multisig_threshold: 1n,
      pending_dex_change: null,
      lp_token_policy_id: toHex(fakeBytes(4)),
      lp_token_name: toHex(fakeBytes(5)),
      lp_token_amount: 1_000n,
      cto_governance_credential: { PubKeyCredential: [toHex(fakeBytes(6))] },
      thread_nft_policy: THREAD_POLICY,
      last_migration_timestamp: 0n,
    },
    LpEscrowDatumSchema,
  ),
};
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
    active_proposal: null,
    proposal_count: 0n,
    last_executed_proposal: null,
    pending_relayer_bond: 0n,
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
    // Both UTXOs are returned for any address: selectLaunchUtxo picks by
    // datum shape and role thread NFT, not by address, so each lookup finds
    // its own and ignores the other — the same discrimination the validator
    // makes.
    utxosAt: vi.fn().mockResolvedValue([...withThreadNft(utxos), LP_ESCROW_UTXO]),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return new CardanoCtoAnchorSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    compiledScriptCbor: '590000',
    // Not spent — only used to derive the address the launch's LP escrow sits
    // at, so AnchorVoteResult can read graduation time from it.
    lpEscrowScriptCbor: '590001',
    relayerPrivateKey: 'ed25519_sk1fakefakefake',
    launchId: LAUNCH_ID_BYTES,
    threadNftPolicyId: THREAD_POLICY,
  });
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

function baseParams(overrides: Partial<VoteResultParams> = {}): VoteResultParams {
  return {
    proposalType: 'SilenceLockTrigger',
    descriptionHash: fakeBytes(10),
    proposalId: fakeBytes(11),
    yesVotes: 60_000n,
    noVotes: 10_000n,
    voterCount: 20n,
    creatorYesVotes: 0n,
    creatorNoVotes: 0n,
    outcome: 'Passed',
    startTimestamp: 1000n,
    endTimestamp: 2000n,
    anchorTimestamp: 2100n,
    targetDexCredential: null,
    allocationAmount: 0n,
    allocationRecipientHash: toHex(fakeBytes(12)),
    relayerCredentialHash: toHex(fakeBytes(13)),
    relayerBondLovelace: MIN_RELAYER_BOND_LOVELACE,
    ...overrides,
  };
}

describe('MIN_RELAYER_BOND_LOVELACE', () => {
  it('matches the documented on-chain floor (25 ADA)', () => {
    expect(MIN_RELAYER_BOND_LOVELACE).toBe(25_000_000n);
  });
});

describe('CardanoCtoAnchorSubmitter.submitVoteResult — guard rails', () => {
  it('rejects a relayer bond below the required floor, before ever touching the chain', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await expect(
      submitter.submitVoteResult(baseParams({ relayerBondLovelace: MIN_RELAYER_BOND_LOVELACE - 1n })),
    ).rejects.toThrow(/below the required floor/);
  });

  it('accepts a bond exactly at the floor', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await expect(
      submitter.submitVoteResult(baseParams({ relayerBondLovelace: MIN_RELAYER_BOND_LOVELACE })),
    ).resolves.toEqual({
      txHash: 'cto-anchor-tx-1',
    });
  });

  it('throws when no anchor UTXO matches the configured launchId', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ launch_id: 'a-different-launch' }), assets: {} }]);

    await expect(submitter.submitVoteResult(baseParams())).rejects.toThrow(/carries launch/);
  });
});

describe('CardanoCtoAnchorSubmitter.submitVoteResult — happy path', () => {
  it('adds the relayer bond to the continuing lovelace value on top of the existing UTXO value', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: { lovelace: 3_000_000n } }]);

    await submitter.submitVoteResult(baseParams({ relayerBondLovelace: 25_000_000n }));

    const [, payload, assetsArg] = calls.payToContract as [
      string,
      { value: Record<string, unknown> },
      Record<string, bigint>,
    ];
    expect(assetsArg.lovelace).toBe(28_000_000n); // 3M existing + 25M bond
    expect(payload.value.pending_relayer_bond).toBe(25_000_000n);
  });

  it("increments proposal_count and sets pending_relayer_key_hash/active_proposal, without touching cto_state (ExecuteProposal's job now)", async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ proposal_count: 4n, cto_state: 'PreCTO' }),
        assets: { lovelace: 0n },
      },
    ]);
    const relayerHash = toHex(fakeBytes(77));

    await submitter.submitVoteResult(baseParams({ relayerCredentialHash: relayerHash }));

    const [, payload] = calls.payToContract as [string, { value: Record<string, unknown> }];
    expect(payload.value.proposal_count).toBe(5n);
    expect(payload.value.pending_relayer_key_hash).toBe(relayerHash);
    expect(payload.value.cto_state).toBe('PreCTO'); // unchanged
    const activeProposal = payload.value.active_proposal as Record<string, unknown>;
    expect(activeProposal.execution_status).toBe('PendingExecution');
    expect(activeProposal.relayer_credential_hash).toBe(relayerHash);
  });

  it('preserves unrelated datum fields (community_wallet_hash, treasury/ops key hashes) unchanged', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const communityHash = toHex(fakeBytes(55));
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ community_wallet_hash: communityHash }),
        assets: {},
      },
    ]);

    await submitter.submitVoteResult(baseParams());

    const [, payload] = calls.payToContract as [string, { value: Record<string, unknown> }];
    expect(payload.value.community_wallet_hash).toBe(communityHash);
    expect(payload.value.launch_id).toBe(LAUNCH_ID_HEX);
  });

  it('builds the redeemer with all vote/outcome fields plus the real relayer_bond', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.submitVoteResult(
      baseParams({
        yesVotes: 70_000n,
        noVotes: 5_000n,
        outcome: 'Passed',
        relayerBondLovelace: 30_000_000n,
      }),
    );

    const redeemer = calls.collectFrom![1] as Record<string, unknown>;
    expect(redeemer.yes_votes).toBe(70_000n);
    expect(redeemer.no_votes).toBe(5_000n);
    expect(redeemer.outcome).toBe('Passed');
    expect(redeemer.relayer_bond).toBe(30_000_000n);
  });

  it('signs with the configured relayer private key', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);
    await submitter.submitVoteResult(baseParams());
    // Verified indirectly: submit() only resolves via the mocked
    // sign.withPrivateKey(...).complete().submit() chain wired in
    // makeFakeTxBuilder — if the wrong key path were used, complete()
    // would be undefined and this would throw instead of resolving.
    await expect(submitter.submitVoteResult(baseParams())).resolves.toEqual({
      txHash: 'cto-anchor-tx-1',
    });
  });
});
