// dex-applied-scripts.test.ts
//
// `contracts/cardano-dex/deployment/applied.json` records the venue scripts as
// they actually deploy: a parameterised validator's compiled form is not a
// deployable script, and the bytes that are come from `aiken blueprint apply`.
// Nothing in this repository can re-run that application, so what these tests
// establish is the next best thing and the thing that has actually gone wrong
// before — that the bytes and the hash recorded beside them agree, derived by a
// different implementation from the one that wrote them.
//
// A hash that disagrees with its own bytes is not a cosmetic error. It is a
// deposit published to an address nothing will ever spend from, discovered at
// the point of use, with no republish that reaches it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scriptHashOf } from '../reference-script.js';
import { readVenueFactoryParameters, VENUE_FACTORY_TITLE } from '../venue-pool.js';

const CONTRACTS = join(import.meta.dirname, '..', '..', 'contracts');

interface AppliedValidator {
  title: string;
  unappliedHash: string;
  parameters: Array<{ title: string; source: string; value: string }>;
  compiledCode: string;
  hash: string;
  /** Only on the two whose parameters the package fixes on its own. */
  preprodAddress?: string;
  /** Only on the ones whose parameters come from a particular deployment. */
  network?: string;
}

const applied = JSON.parse(readFileSync(join(CONTRACTS, 'cardano-dex', 'deployment', 'applied.json'), 'utf8')) as {
  validators: AppliedValidator[];
};

const venue = JSON.parse(readFileSync(join(CONTRACTS, 'cardano-dex', 'plutus.json'), 'utf8')) as {
  validators: Array<{ title: string; compiledCode: string; hash: string }>;
};

const byTitle = new Map(venue.validators.map((v) => [v.title, v]));

describe('the applied venue scripts', () => {
  it('records exactly the venue scripts that have been applied so far', () => {
    // Pinned rather than counted: an entry appearing here without anyone
    // noticing is the failure this guards against, and a length check would
    // not see a substitution.
    expect(applied.validators.map((v) => v.title)).toEqual([
      // Fixed by the package alone — the same on every network.
      'royalty_pool/single_royalty_withdraw_pool.royalty_withdraw_pool.withdraw',
      'royalty_pool/pool.pool.spend',
      // Fixed by a deployment — these carry the platform's own thread NFT
      // policy and payout key, so they belong to one network.
      'royalty_pool/redirect.redirect.withdraw',
      'royalty_pool/treasury.treasury.withdraw',
      'royalty_pool/pool_mint.pool_mint.mint',
    ]);
  });

  it('says which deployment an entry belongs to, whenever that is a question', () => {
    // A hash derived from the platform's own keys is not portable, and an
    // entry that does not say so invites being read as if it were.
    const deploymentSpecific = [
      'royalty_pool/redirect.redirect.withdraw',
      'royalty_pool/treasury.treasury.withdraw',
      'royalty_pool/pool_mint.pool_mint.mint',
    ];
    for (const v of applied.validators) {
      if (deploymentSpecific.includes(v.title)) {
        expect(v.network, `${v.title} does not name its network`).toBe('preprod');
      } else {
        expect(v.network, `${v.title} follows from the package, so it has no network`).toBeUndefined();
      }
    }
  });

  it('records the factory the way the graduation submitter reads it', () => {
    // The real reader, not a copy of its rules. It rebuilds the pool's opening
    // datum from exactly these values and the factory refuses a datum built
    // from anything else, so a record it would reject is a record that cannot
    // graduate a launch — better to learn that here.
    const factory = applied.validators.find((v) => v.title === VENUE_FACTORY_TITLE);
    expect(factory, 'the factory is not recorded').toBeDefined();
    const params = readVenueFactoryParameters(factory as never);

    // The fee schedule is the platform's published post-graduation split, and
    // the denominator it is read against is fixed by the venue.
    expect(params.feeNum + 0n).toBe(99_900n);
    expect(params.treasuryFee).toBe(100n);
    expect(params.royaltyFee).toBe(1_000n);
    expect(params.feeNum + params.treasuryFee + params.royaltyFee).toBeLessThan(200_000n);
    expect(params.treasuryFee + params.royaltyFee).toBeLessThan(params.feeNum);

    // treasury.ak compares an output against VerificationKey(treasury_address),
    // so this is a payment key hash. A whole address is 57 bytes and would not
    // be a credential at all — a mistake that still applies cleanly and still
    // yields a real, reachable address.
    expect(params.treasuryAddressHex).toMatch(/^[0-9a-f]{56}$/);
    expect(params.threadNftPolicy).toMatch(/^[0-9a-f]{56}$/);
    expect(params.initialLq).toBe(1_000_000_000n);

    // The two it chains from must be the entries recorded above, not the
    // unapplied ones — applying the wrong dependency is the other way this
    // record can look right and describe a script nobody deployed.
    const byName = new Map(applied.validators.map((v) => [v.title, v]));
    expect(params.redirectValidatorHash).toBe(byName.get('royalty_pool/redirect.redirect.withdraw')?.hash);
    expect(params.treasuryValidatorHash).toBe(byName.get('royalty_pool/treasury.treasury.withdraw')?.hash);
    expect(params.poolValidatorHash).toBe(byName.get('royalty_pool/pool.pool.spend')?.hash);
  });

  // The one that matters. Every other check here is about provenance; this one
  // is about the address the deposit lands at.
  it.each(applied.validators)('$title hashes to the hash recorded with it', (v) => {
    expect(scriptHashOf(v.compiledCode).toLowerCase()).toBe(v.hash.toLowerCase());
  });

  it.each(applied.validators)('$title is a real application of the compiled validator', (v) => {
    const source = byTitle.get(v.title);
    expect(source, `${v.title} is not in the venue blueprint`).toBeDefined();
    // Applying a parameter changes the script, so these must differ — a file
    // that simply copied the compiled form would pass every other check here.
    expect(v.unappliedHash).toBe(source?.hash);
    expect(v.hash).not.toBe(v.unappliedHash);
    expect(v.compiledCode).not.toBe(source?.compiledCode);
  });

  it('chains the parameters in the order the deployment does', () => {
    const [withdrawPool, pool] = applied.validators;
    // Step 1 takes the hash of a validator with no parameters at all, so the
    // chain starts from something the blueprint alone fixes.
    const withdrawOrder = byTitle.get('royalty_pool/withdraw_order.withdraw_order.spend');
    expect(withdrawOrder?.title).toBeDefined();
    expect(withdrawPool?.parameters[0]?.value).toBe(withdrawOrder?.hash);
    // Step 2 takes step 1's applied hash — not its compiled one, which is the
    // substitution that would leave the pool naming a script nobody deploys.
    expect(pool?.parameters[0]?.value).toBe(withdrawPool?.hash);
    expect(pool?.parameters[0]?.value).not.toBe(withdrawPool?.unappliedHash);
  });

  it('names the parameter each validator actually declares', () => {
    for (const v of applied.validators) {
      const declared = (
        JSON.parse(readFileSync(join(CONTRACTS, 'cardano-dex', 'plutus.json'), 'utf8')) as {
          validators: Array<{ title: string; parameters?: Array<{ title: string }> }>;
        }
      ).validators.find((x) => x.title === v.title)?.parameters;
      expect(declared?.map((p) => p.title)).toEqual(v.parameters.map((p) => p.title));
    }
  });
});

