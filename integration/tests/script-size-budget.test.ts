// script-size-budget.test.ts — compiled validator sizes, measured.
//
// Cardano caps a transaction at 16,384 bytes, and a validator spent with
// Lucid Evolution is EMBEDDED in the witness set rather than referenced: the
// library always calls `PlutusScriptWitness.new_script`, so `readFrom` cannot
// make a spend use a published reference script. A validator's compiled size
// is therefore charged in full against that cap, once per validator a
// transaction spends.
//
// That budget had no test. Sizes have grown steadily — thread NFTs, the cap
// accumulator, value conservation, settlement tags — and each change was
// individually small enough not to prompt a measurement. This records the
// current figures so the next change has to acknowledge its cost, and fails
// loudly if one crosses the cap on its own.
//
// These are recorded values, not targets. When a change moves one, update the
// number in the same commit — the point is that it becomes a visible decision
// rather than a silent drift.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_PUBLISHABLE_SCRIPT_BYTES, MAX_TX_BYTES } from '../reference-script.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string; hash?: string }>;
}

const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);

/** Compiled size in bytes, keyed by validator module. */
const sizes = new Map<string, number>();
/** Compiled script hash, keyed by validator module. */
const hashes = new Map<string, string>();
for (const v of blueprint.validators) {
  const module = v.title.split('.')[0];
  if (!module) continue;
  sizes.set(module, v.compiledCode.length / 2);
  if (v.hash) hashes.set(module, v.hash);
}

