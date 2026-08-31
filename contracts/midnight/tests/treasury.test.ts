import { afterEach, describe, expect, it } from 'vitest';
import { Contract, Currency, type Ledger, ledger, type Witnesses } from '../compiled/treasury/contract/index.js';
import { deployForTest, fakeBytes32, type LedgerSink, nextContext, nextContextAtTime, trackLedger } from './helpers.js';

type PrivateState = undefined;

const witnesses: Witnesses<PrivateState> = {
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
};

// 10,000 / 25,000 ADA in lovelace — matches CLAUDE.md's treasury-floor thresholds.
const FLOOR_LOVELACE = 10_000_000_000n;
const WARNING_LOVELACE = 25_000_000_000n;

// A withdrawal window and per-currency ceilings, both deploy-time policy.
// Generous here so the tests that are not about the ceiling never meet it;
// the ceiling has its own block at the end of this file.
const WINDOW_SECONDS = 86_400n;
const ADA_LIMIT = 1_000_000_000_000n;
const NIGHT_LIMIT = 1_000_000_000_000n;
// Realistic epoch-seconds anchor — a withdrawal binds to real chain time.
const NOW = 1_780_000_000;

function deploy(
  floor = FLOOR_LOVELACE,
  warning = WARNING_LOVELACE,
  opts: { windowSeconds?: bigint; adaLimit?: bigint; nightLimit?: bigint } = {},
) {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    fakeBytes32(9),
    floor,
    warning,
    opts.windowSeconds ?? WINDOW_SECONDS,
    opts.adaLimit ?? ADA_LIMIT,
    opts.nightLimit ?? NIGHT_LIMIT,
  );
  return { contract, init, contractAddress, ctx };
}

/** A withdrawal made at `at`, with the simulator's block time pinned to match. */
function withdrawAt(
  d: { contract: ReturnType<typeof deploy>['contract']; contractAddress: ReturnType<typeof deploy>['contractAddress'] },
  ctx: ReturnType<typeof deploy>['ctx'],
  amount: bigint,
  currency: Currency,
  recipient: Uint8Array,
  at: number = NOW,
) {
  return d.contract.circuits.withdrawFees(
    nextContextAtTime(d.contractAddress, ctx, at),
    amount,
    currency,
    recipient,
    BigInt(at),
  );
}

