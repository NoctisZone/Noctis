// Tests for eligibility-checker.ts — the off-chain half of DarkVeil
// registration eligibility.
//
// WHY THIS MATTERS MORE THAN ITS SIZE SUGGESTS
// Nothing on-chain re-checks any of this. `verifyAllowlist` proves membership
// in the governor-published tree and cannot see Cardano history, so whether a
// wallet deserved its leaf is decided here and nowhere else. A check that
// silently passes everyone still produces a tree, a root, and a valid proof.
//
// So the cases below are weighted toward the ways a check fails OPEN: a
// boundary that admits one day too many, a conjunction missing a term, an
// absent field that reads as "no match", and a lookback window that scans
// nothing.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../indexer-client.js', () => ({ getUnshieldedNightBalance: vi.fn() }));
vi.mock('../night-price-oracle.js', () => ({ usdToMinNightAtomic: vi.fn() }));

import type { AddressInfo, AddressTransaction, BlockfrostClient, TxUtxos } from '../blockfrost-client.js';
import {
  checkDarkVeilEligibility,
  checkNightBalance,
  checkNoDirectAdaFlow,
  checkStakeKeyMatch,
  checkWalletAge,
} from '../eligibility-checker.js';
import { getUnshieldedNightBalance } from '../indexer-client.js';
import { usdToMinNightAtomic } from '../night-price-oracle.js';

const DAY = 86_400;
const NOW = 1_800_000_000;

const REGISTRANT = 'addr_test1registrant';
const CREATOR = 'addr_test1creator';
const REGISTRANT_STAKE = 'stake_test1registrant';
const CREATOR_STAKE = 'stake_test1creator';

function tx(hash: string, daysAgo: number): AddressTransaction {
  return { tx_hash: hash, tx_index: 0, block_height: 1, block_time: NOW - daysAgo * DAY };
}

function utxos(hash: string, inputAddrs: string[], outputAddrs: string[]): TxUtxos {
  const entry = (address: string) => ({ address, amount: [{ unit: 'lovelace', quantity: '1000000' }] });
  return { hash, inputs: inputAddrs.map(entry), outputs: outputAddrs.map(entry) };
}

interface FakeClientOptions {
  txs?: AddressTransaction[];
  utxosByHash?: Record<string, TxUtxos>;
  addresses?: Record<string, AddressInfo>;
}

/** Records every call, so a test can assert what was NOT fetched. */
function fakeClient(options: FakeClientOptions = {}) {
  const utxoCalls: string[] = [];
  const client = {
    getAddressTransactionsAll: vi.fn(async () => options.txs ?? []),
    getTxUtxos: vi.fn(async (hash: string) => {
      utxoCalls.push(hash);
      const found = options.utxosByHash?.[hash];
      if (!found) throw new Error(`test fixture has no utxos for ${hash}`);
      return found;
    }),
    getAddress: vi.fn(async (address: string) => {
      const found = options.addresses?.[address];
      if (!found) throw new Error(`test fixture has no address info for ${address}`);
      return found;
    }),
  };
  return { client: client as unknown as BlockfrostClient, utxoCalls, spies: client };
}

function addressInfo(address: string, stakeAddress: string | null): AddressInfo {
  return { address, stake_address: stakeAddress, type: 'shelley' };
}

