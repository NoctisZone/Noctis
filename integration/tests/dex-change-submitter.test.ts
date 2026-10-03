// Tests for dex-change-submitter.ts's DexChangeSubmitter —
// lp_escrow.ak's DEX-whitelist mechanism: ProposeDexChange (multisig-
// gated, starts the 72h public notice clock, legitimately backdatable per
// this file's own header since it's not permissionless) and
// ExecuteDexChange (permissionless, applies the change once elapsed,
// real-narrow-validity-range-bound). Same importOriginal partial-mock Lucid
// strategy — Constr is kept real so pending_dex_change fixtures are genuine
// Constr instances, matching exactly what the submitter itself builds and
// later reads back.

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

import { CML, Constr, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { DexChangeSubmitter } from '../dex-change-submitter.js';
import { threadNftAssetName } from '../launch-schemas.js';

function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

const REAL_EXTENDED_KEY_HEX = toHex(CML.PrivateKey.generate_ed25519extended().to_raw_bytes());
const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-dex-1'));
// A real launch's state UTXOs each carry a thread NFT; without one the
// authenticated lookup refuses the UTXO, as it should.
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('lpEscrow', LAUNCH_ID_HEX);
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

const GOVERNOR_ADDR = addrFor(fakeKeyHash(0x11));
const DEX_SCRIPT_HASH_HEX = 'bb'.repeat(28);

function lpDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: THREAD_POLICY,
    dex_whitelist: [] as Array<{ PubKeyCredential: [string] } | { ScriptCredential: [string] }>,
    pending_dex_change: null,
    ...overrides,
  };
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
        complete: vi.fn().mockResolvedValue({ submit: vi.fn().mockResolvedValue('dex-tx-1') }),
      }),
    },
  });
  return { builder, calls };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  utxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(withThreadNft(utxos)),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return new DexChangeSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    lpEscrowScriptCbor: '590000',
    launchIdHex: LAUNCH_ID_HEX,
    threadNftPolicyId: THREAD_POLICY,
  });
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('DexChangeSubmitter.proposeDexChange', () => {
  it('rejects when a DEX change proposal is already pending', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: lpDatum({
          pending_dex_change: new Constr(0, [new Constr(1, [DEX_SCRIPT_HASH_HEX]), new Constr(0, []), 1000n]),
        }),
        assets: {},
      },
    ]);

    await expect(
      submitter.proposeDexChange(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, DEX_SCRIPT_HASH_HEX, 'ProposeAdd', Date.now()),
    ).rejects.toThrow(/already has a pending DEX change/);
  });

  it('builds the ProposeAdd redeemer/datum with action index 0 and the target script credential', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: lpDatum(), assets: {} }]);

    await submitter.proposeDexChange(
      REAL_EXTENDED_KEY_HEX,
      GOVERNOR_ADDR,
      DEX_SCRIPT_HASH_HEX,
      'ProposeAdd',
      1_700_000_000_000,
    );

    const redeemer = calls.collectFrom![1] as Constr<unknown>;
    expect(redeemer.index).toBe(1); // ProposeDexChange constructor index
    const [credential, actionConstr, timestamp] = redeemer.fields as [Constr<unknown>, Constr<unknown>, bigint];
    expect(credential.index).toBe(1); // ScriptCredential (DEX targets are always scripts)
    expect(credential.fields).toEqual([DEX_SCRIPT_HASH_HEX]);
    expect(actionConstr.index).toBe(0); // ProposeAdd
    expect(timestamp).toBe(1_700_000_000_000n);

    const payload = calls.payToContract![1] as {
      value: { pending_dex_change: Constr<unknown> };
    };
    expect(payload.value.pending_dex_change.index).toBe(0);
  });

  it('builds the ProposeRemove redeemer with action index 1', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: lpDatum(), assets: {} }]);

    await submitter.proposeDexChange(
      REAL_EXTENDED_KEY_HEX,
      GOVERNOR_ADDR,
      DEX_SCRIPT_HASH_HEX,
      'ProposeRemove',
      Date.now(),
    );

    const redeemer = calls.collectFrom![1] as Constr<unknown>;
    const actionConstr = redeemer.fields[1] as Constr<unknown>;
    expect(actionConstr.index).toBe(1);
  });

  it('sets a validity range spanning the backdated proposedAtMs through real "now" plus a buffer (legitimate multisig backdating)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: lpDatum(), assets: {} }]);
    const proposedAtMs = Date.now() - 100_000_000; // far backdated

    const before = Date.now();
    await submitter.proposeDexChange(
      REAL_EXTENDED_KEY_HEX,
      GOVERNOR_ADDR,
      DEX_SCRIPT_HASH_HEX,
      'ProposeAdd',
      proposedAtMs,
    );
    const after = Date.now();

    expect(calls.validFrom![0]).toBe(proposedAtMs - 60_000);
    expect(calls.validTo![0] as number).toBeGreaterThanOrEqual(before + 600_000);
    expect(calls.validTo![0] as number).toBeLessThanOrEqual(after + 600_000);
  });

  it("re-locks the UTXO's own assets unchanged and requires the governor as signer", async () => {
    const { builder, calls } = makeFakeTxBuilder();
    // The thread NFT is part of what the UTXO holds, so re-locking its own
    // assets unchanged means re-locking that too.
    const existingAssets = { lovelace: 2_000_000n, [THREAD_UNIT]: 1n };
    const submitter = makeSubmitter(builder, [{ datum: lpDatum(), assets: existingAssets }]);

    await submitter.proposeDexChange(
      REAL_EXTENDED_KEY_HEX,
      GOVERNOR_ADDR,
      DEX_SCRIPT_HASH_HEX,
      'ProposeAdd',
      Date.now(),
    );
    const assetsArg = calls.payToContract![2] as Record<string, bigint>;
    expect(assetsArg).toEqual(existingAssets);
    expect(calls.addSigner).toEqual([GOVERNOR_ADDR]);
  });
});