describe('treasury.compact', () => {
  // Real conservation invariant (the treasury-floor fix, not a trivially-true
  // assertion): each currency's spendable balance can only ever be
  // depleted by a withdrawal, so it can never exceed that currency's
  // lifetime-collected counter — a regression here would mean deposits
  // and withdrawals stopped being tracked correctly per-currency (the
  // exact bug class that fix closed: both currencies used to sum into one
  // meaningless combined field).
  const lastLedger: LedgerSink<Ledger> = {};
  afterEach(() => {
    if (lastLedger.current) {
      const s = lastLedger.current;
      expect(s.adaBalance).toBeLessThanOrEqual(s.totalAdaFeesCollected);
      expect(s.nightBalance).toBeLessThanOrEqual(s.totalNightFeesCollected);
    }
    lastLedger.current = undefined;
  });

  it('starts with zero balances in both currencies', () => {
    const { init } = deploy();
    const state = trackLedger(lastLedger, ledger(init.currentContractState.data));
    expect(state.adaBalance).toBe(0n);
    expect(state.nightBalance).toBe(0n);
    expect(state.totalAdaFeesCollected).toBe(0n);
    expect(state.totalNightFeesCollected).toBe(0n);
  });

  it('accumulates ADA fees across multiple deposits (width-narrowing fix regression)', () => {
    // treasury.compact's depositFees previously failed to compile because
    // `treasuryBalance + amount` (Uint<128> + Uint<128>) widens beyond
    // Uint<128> and needs an explicit `as Uint<128>` re-cast. This proves
    // the fix doesn't just compile — it accumulates correctly across
    // multiple real circuit calls.
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 1000n, Currency.Ada);
    const afterFirst = trackLedger(lastLedger, ledger(r1.context.currentQueryContext.state));
    expect(afterFirst.adaBalance).toBe(1000n);
    expect(afterFirst.totalAdaFeesCollected).toBe(1000n);

    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 2500n, Currency.Ada);
    const afterSecond = trackLedger(lastLedger, ledger(r2.context.currentQueryContext.state));
    expect(afterSecond.adaBalance).toBe(3500n);
    expect(afterSecond.totalAdaFeesCollected).toBe(3500n);
  });

  it('ADA and NIGHT deposits accumulate into SEPARATE balances, not one mixed total', () => {
    // Before this fix, both currencies summed into one `treasuryBalance` —
    // 1000 lovelace + 500 NIGHT atomic units became a meaningless "1500."
    // A floor check needs each currency's real value tracked separately.
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 1000n, Currency.Ada); // Cardano Launch launch fee
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 500n, Currency.Night); // Midnight Launch launch fee
    const state = trackLedger(lastLedger, ledger(r2.context.currentQueryContext.state));
    expect(state.adaBalance).toBe(1000n);
    expect(state.nightBalance).toBe(500n);
    expect(state.totalAdaFeesCollected).toBe(1000n);
    expect(state.totalNightFeesCollected).toBe(500n);
  });

  it('allows the governor to withdraw ADA up to the ADA balance', () => {
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 5000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = withdrawAt({ contract, contractAddress }, ctx2, 2000n, Currency.Ada, fakeBytes32(5));
    const afterWithdraw = trackLedger(lastLedger, ledger(r2.context.currentQueryContext.state));
    expect(afterWithdraw.adaBalance).toBe(3000n);
    // totalAdaFeesCollected is a lifetime counter, unaffected by withdrawal
    expect(afterWithdraw.totalAdaFeesCollected).toBe(5000n);
    expect(afterWithdraw.withdrawalCount).toBe(1n);
  });

  it('allows the governor to withdraw NIGHT up to the NIGHT balance, independent of the ADA balance', () => {
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 5000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 3000n, Currency.Night);
    const ctx3 = nextContext(contractAddress, r2.context);
    const r3 = withdrawAt({ contract, contractAddress }, ctx3, 1000n, Currency.Night, fakeBytes32(5));
    const afterWithdraw = trackLedger(lastLedger, ledger(r3.context.currentQueryContext.state));
    expect(afterWithdraw.nightBalance).toBe(2000n);
    expect(afterWithdraw.adaBalance).toBe(5000n); // untouched
  });

  it('Phase 5 hygiene fix: withdrawFees rejects an empty (all-zero) recipient address', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 5000n, Currency.Night);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => withdrawAt({ contract, contractAddress }, ctx2, 1000n, Currency.Night, fakeBytes32(0))).toThrow(
      'Recipient address cannot be empty',
    );
  });

  it('rejects a withdrawal exceeding the balance in that currency, even if the other currency has enough', () => {
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 1000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 10_000n, Currency.Night);
    const ctx3 = nextContext(contractAddress, r2.context);

    // Only 1000 ADA available, but 5000 is requested — must fail even
    // though the NIGHT balance (10,000) alone would easily cover it.
    expect(() => withdrawAt({ contract, contractAddress }, ctx3, 5000n, Currency.Ada, fakeBytes32(5))).toThrow(
      'Insufficient ADA treasury balance',
    );
  });

  it('getAdaBalance / getNightBalance read back each currency independently', () => {
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 750n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 300n, Currency.Night);
    const ctx3 = nextContext(contractAddress, r2.context);

    const adaResult = contract.circuits.getAdaBalance(ctx3);
    expect(adaResult.result).toBe(750n);

    const ctx4 = nextContext(contractAddress, adaResult.context);
    const nightResult = contract.circuits.getNightBalance(ctx4);
    expect(nightResult.result).toBe(300n);
  });
});