describe('checkWalletAge (check #1)', () => {
  it('never admits an address with no transaction history', async () => {
    // Age is undefined here, not infinite. A brand-new wallet is the cheapest
    // thing an attacker can produce, so this is the case that must not pass.
    const { client } = fakeClient({ txs: [] });
    const result = await checkWalletAge(client, REGISTRANT, 90, NOW);
    expect(result).toEqual({ eligible: false, ageDays: 0, earliestTxHash: null });
  });

  it('admits a wallet exactly on the threshold', async () => {
    const { client } = fakeClient({ txs: [tx('a', 90)] });
    const result = await checkWalletAge(client, REGISTRANT, 90, NOW);
    expect(result.eligible).toBe(true);
    expect(result.ageDays).toBe(90);
  });

  it('refuses a wallet one day short', async () => {
    const { client } = fakeClient({ txs: [tx('a', 89)] });
    await expect(checkWalletAge(client, REGISTRANT, 90, NOW)).resolves.toMatchObject({
      eligible: false,
      ageDays: 89,
    });
  });

  it('floors a partial day rather than rounding it up', async () => {
    // 89 days and 23 hours is 89 days old, not 90. Rounding here would admit
    // a wallet a whole day early, every time.
    const { client } = fakeClient({ txs: [{ ...tx('a', 89), block_time: NOW - (89 * DAY + 23 * 3600) }] });
    await expect(checkWalletAge(client, REGISTRANT, 90, NOW)).resolves.toMatchObject({
      eligible: false,
      ageDays: 89,
    });
  });

  it('reads the OLDEST transaction, not the newest', async () => {
    // getAddressTransactionsAll requests order=asc, and this depends on it.
    // If that ordering ever changes, a wallet's age becomes the age of its
    // most recent activity — which every active wallet passes.
    const { client } = fakeClient({ txs: [tx('oldest', 200), tx('middle', 100), tx('newest', 1)] });
    const result = await checkWalletAge(client, REGISTRANT, 90, NOW);
    expect(result.earliestTxHash).toBe('oldest');
    expect(result.ageDays).toBe(200);
  });

  it('would refuse the same history if only the newest transaction were visible', async () => {
    // The control for the test above: proves that assertion is discriminating
    // rather than passing because 200 and 1 both clear the threshold.
    const { client } = fakeClient({ txs: [tx('newest', 1)] });
    await expect(checkWalletAge(client, REGISTRANT, 90, NOW)).resolves.toMatchObject({ eligible: false });
  });
});

describe('checkStakeKeyMatch (check #4)', () => {
  it('admits a registrant whose stake key differs from the creator', async () => {
    const { client } = fakeClient({
      addresses: {
        [REGISTRANT]: addressInfo(REGISTRANT, REGISTRANT_STAKE),
        [CREATOR]: addressInfo(CREATOR, CREATOR_STAKE),
      },
    });
    await expect(checkStakeKeyMatch(client, REGISTRANT, CREATOR)).resolves.toEqual({
      eligible: true,
      registrantStakeAddress: REGISTRANT_STAKE,
      creatorStakeAddress: CREATOR_STAKE,
    });
  });

  it('refuses a second payment address sharing the creator stake key', async () => {
    // The evasion this check exists for: Cardano derives many receive
    // addresses from one stake key, so a creator can register from an address
    // that check #3's exact-address match has never seen.
    const { client } = fakeClient({
      addresses: {
        [REGISTRANT]: addressInfo(REGISTRANT, CREATOR_STAKE),
        [CREATOR]: addressInfo(CREATOR, CREATOR_STAKE),
      },
    });
    await expect(checkStakeKeyMatch(client, REGISTRANT, CREATOR)).resolves.toMatchObject({ eligible: false });
  });

  it('refuses a registrant with no stake credential at all', async () => {
    const { client } = fakeClient({
      addresses: {
        [REGISTRANT]: addressInfo(REGISTRANT, null),
        [CREATOR]: addressInfo(CREATOR, CREATOR_STAKE),
      },
    });
    await expect(checkStakeKeyMatch(client, REGISTRANT, CREATOR)).resolves.toMatchObject({ eligible: false });
  });

  it('refuses a registrant whose stake_address field is absent entirely', async () => {
    // Not the same as null. Blockfrost types the field as nullable, but a
    // changed response shape, a proxy that drops fields, or a hand-built
    // fixture all produce undefined — and undefined is not null, so a check
    // written as `=== null` falls through to the inequality below it and
    // compares undefined against a real stake address. That comparison is
    // true, which admits the registrant on the strength of a missing field.
    const { client } = fakeClient({
      addresses: {
        [REGISTRANT]: { address: REGISTRANT, type: 'shelley' } as unknown as AddressInfo,
        [CREATOR]: addressInfo(CREATOR, CREATOR_STAKE),
      },
    });
    await expect(checkStakeKeyMatch(client, REGISTRANT, CREATOR)).resolves.toMatchObject({ eligible: false });
  });

  it('refuses a registrant whose stake_address is an empty string', async () => {
    // Same class as the case above and it fails the same way: '' is neither
    // null nor equal to a real stake address, so an unnormalised comparison
    // reads "no match" and admits.
    const { client } = fakeClient({
      addresses: {
        [REGISTRANT]: addressInfo(REGISTRANT, ''),
        [CREATOR]: addressInfo(CREATOR, CREATOR_STAKE),
      },
    });
    await expect(checkStakeKeyMatch(client, REGISTRANT, CREATOR)).resolves.toMatchObject({ eligible: false });
  });

  it('admits a registrant when the CREATOR has no stake credential', async () => {
    // The mirror case, and it must not fail closed: a creator with nothing to
    // reuse cannot have their stake key reused, so no registrant collides.
    const { client } = fakeClient({
      addresses: {
        [REGISTRANT]: addressInfo(REGISTRANT, REGISTRANT_STAKE),
        [CREATOR]: addressInfo(CREATOR, null),
      },
    });
    await expect(checkStakeKeyMatch(client, REGISTRANT, CREATOR)).resolves.toMatchObject({ eligible: true });
  });
});