/**
 * Measured 2026-08-08. Update in the same commit that moves one. Newest first.
 *
 * token_metadata +175, 2026-09-17: a metadata key that is present has to say
 * something. The map was already refused when empty, on the reasoning that a
 * token with nothing to display is broken; a present key holding an empty
 * string leaves a wallet exactly as empty-handed, so the same rule now reaches
 * the values. The cost is a walk of the whole map with two shapes to check per
 * value, because CIP-68 chunks anything past 64 bytes into a list of
 * bytestrings and both forms carry text. Integers are passed through
 * deliberately: `decimals: 0` is a real value and reading it as empty would
 * refuse the most ordinary launch on the platform.
 *
 * The other ten validators are byte for byte identical, including
 * launch_token_policy, which imports the same module — an added library
 * function nobody calls is not compiled in, and this register is where that is
 * measured rather than assumed.
 *
 * Last moved by the adversarial pass over the launch package, 2026-09-16 —
 * ten validators at once; launch_token_policy alone is byte for byte what it
 * was. Each figure is a guarantee the validator now makes:
 *
 *  - bonding_curve_tier_b +691: activating a curve keeps its value exactly;
 *    a fee claim takes the fee and leaves the token reserve; a batch settles
 *    each order once and only an order it spends; every deadline arm is
 *    measured against the validity range's lower bound; a payee is the
 *    community wallet only when the governance record is triggered and names
 *    it. 15,816 against the 16,052 B publish limit leaves 236 B — the
 *    validator to watch, and the reason the next field added to its datum
 *    has to be costed before it is written.
 *  - curve_order +2,769: an order is filled only by a batch of its own
 *    launch's curve that names it — it now decodes the curve's datum and the
 *    curve's redeemer — a sell fill is measured net of the order's own
 *    deposit, and cancelling an expired sell returns its lovelace too.
 *  - cto_sybil_challenge +1,260 and nhop_challenge +1,192: both take the
 *    thread-NFT policy as a parameter and require, at open, a governance
 *    record that names the governor; the bond floor is on chain; a sybil
 *    challenge commits to the challenged identity and reveals it only when
 *    upheld. Parameterised, so the DEPLOYED hash is the applied one, not the
 *    blueprint's recorded here.
 *  - lp_escrow +503: a migration's replacement position is under a policy
 *    other than the escrow's own thread NFT and the escrow keeps its ada; a
 *    harvest or migration by the community wallet re-reads the governance
 *    record and needs a wallet that is live.
 *  - staking_pool +305: a never-funded pool is funded only by its launch's
 *    graduation (read through the curve's own redeemer); an exhausted pool is
 *    refilled only by the creator or the governor; a stake that compounds a
 *    reward pays the charge; closing delivers the whole value to the creator.
 *  - cto_governance +195: the anchored bundle reference binds the allocation
 *    amount and recipient; an allocation names a positive amount and a payee;
 *    the window arms compare against the validity range's lower bound.
 *  - vesting +81 and token_metadata +46: starting a schedule keeps the
 *    allocation exactly; the community claim needs a live wallet; the metadata
 *    validator reads the curve under the role its thread NFT actually carries.
 *  - zk_anchor −21: `value_unchanged` compares the whole value, a shorter
 *    equality than the lovelace read it replaces.
 *
 * Every one of the ten hashes moved, so every one of their reference scripts
 * has to be re-derived before the next deploy.
 *
 * Last moved by bonding_curve_tier_b +271: the DarkVeil claim and settlement
 * windows became datum fields instead of compiled constants, so a launch
 * states its own terms and OpenDvClaim bounds them before starting the clock
 * they are measured from. Two read-only fields, declared at the BACK per this
 * datum's ordering rule, plus four bounds and two datum reads replacing two
 * constant reads. The linear curve did not move: it has no DarkVeil phase.
 *
 * Note what the 271 bytes BUY beyond configurability — the submitter used to
 * mirror both constants in its own source, and a mirror is only correct until
 * one side moves. It now reads the datum, so there is one place a window is
 * written and one place it is read.
 *
 * Last moved by bonding_curve +38: ActivateCurve now bounds the width of the
 * declared validity range, using the helper and constant the file's other
 * timestamp-gated arm already applies. It writes `phase_started_at`, which is
 * the origin ExpireCurve measures its 90-day backstop from, so pinning it to
 * real chain time keeps that deadline off the signer's own clock. Cardano Launch was
 * untouched — its four timestamp-gated arms already carry the bound — which
 * is why only one hash moved here, and only one reference script had to be
 * re-derived.
 *
 * Last moved by a positivity guard on the fee-claim amounts: bonding_curve
 * +21, bonding_curve_tier_b +22, for `amount > 0` on two claim arms each.
 * Twenty bytes for a check nobody should have to reason about is a good
 * trade, but note what it costs beyond the bytes — both HASHES moved, so
 * both script addresses moved, and any published reference script for either
 * curve has to be re-derived rather than reused.
 *
 * Last moved by SIX validators at once, for one datum field. cto_governance
 * gained `last_ballot_end_timestamp`, which is +141 there — and +10 to +12
 * each on bonding_curve, bonding_curve_tier_b, lp_escrow, token_metadata and
 * vesting, none of which changed a line. They all decode a CtoGovernanceDatum
 * as a reference input for their CTO check, so widening that type widens their
 * decoding too.
 *
 * Worth internalising before the next datum change: a field added to a SHARED
 * datum moves every validator that reads it, and each moved hash is a moved
 * script address. Six reference scripts would need re-deriving here, not one.
 *
 * Last moved by cto_governance +521: an anchored ballot's bundle reference is
 * now derived by the validator from its own datum rather than read out of the
 * redeemer, so the script carries the preimage construction and its hash. It
 * also changes the validator's HASH, which moves the script address — any
 * published reference script for it has to be re-derived rather than reused.
 *
 * Last moved by the lock on leaving a staking position becoming a per-launch
 * term: bonding_curve_tier_b +166 carries and bounds it, staking_pool +29
 * reads its own datum's copy instead of a constant, and token_metadata +10
 * decodes one more field of the curve datum it reads. Everything else is
 * byte for byte what it was.
 *
 * Previously moved by token_metadata +172: it decodes the curve it reads as a
 * reference input, and that is the quadratic curve now — the linear one left
 * the build, and its two rows left this register with it.
 *
 * Previously moved by token_metadata +113: authenticating the curve reference
 * input by its thread NFT rather than by a large token holding, which a
 * graduated curve no longer has, and requiring a metadata revision to keep
 * the two keys CIP-68's fungible sub-standard mandates.
 *
 * Last moved by the same mint-time authentication reaching the second
 * challenge contract (cto_sybil_challenge +896), by a harvest needing its
 * recipient's signature and their NET gain (lp_escrow +205), and by the
 * emergency path being able to clear a community wallet but not choose one
 * (cto_governance +16).
 *
 * Last moved by authenticating the one datum field a challenge could not
 * otherwise have checked at creation: nhop_challenge +883, for a `mint`
 * handler in the same validator. Paying a script address runs nothing, so
 * the submission time was whatever the challenger wrote; minting IS checked,
 * and a challenge now has to carry a token this script minted against a
 * narrow validity range. Both handlers compile to one script, so the policy
 * id is the validator's own hash and no second address is involved.
 *
 * Same pass, paying a payee's real address rather than a bare enterprise one:
 * lp_escrow +12, cto_governance +12, cto_sybil_challenge +11.
 *
 * Last moved by requiring a payee to be NET better off by what they are
 * owed, not merely to hold it in some output: the linear curve +201, Cardano Launch +178,
 * staking_pool +209. An output at the payee's own credential is equally
 * consistent with their change, and both of these paths are signed by the
 * payee, so the transaction can contain their own utxos. Netting those out
 * is what makes the payment check mean the payee gained something.
 *
 * Last moved by requiring a graduating Cardano Launch curve to have raised something:
 * +18, for the guard the linear curve has had since the same audit found it. At zero
 * raised, both of that arm's value checks stop constraining anything.
 *
 * Before that, letting ExpireCurve reach a curve that was minted and never
 * activated: the linear curve +24, Cardano Launch +16, for one extra state in each arm's
 * disjunction. Both ways out of that state are governor-signed, so the cost
 * buys a launch's whole supply a way out that does not depend on one key
 * still answering.
 *
 * Before that, ordering both curve datums so the fields a redeemer REWRITES
 * are declared before the fields only read: the linear curve −1,258, Cardano Launch −2,253, and
 * token_metadata +27 because it reads the linear curve's datum and its fields moved
 * back. A record update walks the field list to reach what it replaces, so
 * cost scales with the updated field's index — measured at ~10.5 bytes of
 * script per index position per update site, against ~0.15 for a read, which
 * is why paying 27 bytes of reads to save 3,511 of updates is the right trade.
 * No behaviour changed; the datum encoding is positional, so
 * integration/tier-a-schemas.ts moved with it.
 *
 * Before that, refusing a graduation output that carries a staking
 * credential: the linear curve +43, Cardano Launch +44. `Graduate` is permissionless, so without
 * it whoever submits one chooses where the locked LP delegates for a year.
 *
 * Before that, binding an order's payout to the owner's OWN address rather
 * than their payment credential alone: `curve_order` +73, to carry the staking
 * part of that address and match on the whole of it. That buys two things — a
 * fill an ordinary wallet can actually spend, and a payout a batcher cannot
 * redirect to a staking credential of its own.
 *
 * Before that, the batch fixes: both curves and the order validator grew so
 * that a batched fill names the order it settles, and so that a batch verifies
 * the curve's own value moved by what it claims. The linear curve +169, Cardano Launch +174,
 * curve_order +196 — paid knowingly, and partly bought back by routing the
 * batch's value check through the two helpers a single trade already uses.
 * Most recently, cto_governance +761: AnchorVoteResult now reads the launch's
 * LP escrow UTXO as a reference input to learn when it graduated, so it
 * carries the escrow datum's decoder. That is what the size buys — a ballot
 * that cannot claim a window opening before the launch was eligible to hold
 * one. Well inside the 16,384 B cap; recorded here so the growth is a
 * decision rather than a surprise.
 */