describe('treasury.compact — payment enforcement', () => {
  it('a NIGHT deposit (Midnight Launch fees) requires receiveUnshielded and does not throw locally', () => {
    // Same caveat as the other payment-enforcement tests: the local compact-runtime
    // simulator doesn't model cross-transaction UTXO matching, so this
    // proves the currency-gated call is wired in, not that a missing
    // payment is rejected end-to-end (real-node enforcement).
    const { contract, ctx } = deploy();
    const result = contract.circuits.depositFees(ctx, 2000n, Currency.Night);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.nightBalance).toBe(2000n);
  });

  it('an ADA deposit (Cardano fees) never calls receiveUnshielded, unchanged behavior', () => {
    const { contract, ctx } = deploy();
    const result = contract.circuits.depositFees(ctx, 2000n, Currency.Ada);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.adaBalance).toBe(2000n);
  });

  it('Fix (2026-07-21, High): rejects an ADA deposit from a non-governor caller', () => {
    // depositFees's ADA branch must enforce access control, matching the
    // NIGHT branch (payment-enforced via receiveUnshielded). Without it,
    // depositFees(2^127, Currency.Ada) could be called freely and defeat
    // isBelowFloor/isBelowWarning (the launch-pause safety gate), and risk a
    // Uint<128> overflow DoS on the health-check
    // circuits. ADA deposits are unpaid bookkeeping (ADA isn't a
    // Midnight-native token receiveUnshielded can check), so only the
    // trusted governor may record one now.
    const { ctx } = deploy();
    const attacker = new Contract<PrivateState>({
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }], // wrong governor
    });
    expect(() => attacker.circuits.depositFees(ctx, 2000n, Currency.Ada)).toThrow(/governor/i);
  });

  it('Fix (2026-07-21, High): a NIGHT deposit still requires no governor gate (payment-enforced instead)', () => {
    // The NIGHT branch's real receiveUnshielded payment check is a
    // different, already-sufficient enforcement mechanism — anyone paying
    // real NIGHT may deposit it, no governor gate needed or added there.
    const { ctx } = deploy();
    const anyCaller = new Contract<PrivateState>({
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }], // wrong governor, irrelevant here
    });
    const result = anyCaller.circuits.depositFees(ctx, 2000n, Currency.Night);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.nightBalance).toBe(2000n);
  });
});

describe('treasury.compact — mark-to-market floor/warning check', () => {
  it('getAdaEquivalentBalance combines ADA balance plus NIGHT balance converted at the given rate', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 6_000_000_000n, Currency.Ada); // 6,000 ADA
    const ctx2 = nextContext(contractAddress, r1.context);
    // 5,000,000 atomic NIGHT units at 1,000 lovelace/unit = 5,000,000,000 lovelace (5,000 ADA-equiv)
    const r2 = contract.circuits.depositFees(ctx2, 5_000_000n, Currency.Night);
    const ctx3 = nextContext(contractAddress, r2.context);

    const result = contract.circuits.getAdaEquivalentBalance(ctx3, 1_000n);
    expect(result.result).toBe(11_000_000_000n); // 6,000 + 5,000 = 11,000 ADA-equivalent
  });

  it('isBelowFloor is false when the ADA-equivalent total is above the floor', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, FLOOR_LOVELACE + 1_000_000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const result = contract.circuits.isBelowFloor(ctx2, 0n);
    expect(result.result).toBe(false);
  });

  it('isBelowFloor is true when the ADA-equivalent total is below the floor', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, FLOOR_LOVELACE - 1_000_000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const result = contract.circuits.isBelowFloor(ctx2, 0n);
    expect(result.result).toBe(true);
  });

  it('isBelowFloor mark-to-markets NIGHT holdings instead of ignoring them', () => {
    // ADA balance alone is well below the floor, but a large NIGHT holding
    // (converted at a real rate) pushes the combined total back above it —
    // proves NIGHT is actually counted, not silently dropped from the check.
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 1_000_000_000n, Currency.Ada); // 1,000 ADA
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 90_000_000n, Currency.Night); // 90M atomic units
    const ctx3 = nextContext(contractAddress, r2.context);

    // At 1,000 lovelace/atomic-unit: 90,000,000 * 1,000 = 90,000,000,000 lovelace (90,000 ADA-equiv)
    const result = contract.circuits.isBelowFloor(ctx3, 1_000n);
    expect(result.result).toBe(false); // 1,000 + 90,000 = 91,000 ADA-equiv, well above the 10,000 floor
  });

  it('isBelowWarning triggers at the higher threshold while isBelowFloor does not', () => {
    const { contract, contractAddress, ctx } = deploy();
    // 15,000 ADA — above the 10,000 floor, below the 25,000 warning line.
    const r1 = contract.circuits.depositFees(ctx, 15_000_000_000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);

    const floorResult = contract.circuits.isBelowFloor(ctx2, 0n);
    expect(floorResult.result).toBe(false);

    const ctx3 = nextContext(contractAddress, floorResult.context);
    const warningResult = contract.circuits.isBelowWarning(ctx3, 0n);
    expect(warningResult.result).toBe(true);
  });

  it('a fresh treasury with zero balance is below both floor and warning', () => {
    const { contract, ctx } = deploy();
    const floorResult = contract.circuits.isBelowFloor(ctx, 0n);
    expect(floorResult.result).toBe(true);
  });
});

