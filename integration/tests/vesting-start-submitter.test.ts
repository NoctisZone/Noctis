// Tests for vesting-start-submitter.ts's VestingStartSubmitter —
// StartVesting on the shared vesting.ak: which UTXO it starts, the guard
// against starting twice, and the transaction it builds. Same importOriginal
// partial-mock Lucid strategy as the other submitter tests.

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

import { CML, type Constr, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { threadNftAssetName } from '../launch-schemas.js';
import { VESTING_REDEEMER } from '../redeemer-indices.js';
import { VestingStartSubmitter } from '../vesting-start-submitter.js';

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const REAL_EXTENDED_KEY_HEX = toHex(CML.PrivateKey.generate_ed25519extended().to_raw_bytes());
const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-grad-1'));
const THREAD_POLICY = 'cc'.repeat(28);
const GOVERNOR_ADDR = credentialToAddress('Preprod', { type: 'Key', hash: '11'.repeat(28) });
const VESTING_NFT = THREAD_POLICY + threadNftAssetName('vesting', LAUNCH_ID_HEX);
const TOKEN_UNIT = 'aa'.repeat(28) + '42'.repeat(4);

function vestDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    vesting_state: 'NotStarted',
    vest_start_timestamp: 0n,
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}

function makeSubmitter(vestingUtxos: Array<{ datum: unknown; assets: Record<string, bigint>; noThreadNft?: boolean }>) {
  const calls: Record<string, unknown[]> = {};
  const builder: Record<string, unknown> = {};
  for (const name of ['validFrom', 'validTo', 'collectFrom', 'addSigner']) {
    builder[name] = vi.fn((...a: unknown[]) => {
      calls[name] = a;
      return builder;
    });
  }
  builder.attach = { SpendingValidator: vi.fn(() => builder) };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      calls.payToContract = a;
      return builder;
    }),
  };
  builder.complete = vi.fn().mockResolvedValue({
    sign: {
      withPrivateKey: () => ({
        complete: vi.fn().mockResolvedValue({ submit: vi.fn().mockResolvedValue('vest-tx-1') }),
      }),
    },
  });

  const vestingAddress = { current: '' };
  vi.mocked(Lucid).mockResolvedValue({
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockImplementation((address: string) =>
      Promise.resolve(
        address === vestingAddress.current
          ? vestingUtxos.map((u, i) => ({
              txHash: 'fe'.repeat(32),
              outputIndex: i,
              datum: u.datum,
              assets: u.noThreadNft ? u.assets : { [VESTING_NFT]: 1n, ...u.assets },
            }))
          : [],
      ),
    ),
    newTx: () => builder,
  } as never);

  const submitter = new VestingStartSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    vestingScriptCbor: '590003',
    launchIdHex: LAUNCH_ID_HEX,
    threadNftPolicyId: THREAD_POLICY,
  });
  vestingAddress.current = (submitter as unknown as { vestingAddress: string }).vestingAddress;
  return { submitter, calls, vestingAddress: vestingAddress.current };
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('VestingStartSubmitter.startVesting', () => {
  it('refuses a vesting UTXO with no thread NFT', async () => {
    const { submitter } = makeSubmitter([{ datum: vestDatum(), assets: {}, noThreadNft: true }]);
    await expect(submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* vesting thread NFT/,
    );
  });

  it('refuses a schedule that has already started', async () => {
    const { submitter } = makeSubmitter([{ datum: vestDatum({ vesting_state: 'Vesting' }), assets: {} }]);
    await expect(submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /StartVesting already ran/,
    );
  });

  it('starts the clock at the given time, inside a narrow range, moving nothing, signed by the governor', async () => {
    const start = 1_790_000_000_000;
    const held = { lovelace: 2_000_000n, [TOKEN_UNIT]: 50_000_000n };
    const { submitter, calls, vestingAddress } = makeSubmitter([{ datum: vestDatum(), assets: held }]);
    const { txHash } = await submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, start);
    expect(txHash).toBe('vest-tx-1');

    const redeemer = calls.collectFrom?.[1] as Constr<bigint>;
    expect(redeemer.index).toBe(VESTING_REDEEMER.StartVesting);
    expect(redeemer.fields).toEqual([BigInt(start)]);
    const [from, to] = [calls.validFrom?.[0] as number, calls.validTo?.[0] as number];
    expect(from).toBeLessThanOrEqual(start);
    expect(to).toBeGreaterThanOrEqual(start);
    expect(to - from).toBeLessThanOrEqual(600_000);

    const [address, datum, assets] = calls.payToContract as [string, { value: Record<string, unknown> }, unknown];
    expect(address).toBe(vestingAddress);
    expect(datum.value).toMatchObject({ vesting_state: 'Vesting', vest_start_timestamp: BigInt(start) });
    expect(assets).toEqual({ [VESTING_NFT]: 1n, ...held });
    expect(calls.addSigner).toEqual([GOVERNOR_ADDR]);
  });
});