/*
 * Moved by the trustless staking rebuild. Reward accounting came on chain, so
 * the pool grew a Merkle accumulator and an emission calculation (+1,084 B),
 * and both curves grew the seeding check that pins the pool's opening datum
 * (+~1,090 B each) — the check that stops a permissionless graduation opening
 * a pool already crediting its author with the whole reserve.
 *
 * Moved again by uniform batch clearing price: +219 on the quadratic curve,
 * +220 on the linear one.
 * The pricing decision predicted this would make the script SMALLER, on the reasoning
 * that `gross_range` runs once per batch instead of once per order. Measured,
 * it does not: the range function is one piece of code either way, called a
 * different number of times, and the pre-pass that totals each side is new
 * code that was not there before. ExUnits were measured too, on a real
 * 10-order batch: 134.22 M mem / 42.40 B cpu sequential against 135.22 M /
 * 42.79 B uniform — within a percent, and on the wrong side. The decision
 * stands on its other three reasons; the size argument was simply wrong and
 * should not be repeated.
 *
 * Cardano Launch is the one to watch: 15,551 against a 16,384 cap leaves 833 B,
 * DOWN from 1,052, and the binding limit is PUBLISHING it as a reference
 * script, which cannot be split across transactions. It has been over that
 * line before. Anything that would merge the two curves into one validator has
 * to fit inside what is left, and this change made that harder, not easier.
 *
 * Moved again by the batcher allowlist: +387 on the linear curve, +455 on the
 * quadratic one, for one datum field and the arm that rewrites it — and +39 on
 * token_metadata, which changed by not one line. It decodes the linear curve's
 * datum as a reference input, so widening that type widened its decoding too.
 * Three hashes moved here, not two.
 *
 * Moved again, DOWNWARD, by collapsing a forfeited challenge bond onto one
 * payout address instead of a treasury/ops pair: cto_governance −98,
 * nhop_challenge −64, cto_sybil_challenge −78 for the arithmetic and the second
 * payout, and −10 to −12 each on bonding_curve, bonding_curve_tier_b, lp_escrow,
 * token_metadata and vesting, none of which changed a line — they decode a
 * CtoGovernanceDatum as a reference input, so narrowing that type narrowed their
 * decoding too. The same shared-datum effect as the widenings above, in reverse.
 *
 * Moved again, and this is the one that bought the room back: the quadratic
 * curve no longer settles a direct public trade, which is -1,038. A trade
 * reaches it as an order applied in a batch, so the two arms refuse rather than
 * price, and all the arithmetic behind them went with them. 14,956 against
 * MAX_PUBLISHABLE_SCRIPT_BYTES (16,052) leaves 1,096 B — a real margin, where
 * the two changes before it had left 58.
 *
 * Two measurements taken while landing it, both worth keeping:
 *
 *  - Position in the datum is most of the cost. At the BACK of the record the
 *    same field cost +706 and put the curve at 16,257 — 205 B OVER the publish
 *    limit, so it could not have been published at all. Declared at the FRONT,
 *    with the fields redeemers rewrite, it costs +455. A record update walks
 *    the field list to reach what it replaces; this datum's own ordering rule
 *    says so, and this is what ignoring it costs.
 *  - The list is not the expense. A single `VerificationKeyHash` in place of
 *    the list measures 15,915 — 91 B cheaper for a strictly weaker mechanism
 *    (no second batcher, no rotation without a gap). Widening the datum type
 *    is what costs; the list on top of it is nearly free.
 *
 * Moved again by the staking pool's claim charge: staking_pool +294 for the
 * check, its netting helper and the floor, and +22 on EACH curve for a field
 * neither of them reads. Both curves author the pool's opening datum at
 * graduation and pin it again at mint, so widening that shared type widened
 * four call sites across two validators — the same shared-datum effect as the
 * batcher allowlist and the payout-address collapse above.
 *
 * +22 rather than the +455 that allowlist field cost, and the difference is
 * position again. This datum groups its immutable terms first and its moving
 * state last, which is the opposite of the curve datum's layout, so the cheap
 * end here is the BACK: appending leaves the five fields every redeemer
 * rewrites at the indices they already had. The rule is the same in both — put
 * the new field where the update sites are not — and it reads as opposite only
 * because the two records are laid out opposite ways.
 *
 * staking_pool +54, charging the exit. The exit arm reuses the netting helper
 * and the constant the claim already had, so what it costs is the call and the
 * short-circuit around it — a fraction of the +294 the charge cost when it was
 * built, which is the ordinary shape of adding a second caller to a helper that
 * already exists.
 *
 * bonding_curve_tier_b +5, and this one is not a source change at all. The
 * committed blueprint had been built from a source state slightly earlier than
 * the source committed beside it, so it recorded 14,953 and hash 04d70f3e while
 * the tracked source builds to 14,958 and 19a184ae. Rebuilding on the same
 * toolchain (aiken v1.1.23, stdlib v3.1.0) reproduced ten of the twelve
 * validators byte-for-byte, which is what makes the two that moved readable as
 * causes rather than noise. Whatever a blueprint records is only as good as the
 * source it was built from, and only a local rebuild says which.
 *
 * bonding_curve +1 and bonding_curve_tier_b +1, naming the platform charge on a
 * creator-fee claim in ada. The figure moved from 200,000 to 5,000,000 so that
 * it clears the protocol's own minimum ada for the output carrying it (a real
 * claim measured 1,055,950) — below that, min-ada is what binds and the number
 * written in the contract never applies. One byte is the whole cost: it is the
 * same constant in the same position, one CBOR width wider. The ten validators
 * that did not change are byte-for-byte identical, which is what makes these
 * two readable as the cause.
 */
