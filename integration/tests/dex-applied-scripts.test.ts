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