/**
 * A recorded parameter value, as CBOR — which is the form `aiken blueprint
 * apply` writes into the script.
 *
 * A hash is a 28-byte bytestring; everything else here is a non-negative
 * integer. The hash branch is tried first and is exact about its shape, so a
 * value that is neither is rejected rather than guessed at.
 */
function cborOfParameterValue(value: string): string {
  if (/^[0-9a-f]{56}$/.test(value)) return `581c${value}`;
  if (!/^[0-9]+$/.test(value)) throw new Error(`parameter value ${value} is neither a 28-byte hash nor an integer`);
  const n = BigInt(value);
  if (n < 24n) return n.toString(16).padStart(2, '0');
  if (n < 0x100n) return `18${n.toString(16).padStart(2, '0')}`;
  if (n < 0x10000n) return `19${n.toString(16).padStart(4, '0')}`;
  if (n < 0x100000000n) return `1a${n.toString(16).padStart(8, '0')}`;
  return `1b${n.toString(16).padStart(16, '0')}`;
}

/**
 * Walk a validator's declared parameters through its applied bytes, in order,
 * and report where each one's CBOR actually sits.
 *
 * Returns one entry per parameter. `offset` is -1 for a value that is not
 * there at all, which is the whole point: this is the only thing in this file
 * that can tell a wrong RECORDED NUMBER from a right one.
 */
function locateParameters(v: AppliedValidator, overrides: Record<string, string> = {}) {
  let cursor = 0;
  return v.parameters.map((p) => {
    const cbor = cborOfParameterValue(overrides[p.title] ?? p.value);
    const offset = v.compiledCode.indexOf(cbor, cursor);
    if (offset !== -1) cursor = offset + cbor.length;
    return { title: p.title, cbor, offset, end: offset === -1 ? -1 : offset + cbor.length };
  });
}