const RECORDED: Record<string, number> = {
  bonding_curve_tier_b: 15_816,
  cto_governance: 8_157,
  cto_sybil_challenge: 3_383,
  curve_order: 4_544,
  launch_token_policy: 419,
  lp_escrow: 8_178,
  nhop_challenge: 3_285,
  staking_pool: 5_835,
  token_metadata: 5_024,
  vesting: 5_867,
  zk_anchor: 2_613,
};

/**
 * The compiled hash of each validator, which is what decides its address.
 *
 * Pinned for a reason the size register above cannot cover on its own: size is
 * a proxy for change, and a poor one at the margin. Swapping a constant for
 * another of the same width moves the hash and every address derived from it
 * while leaving the length untouched, and nothing here would have said so.
 *
 * It also pins the blueprint to its own source. A committed blueprint is only
 * as good as the source state it was built from, and the two can part company
 * without anything failing — a drift of exactly that kind sat in this file
 * unnoticed from 2026-09-07 until a rebuild on 2026-09-09 measured it. With
 * these recorded, a blueprint rebuilt from different source says so here
 * instead of waiting to be noticed.
 *
 * Same rule as the sizes: when a change moves one, update it in the same
 * commit. A moved hash is a moved address, so anything already living at the
 * old one has to be considered before the change ships.
 */