describe('DexChangeSubmitter.executeDexChange', () => {
  it('rejects when there is no pending DEX change to execute', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: lpDatum({ pending_dex_change: null }), assets: {} }]);
    await expect(submitter.executeDexChange(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, Date.now())).rejects.toThrow(
      /no pending DEX change/,
    );
  });

  it('ADD: appends the pending credential to dex_whitelist and clears pending_dex_change', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: lpDatum({
          dex_whitelist: [{ ScriptCredential: ['cc'.repeat(28)] }],
          pending_dex_change: new Constr(0, [new Constr(1, [DEX_SCRIPT_HASH_HEX]), new Constr(0, []), 1000n]),
        }),
        assets: {},
      },
    ]);

    await submitter.executeDexChange(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);

    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.dex_whitelist).toEqual([
      { ScriptCredential: ['cc'.repeat(28)] },
      { ScriptCredential: [DEX_SCRIPT_HASH_HEX] },
    ]);
    expect(payload.value.pending_dex_change).toBeNull();
  });

  it('REMOVE: filters the matching credential out of dex_whitelist and clears pending_dex_change', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: lpDatum({
          dex_whitelist: [{ ScriptCredential: [DEX_SCRIPT_HASH_HEX] }, { ScriptCredential: ['dd'.repeat(28)] }],
          pending_dex_change: new Constr(0, [new Constr(1, [DEX_SCRIPT_HASH_HEX]), new Constr(1, []), 1000n]),
        }),
        assets: {},
      },
    ]);

    await submitter.executeDexChange(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);

    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.dex_whitelist).toEqual([{ ScriptCredential: ['dd'.repeat(28)] }]);
  });

  it('builds the ExecuteDexChange redeemer (index 2) with the real, given currentTimestampMs', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: lpDatum({
          pending_dex_change: new Constr(0, [new Constr(1, [DEX_SCRIPT_HASH_HEX]), new Constr(0, []), 1000n]),
        }),
        assets: {},
      },
    ]);

    await submitter.executeDexChange(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 5_000_000_000);

    const redeemer = calls.collectFrom![1] as Constr<unknown>;
    expect(redeemer.index).toBe(2);
    expect(redeemer.fields).toEqual([5_000_000_000n]);
  });

  it('sets a narrow (120,000ms wide), honest validity range around the given currentTimestampMs (not backdated/widened)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: lpDatum({
          pending_dex_change: new Constr(0, [new Constr(1, [DEX_SCRIPT_HASH_HEX]), new Constr(0, []), 1000n]),
        }),
        assets: {},
      },
    ]);

    await submitter.executeDexChange(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 5_000_000_000);

    expect(calls.validFrom![0]).toBe(5_000_000_000 - 60_000);
    expect(calls.validTo![0]).toBe(5_000_000_000 + 60_000);
  });
});