describe('checkNoDirectAdaFlow (check #5)', () => {
  it('refuses when the creator appears on the input side', async () => {
    const { client } = fakeClient({
      txs: [tx('funded', 10)],
      utxosByHash: { funded: utxos('funded', [CREATOR], [REGISTRANT]) },
    });
    await expect(checkNoDirectAdaFlow(client, REGISTRANT, CREATOR, 90, NOW)).resolves.toEqual({
      eligible: false,
      violatingTxHash: 'funded',
    });
  });

  it('refuses when the creator appears on the output side', async () => {
    // Flow in either direction links the two wallets; the check is not about
    // who paid whom.
    const { client } = fakeClient({
      txs: [tx('repaid', 10)],
      utxosByHash: { repaid: utxos('repaid', [REGISTRANT], [CREATOR]) },
    });
    await expect(checkNoDirectAdaFlow(client, REGISTRANT, CREATOR, 90, NOW)).resolves.toMatchObject({
      eligible: false,
      violatingTxHash: 'repaid',
    });
  });

  it('admits a registrant whose transactions never involve the creator', async () => {
    const { client } = fakeClient({
      txs: [tx('one', 10), tx('two', 20)],
      utxosByHash: {
        one: utxos('one', ['addr_test1other'], [REGISTRANT]),
        two: utxos('two', [REGISTRANT], ['addr_test1exchange']),
      },
    });
    await expect(checkNoDirectAdaFlow(client, REGISTRANT, CREATOR, 90, NOW)).resolves.toEqual({
      eligible: true,
      violatingTxHash: null,
    });
  });

  it('does not fetch a transaction older than the lookback window', async () => {
    // Asserted through the call log rather than the verdict, because the
    // verdict is the same either way — and a window that quietly scans
    // everything, or nothing, still returns a plausible answer.
    const { client, utxoCalls } = fakeClient({
      txs: [tx('ancient', 200), tx('recent', 10)],
      utxosByHash: { recent: utxos('recent', [REGISTRANT], ['addr_test1other']) },
    });
    await expect(checkNoDirectAdaFlow(client, REGISTRANT, CREATOR, 90, NOW)).resolves.toMatchObject({
      eligible: true,
    });
    expect(utxoCalls).toEqual(['recent']);
  });

  it('keeps a transaction exactly on the window boundary', async () => {
    const { client, utxoCalls } = fakeClient({
      txs: [tx('boundary', 90)],
      utxosByHash: { boundary: utxos('boundary', [CREATOR], [REGISTRANT]) },
    });
    await expect(checkNoDirectAdaFlow(client, REGISTRANT, CREATOR, 90, NOW)).resolves.toMatchObject({
      eligible: false,
    });
    expect(utxoCalls).toEqual(['boundary']);
  });

  it('stops at the first violation instead of scanning the rest', async () => {
    const { client, utxoCalls } = fakeClient({
      txs: [tx('bad', 5), tx('later', 6)],
      utxosByHash: { bad: utxos('bad', [CREATOR], [REGISTRANT]) },
      // 'later' deliberately has no fixture: reaching it throws, so a scan
      // that fails to stop fails the test loudly rather than silently.
    });
    await expect(checkNoDirectAdaFlow(client, REGISTRANT, CREATOR, 90, NOW)).resolves.toMatchObject({
      violatingTxHash: 'bad',
    });
    expect(utxoCalls).toEqual(['bad']);
  });
});