const RECORDED_HASHES: Record<string, string> = {
  bonding_curve_tier_b: 'cacf42199fa107916db59de6b635da51258b5bf499f0c6e479b8cc86',
  cto_governance: '2acc12d791956e7da4c72c2cf1c4a8ceee74b9d7e33973cc973fa022',
  cto_sybil_challenge: 'f08befe8c02028948af4d01dfc27121bfdd7dd6582e582fd5a216441',
  curve_order: 'bc9e33b3e17caa01d36c16a776f3c7527236de13911519abf19d5740',
  launch_token_policy: 'd77d785500b7bb5a80bdf8104651b13e59d546d222ce7ab22bb60965',
  lp_escrow: '0c93febe5966945efac06debcc4b6acab376c3c3cda6836cf12db687',
  nhop_challenge: '0d70cb4bcea572833ea9367f569e71042ada1e34f218c1677ad245fb',
  staking_pool: '1f4afea6652972deb367192ff26207c0a599b5f1ed0683a45cd41cdd',
  token_metadata: '9f996561e6b63e84156171fd4039b13d7606f61470c1a1c0ecf5310a',
  vesting: 'd6d1ce3fff91223a4533429c110a72c1359c89fc79dc29831496c63d',
  zk_anchor: '95750d0fe26787711f9937916194681047e15d8652f13a0b65b382e4',
};

