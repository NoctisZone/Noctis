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
  validators: Array<{ title: string; compiledCode: string }>;
}

const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);

/** Compiled size in bytes, keyed by validator module. */
const sizes = new Map<string, number>();
for (const v of blueprint.validators) {
  const module = v.title.split('.')[0];
  if (module) sizes.set(module, v.compiledCode.length / 2);
}

/**
 * Measured 2026-08-08. Update in the same commit that moves one. Newest first.
 *
 * Last moved by bonding_curve_tier_b +271: the DarkVeil claim and settlement
 * windows became datum fields instead of compiled constants, so a launch
 * states its own terms and OpenDvClaim bounds them before starting the clock
 * they are measured from. Two read-only fields, declared at the BACK per this
 * datum's ordering rule, plus four bounds and two datum reads replacing two
 * constant reads. Tier A did not move: it has no DarkVeil phase.
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
 * real chain time keeps that deadline off the signer's own clock. Tier B was
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
 * Last moved by token_metadata +113: authenticating the curve reference
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
 * owed, not merely to hold it in some output: Tier A +201, Tier B +178,
 * staking_pool +209. An output at the payee's own credential is equally
 * consistent with their change, and both of these paths are signed by the
 * payee, so the transaction can contain their own utxos. Netting those out
 * is what makes the payment check mean the payee gained something.
 *
 * Last moved by requiring a graduating Tier B curve to have raised something:
 * +18, for the guard Tier A has had since the same audit found it. At zero
 * raised, both of that arm's value checks stop constraining anything.
 *
 * Before that, letting ExpireCurve reach a curve that was minted and never
 * activated: Tier A +24, Tier B +16, for one extra state in each arm's
 * disjunction. Both ways out of that state are governor-signed, so the cost
 * buys a launch's whole supply a way out that does not depend on one key
 * still answering.
 *
 * Before that, ordering both curve datums so the fields a redeemer REWRITES
 * are declared before the fields only read: Tier A −1,258, Tier B −2,253, and
 * token_metadata +27 because it reads Tier A's datum and its fields moved
 * back. A record update walks the field list to reach what it replaces, so
 * cost scales with the updated field's index — measured at ~10.5 bytes of
 * script per index position per update site, against ~0.15 for a read, which
 * is why paying 27 bytes of reads to save 3,511 of updates is the right trade.
 * No behaviour changed; the datum encoding is positional, so
 * integration/tier-a-schemas.ts moved with it.
 *
 * Before that, refusing a graduation output that carries a staking
 * credential: Tier A +43, Tier B +44. `Graduate` is permissionless, so without
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
 * the curve's own value moved by what it claims. Tier A +169, Tier B +174,
 * curve_order +196 — paid knowingly, and partly bought back by routing the
 * batch's value check through the two helpers a single trade already uses.
 * Most recently, cto_governance +761: AnchorVoteResult now reads the launch's
 * LP escrow UTXO as a reference input to learn when it graduated, so it
 * carries the escrow datum's decoder. That is what the size buys — a ballot
 * that cannot claim a window opening before the launch was eligible to hold
 * one. Well inside the 16,384 B cap; recorded here so the growth is a
 * decision rather than a surprise.
 */
const RECORDED: Record<string, number> = {
  bonding_curve: 11_198,
  bonding_curve_tier_b: 14_226,
  cto_governance: 8_060,
  cto_sybil_challenge: 2_201,
  curve_order: 1_775,
  launch_token_policy: 419,
  lp_escrow: 7_628,
  nhop_challenge: 2_157,
  staking_pool: 4_069,
  token_metadata: 4_581,
  vesting: 5_748,
  zk_anchor: 2_634,
};

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
  // into one output. That cannot be split. Tier B has been over this line
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
    const curveA = RECORDED.bonding_curve ?? 0;
    const curveB = RECORDED.bonding_curve_tier_b ?? 0;
    const lp = RECORDED.lp_escrow ?? 0;
    const pool = RECORDED.staking_pool ?? 0;
    // Everything in a real graduation that is not a script: three inputs with
    // datum-bearing outputs, redeemers, signatures, fee/change. Measured on
    // a real build at ~2.5 KB; doubled for margin.
    const GRADUATION_OVERHEAD = 5_000;

    it('cannot carry both of its big validators, either tier — they must be referenced', () => {
      expect(curveA + lp).toBeGreaterThan(MAX_TX_BYTES);
      expect(curveB + lp).toBeGreaterThan(MAX_TX_BYTES);
    });

    it('fits with the curve and escrow referenced and only staking_pool carried', () => {
      expect(pool + GRADUATION_OVERHEAD).toBeLessThan(MAX_TX_BYTES);
    });
  });
});