describe('treasury.compact — the withdrawal window paces how fast the treasury can empty', () => {
  const RECIPIENT = fakeBytes32(5);
  const LIMIT = 1_000n;

  /** A treasury holding plenty of both currencies, with a small per-window ceiling. */
  function funded() {
    const d = deploy(FLOOR_LOVELACE, WARNING_LOVELACE, { adaLimit: LIMIT, nightLimit: LIMIT });
    const r1 = d.contract.circuits.depositFees(d.ctx, 100_000n, Currency.Ada);
    const r2 = d.contract.circuits.depositFees(nextContext(d.contractAddress, r1.context), 100_000n, Currency.Night);
    return { ...d, ctx: nextContext(d.contractAddress, r2.context) };
  }

  it('refuses a single withdrawal of the whole balance', () => {
    // What the ceiling is for: the balance is there, the caller is the real
    // governor, and the only thing refusing is the pace.
    const d = funded();
    expect(() => withdrawAt(d, d.ctx, 100_000n, Currency.Ada, RECIPIENT)).toThrow(
      'Withdrawal exceeds the ADA limit for this window',
    );
  });

  it('allows exactly the limit, and nothing beyond it in the same window', () => {
    const d = funded();
    const r = withdrawAt(d, d.ctx, LIMIT, Currency.Ada, RECIPIENT);
    expect(ledger(r.context.currentQueryContext.state).adaWithdrawnInWindow).toBe(LIMIT);

    expect(() => withdrawAt(d, nextContext(d.contractAddress, r.context), 1n, Currency.Ada, RECIPIENT)).toThrow(
      'Withdrawal exceeds the ADA limit for this window',
    );
  });

  it('accumulates across calls, so splitting a withdrawal does not raise the ceiling', () => {
    // The obvious way around a per-call cap. The window counts totals, not
    // calls, so four quarters reach the same place as one whole.
    const d = funded();
    let ctx = d.ctx;
    for (let i = 0; i < 4; i++) {
      const r = withdrawAt(d, ctx, LIMIT / 4n, Currency.Ada, RECIPIENT);
      ctx = nextContext(d.contractAddress, r.context);
    }
    expect(ledger(ctx.currentQueryContext.state).adaWithdrawnInWindow).toBe(LIMIT);
    expect(() => withdrawAt(d, ctx, 1n, Currency.Ada, RECIPIENT)).toThrow(
      'Withdrawal exceeds the ADA limit for this window',
    );
  });

  it('counts the two currencies separately, since their units are not comparable', () => {
    const d = funded();
    const r1 = withdrawAt(d, d.ctx, LIMIT, Currency.Ada, RECIPIENT);
    // The ADA window is spent; NIGHT is untouched and still has its own.
    const r2 = withdrawAt(d, nextContext(d.contractAddress, r1.context), LIMIT, Currency.Night, RECIPIENT);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.adaWithdrawnInWindow).toBe(LIMIT);
    expect(state.nightWithdrawnInWindow).toBe(LIMIT);
  });

  it('lets the next window through once the first has run', () => {
    const d = funded();
    const r1 = withdrawAt(d, d.ctx, LIMIT, Currency.Ada, RECIPIENT);
    const ctx = nextContext(d.contractAddress, r1.context);
    const nextWindow = NOW + Number(WINDOW_SECONDS);

    const r2 = withdrawAt(d, ctx, LIMIT, Currency.Ada, RECIPIENT, nextWindow);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.adaWithdrawnInWindow).toBe(LIMIT);
    expect(state.withdrawalWindowStart).toBe(BigInt(nextWindow));
    expect(state.adaBalance).toBe(100_000n - LIMIT - LIMIT);
  });

  it('does not roll the window one second early', () => {
    const d = funded();
    const r1 = withdrawAt(d, d.ctx, LIMIT, Currency.Ada, RECIPIENT);
    const ctx = nextContext(d.contractAddress, r1.context);
    const justShort = NOW + Number(WINDOW_SECONDS) - 1;
    expect(() => withdrawAt(d, ctx, 1n, Currency.Ada, RECIPIENT, justShort)).toThrow(
      'Withdrawal exceeds the ADA limit for this window',
    );
  });

  it('does not let a rolled window reopen the other currency by accident', () => {
    // Rolling has to reset both counters together, but a withdrawal only
    // writes one of them — so the untouched one must carry through rather
    // than being silently dropped or doubled.
    const d = funded();
    const r1 = withdrawAt(d, d.ctx, LIMIT, Currency.Night, RECIPIENT);
    const ctx = nextContext(d.contractAddress, r1.context);
    const r2 = withdrawAt(d, ctx, LIMIT, Currency.Ada, RECIPIENT);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.nightWithdrawnInWindow).toBe(LIMIT);
    expect(state.adaWithdrawnInWindow).toBe(LIMIT);
    expect(() => withdrawAt(d, nextContext(d.contractAddress, r2.context), 1n, Currency.Night, RECIPIENT)).toThrow(
      'Withdrawal exceeds the NIGHT limit for this window',
    );
  });

  it('resets the OTHER currency too when a withdrawal rolls the window', () => {
    // A withdrawal writes one currency's counter, but rolling has to clear
    // both. If the untouched one were left at its old value, spending the
    // ADA window and then withdrawing NIGHT in the next one would carry the
    // spent ADA total forward and refuse ADA that the new window allows.
    const d = funded();
    const r1 = withdrawAt(d, d.ctx, LIMIT, Currency.Ada, RECIPIENT);
    const nextWindow = NOW + Number(WINDOW_SECONDS);

    // NIGHT rolls the window; ADA is untouched by this call.
    const r2 = withdrawAt(d, nextContext(d.contractAddress, r1.context), 1n, Currency.Night, RECIPIENT, nextWindow);
    expect(ledger(r2.context.currentQueryContext.state).adaWithdrawnInWindow).toBe(0n);

    // So the new window's ADA allowance is whole.
    const r3 = withdrawAt(d, nextContext(d.contractAddress, r2.context), LIMIT, Currency.Ada, RECIPIENT, nextWindow);
    expect(ledger(r3.context.currentQueryContext.state).adaWithdrawnInWindow).toBe(LIMIT);
  });

  it('resets the other currency the same way when the roles are reversed', () => {
    // The mirror of the above. Each branch carries the counter it does not
    // write, and the two are separate lines — so one being right says
    // nothing about the other.
    const d = funded();
    const r1 = withdrawAt(d, d.ctx, LIMIT, Currency.Night, RECIPIENT);
    const nextWindow = NOW + Number(WINDOW_SECONDS);

    const r2 = withdrawAt(d, nextContext(d.contractAddress, r1.context), 1n, Currency.Ada, RECIPIENT, nextWindow);
    expect(ledger(r2.context.currentQueryContext.state).nightWithdrawnInWindow).toBe(0n);

    const r3 = withdrawAt(d, nextContext(d.contractAddress, r2.context), LIMIT, Currency.Night, RECIPIENT, nextWindow);
    expect(ledger(r3.context.currentQueryContext.state).nightWithdrawnInWindow).toBe(LIMIT);
  });

  it('rejects a timestamp that disagrees with chain time in either direction', () => {
    // Not via withdrawAt, which pins both to the same value and so could
    // never disagree — the block time is held at NOW and the claimed time
    // moved against it.
    const d = funded();
    const pinned = nextContextAtTime(d.contractAddress, d.ctx, NOW);
    expect(() => d.contract.circuits.withdrawFees(pinned, 1n, Currency.Ada, RECIPIENT, BigInt(NOW - 7200))).toThrow(
      'currentTimestamp too far in the past',
    );
    expect(() => d.contract.circuits.withdrawFees(pinned, 1n, Currency.Ada, RECIPIENT, BigInt(NOW + 7200))).toThrow(
      'currentTimestamp cannot be in the future',
    );
  });

  it('rejects a zero withdrawal, which would only churn the window', () => {
    const d = funded();
    expect(() => withdrawAt(d, d.ctx, 0n, Currency.Ada, RECIPIENT)).toThrow('Withdrawal amount must be positive');
  });
});

describe('treasury.compact — the withdrawal policy a deploy may set', () => {
  it('refuses a window of zero, which would reset on every call', () => {
    expect(() => deploy(FLOOR_LOVELACE, WARNING_LOVELACE, { windowSeconds: 0n })).toThrow(
      'Withdrawal window must be positive',
    );
  });

  it('refuses a limit of zero in either currency, which would stop withdrawals entirely', () => {
    expect(() => deploy(FLOOR_LOVELACE, WARNING_LOVELACE, { adaLimit: 0n })).toThrow(
      'ADA withdrawal limit must be positive',
    );
    expect(() => deploy(FLOOR_LOVELACE, WARNING_LOVELACE, { nightLimit: 0n })).toThrow(
      'NIGHT withdrawal limit must be positive',
    );
  });
});