describe('checkNightBalance (check #2)', () => {
  const mockedBalance = vi.mocked(getUnshieldedNightBalance);
  const mockedThreshold = vi.mocked(usdToMinNightAtomic);

  function priced(minNightAtomic: bigint) {
    mockedThreshold.mockResolvedValue({
      minNightAtomic,
      sources: ['coingecko', 'kraken'],
    } as unknown as Awaited<ReturnType<typeof usdToMinNightAtomic>>);
  }

  it('admits a balance exactly on the threshold', async () => {
    mockedBalance.mockResolvedValue({ balance: 500n } as unknown as Awaited<
      ReturnType<typeof getUnshieldedNightBalance>
    >);
    priced(500n);
    await expect(checkNightBalance('ws://indexer', REGISTRANT, 50)).resolves.toMatchObject({
      eligible: true,
      balanceAtomic: 500n,
      minRequiredAtomic: 500n,
    });
  });

  it('refuses a balance one atomic unit short', async () => {
    mockedBalance.mockResolvedValue({ balance: 499n } as unknown as Awaited<
      ReturnType<typeof getUnshieldedNightBalance>
    >);
    priced(500n);
    await expect(checkNightBalance('ws://indexer', REGISTRANT, 50)).resolves.toMatchObject({
      eligible: false,
    });
  });

  it('reports which price sources the threshold came from', async () => {
    // The threshold is a live price. Recording its provenance is what makes a
    // past eligibility decision auditable after the price has moved.
    mockedBalance.mockResolvedValue({ balance: 999n } as unknown as Awaited<
      ReturnType<typeof getUnshieldedNightBalance>
    >);
    priced(500n);
    await expect(checkNightBalance('ws://indexer', REGISTRANT, 50)).resolves.toMatchObject({
      sources: ['coingecko', 'kraken'],
    });
  });
});