/**
 * THE GAP THE REST OF THIS FILE LEAVES, and why these tests exist.
 *
 * Every other check here binds bytes to a hash, a hash to a blueprint, or one
 * entry's hash to the next entry's parameter. Not one of them reads a
 * parameter's recorded value out of the COMPILED BYTES. Be precise about what
 * that did and did not leave open, because the two scalars differ:
 *
 *   - `fee_num`, `treasury_fee`, `royalty_fee` and `initial_lq` are pinned to
 *     literals by the factory-reader test above. That catches a typo in the
 *     record. It CANNOT catch a record that disagrees with the bytes beside
 *     it, because the literal and the record would then agree with each other
 *     and both be wrong about what deploys.
 *   - `max_treasury_fee` had neither. It is not a factory parameter, so the
 *     reader never sees it, and nothing else looked. A wrong value there
 *     passed all fifteen checks and read as verified.
 *
 * The apply step is hand-run and nothing in this repository can replay it, so
 * "the record disagrees with the bytes" is not a hypothetical failure mode —
 * it is the one this file exists for, and it was the one it could not see.
 *
 * WHY A CONTAINMENT CHECK RATHER THAN A DECODE. Nothing in this repository can
 * re-run `aiken blueprint apply`, and nothing here decodes flat-encoded UPLC.
 * What can be done is exact about a smaller thing: an applied parameter is a
 * `Data` constant, flat pads to a byte boundary before a bytestring, and a
 * `Data` constant is carried as the CBOR of its value — so each parameter's
 * CBOR appears BYTE-ALIGNED in the region the application appended, in the
 * order the parameters are declared. That is measured, not assumed; the
 * offsets below hold for all five recorded entries.
 *
 * So this says: the recorded value's own bytes are in the script, where an
 * applied parameter goes, in the right order, and nowhere else that fits. It
 * does NOT say the flat encoding parses to exactly these constants. It is the
 * difference between an unchecked annotation and a checked one.
 */
describe('the recorded parameter VALUES are in the bytes, not just beside them', () => {
  it.each(applied.validators)('$title carries every recorded parameter value', (v) => {
    const found = locateParameters(v);
    for (const f of found) {
      expect(f.offset, `${v.title}: ${f.title} = ${f.cbor} is not in the applied bytes at all`).not.toBe(-1);
      // Flat pads to a byte boundary before a bytestring, so a Data constant
      // never starts mid-byte. A match at an odd hex index is a coincidental
      // run inside the program body, not a parameter.
      expect(f.offset % 2, `${v.title}: ${f.title} matched mid-byte, so it is not a constant`).toBe(0);
    }
  });

  it.each(applied.validators)('$title carries them in the appended region, in declared order', (v) => {
    const source = byTitle.get(v.title);
    const found = locateParameters(v);

    // The first parameter begins beyond where the unapplied validator's own
    // bytes ran out, so none of these is a match inside the program itself.
    expect(
      found[0]?.offset,
      `${v.title}: the first parameter matched inside the unapplied program, so it is a coincidence`,
    ).toBeGreaterThanOrEqual((source?.compiledCode.length ?? 0) as number);

    // Consecutive parameters sit a few bytes apart — the flat padding and
    // length prefix between them, nothing else. A large gap means an earlier
    // coincidental match was taken for the real one.
    for (let i = 1; i < found.length; i += 1) {
      const gap = (found[i]?.offset ?? 0) - (found[i - 1]?.end ?? 0);
      expect(gap, `${v.title}: ${found[i]?.title} sits ${gap} hex chars after the previous one`).toBeLessThanOrEqual(
        32,
      );
      expect(gap).toBeGreaterThan(0);
    }

    // And the last one runs to the end of the script. Applied parameters are
    // the tail; anything after them is the flat terminator.
    const tail = v.compiledCode.length - (found[found.length - 1]?.end ?? 0);
    expect(tail, `${v.title}: ${tail} hex chars follow the last parameter`).toBeLessThanOrEqual(16);
  });

  /**
   * NEUTERING THE CHECK, AS A TEST RATHER THAN AS A ONE-OFF.
   *
   * A containment check that cannot be seen to fail is worth nothing, and the
   * failure mode being guarded against is precisely a value that was recorded
   * wrong — so the proof has to be that a wrong value is REJECTED. Doing that
   * by hand once proves it on the day; doing it here proves it on every run,
   * including after someone makes the matcher more forgiving.
   */
  it.each(
    applied.validators.flatMap((v) =>
      v.parameters.filter((p) => /^[0-9]+$/.test(p.value)).map((p) => ({ title: v.title, param: p.title, v, p })),
    ),
  )('$title: a wrong $param would be caught', ({ v, p }) => {
    const wrong = (BigInt(p.value) + 1n).toString();
    const found = locateParameters(v, { [p.title]: wrong });
    const entry = found.find((f) => f.title === p.title);
    expect(entry?.cbor, 'the perturbed value encodes the same as the real one').not.toBe(cborOfParameterValue(p.value));
    expect(entry?.offset, `${p.title} = ${wrong} was found in bytes that carry ${p.value}`).toBe(-1);
  });

  it('covers every scalar the factory fixes, so none is left as an annotation', () => {
    // Named rather than counted. These five are the economic commitments
    // baked into the factory hash, and a parameter quietly dropping out of
    // this file is the failure a length check would not see.
    const factory = applied.validators.find((v) => v.title === VENUE_FACTORY_TITLE);
    const scalars = factory?.parameters.filter((p) => /^[0-9]+$/.test(p.value)).map((p) => p.title);
    expect(scalars).toEqual(['fee_num', 'treasury_fee', 'royalty_fee', 'initial_lq']);

    const treasury = applied.validators.find((v) => v.title === 'royalty_pool/treasury.treasury.withdraw');
    expect(treasury?.parameters.filter((p) => /^[0-9]+$/.test(p.value)).map((p) => p.title)).toEqual([
      'max_treasury_fee',
    ]);
  });
});