describe('compiled validator hashes', () => {
  it('has a recorded hash for every validator in the blueprint', () => {
    expect([...hashes.keys()].sort()).toEqual(Object.keys(RECORDED_HASHES).sort());
  });

  for (const [module, recorded] of Object.entries(RECORDED_HASHES)) {
    it(`${module} hashes to ${recorded.slice(0, 12)}…`, () => {
      expect(hashes.get(module)).toBe(recorded);
    });
  }

  // A blake2b-224 script hash is 28 bytes. Anything else is not one, and an
  // address derived from it would not be the address anyone meant.
  for (const [module, recorded] of Object.entries(RECORDED_HASHES)) {
    it(`${module}'s hash is 28 bytes of hex`, () => {
      expect(recorded).toMatch(/^[0-9a-f]{56}$/);
    });
  }
});

describe('compiled validator sizes', () => {
  it('has a recorded size for every validator in the blueprint', () => {
    expect([...sizes.keys()].sort()).toEqual(Object.keys(RECORDED).sort());
  });

  for (const [module, recorded] of Object.entries(RECORDED)) {
    it(`${module} is ${recorded} bytes`, () => {
      expect(sizes.get(module)).toBe(recorded);
    });
  }

  // A validator larger than the whole transaction cap cannot be spent at all
  // by a library that embeds it, whatever else the transaction contains.
  for (const [module, recorded] of Object.entries(RECORDED)) {
    it(`${module} fits inside one transaction on its own`, () => {
      expect(recorded).toBeLessThan(MAX_TX_BYTES);
    });
  }

  // The harder ceiling, and now the binding one. Referencing a script lifts
  // the SPENDING budget, but the script has to be PUBLISHED first — by an
  // ordinary transaction bound by the same cap, serialising the script whole
  // into one output. That cannot be split. Cardano Launch has been over this line
  // before and is the closest to it now, so it gets a test rather than a note.
  for (const [module, recorded] of Object.entries(RECORDED)) {
    it(`${module} is small enough to publish as a reference script`, () => {
      expect(recorded).toBeLessThanOrEqual(MAX_PUBLISHABLE_SCRIPT_BYTES);
    });
  }

  // A budget is per TRANSACTION, and a graduation spends three validators at
  // once: the curve (Graduate), lp_escrow (SealLock) and staking_pool
  // (TopUpPool). The per-script assertions above cannot see that sum — each
  // curve + lp_escrow pair alone is over the cap, which is exactly why the
  // graduation submitters reference both and carry only the pool. This
  // records the shape as measurements: the pair must stay unembeddable-
  // together knowledge (so nobody quietly reverts to carrying them), and the
  // one script a graduation DOES carry must leave room for everything else.
  // The full built transaction is measured in mesh-curve-spend.test.ts.
  describe('the graduation transaction', () => {
    const curveB = RECORDED.bonding_curve_tier_b ?? 0;
    const lp = RECORDED.lp_escrow ?? 0;
    const pool = RECORDED.staking_pool ?? 0;
    // Everything in a real graduation that is not a script: three inputs with
    // datum-bearing outputs, redeemers, signatures, fee/change. Measured on
    // a real build at ~2.5 KB; doubled for margin.
    const GRADUATION_OVERHEAD = 5_000;

    it('cannot carry both of its big validators — they must be referenced', () => {
      expect(curveB + lp).toBeGreaterThan(MAX_TX_BYTES);
    });

    it('fits with the curve and escrow referenced and only staking_pool carried', () => {
      expect(pool + GRADUATION_OVERHEAD).toBeLessThan(MAX_TX_BYTES);
    });
  });
});