describe('checkDarkVeilEligibility', () => {
  const mockedBalance = vi.mocked(getUnshieldedNightBalance);
  const mockedThreshold = vi.mocked(usdToMinNightAtomic);

  const OPTIONS = {
    minWalletAgeDays: 90,
    adaFlowLookbackDays: 90,
    minNightUsd: 50,
    indexerWsUrl: 'ws://indexer',
  };

  /** A registrant who passes everything, so each test can break exactly one thing. */
  function passing(overrides: Partial<FakeClientOptions> = {}) {
    mockedBalance.mockResolvedValue({ balance: 1_000n } as unknown as Awaited<
      ReturnType<typeof getUnshieldedNightBalance>
    >);
    mockedThreshold.mockResolvedValue({ minNightAtomic: 500n, sources: ['coingecko'] } as unknown as Awaited<
      ReturnType<typeof usdToMinNightAtomic>
    >);
    return fakeClient({
      txs: [tx('old', 200), tx('recent', 10)],
      utxosByHash: {
        old: utxos('old', ['addr_test1other'], [REGISTRANT]),
        recent: utxos('recent', [REGISTRANT], ['addr_test1other']),
      },
      addresses: {
        [REGISTRANT]: addressInfo(REGISTRANT, REGISTRANT_STAKE),
        [CREATOR]: addressInfo(CREATOR, CREATOR_STAKE),
      },
      ...overrides,
    });
  }

  it('admits a registrant who passes all four checks', async () => {
    const { client } = passing();
    const result = await checkDarkVeilEligibility(client, REGISTRANT, CREATOR, OPTIONS, NOW);
    expect(result.eligible).toBe(true);
    expect(result.checks.walletAge.eligible).toBe(true);
    expect(result.checks.stakeKeyMatch.eligible).toBe(true);
    expect(result.checks.nightBalance.eligible).toBe(true);
    expect(result.checks.noDirectAdaFlow.eligible).toBe(true);
  });

  it('refuses on wallet age alone', async () => {
    const { client } = passing({
      txs: [tx('recent', 10)],
      utxosByHash: { recent: utxos('recent', [REGISTRANT], ['addr_test1other']) },
    });
    const result = await checkDarkVeilEligibility(client, REGISTRANT, CREATOR, OPTIONS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.checks.walletAge.eligible).toBe(false);
    // Every other check still passed — so this is the age term of the
    // conjunction being load-bearing, not a fixture that broke everything.
    expect(result.checks.stakeKeyMatch.eligible).toBe(true);
    expect(result.checks.nightBalance.eligible).toBe(true);
    expect(result.checks.noDirectAdaFlow.eligible).toBe(true);
  });

  it('refuses on a shared stake key alone', async () => {
    const { client } = passing({
      addresses: {
        [REGISTRANT]: addressInfo(REGISTRANT, CREATOR_STAKE),
        [CREATOR]: addressInfo(CREATOR, CREATOR_STAKE),
      },
    });
    const result = await checkDarkVeilEligibility(client, REGISTRANT, CREATOR, OPTIONS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.checks.stakeKeyMatch.eligible).toBe(false);
    expect(result.checks.walletAge.eligible).toBe(true);
  });

  it('refuses on NIGHT balance alone', async () => {
    const { client } = passing();
    mockedBalance.mockResolvedValue({ balance: 1n } as unknown as Awaited<
      ReturnType<typeof getUnshieldedNightBalance>
    >);
    const result = await checkDarkVeilEligibility(client, REGISTRANT, CREATOR, OPTIONS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.checks.nightBalance.eligible).toBe(false);
    expect(result.checks.walletAge.eligible).toBe(true);
  });

  it('refuses on creator ADA flow alone', async () => {
    const { client } = passing({
      utxosByHash: {
        old: utxos('old', ['addr_test1other'], [REGISTRANT]),
        recent: utxos('recent', [CREATOR], [REGISTRANT]),
      },
    });
    const result = await checkDarkVeilEligibility(client, REGISTRANT, CREATOR, OPTIONS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.checks.noDirectAdaFlow.eligible).toBe(false);
    expect(result.checks.walletAge.eligible).toBe(true);
  });

  it('rejects rather than returning a verdict when a check cannot be completed', async () => {
    // The price oracle throws rather than guessing when its sources diverge.
    // An unavailable check has to propagate: the alternative is a registrant
    // admitted because the thing that would have refused them was down.
    const { client } = passing();
    mockedThreshold.mockRejectedValue(new Error('ADA/USD sources diverged beyond the permitted band'));
    await expect(checkDarkVeilEligibility(client, REGISTRANT, CREATOR, OPTIONS, NOW)).rejects.toThrow(/diverged/);
  });
});
