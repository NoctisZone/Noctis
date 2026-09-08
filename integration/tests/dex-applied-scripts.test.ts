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

const CONTRACTS = join(import.meta.dirname, '..', '..', 'contracts');

interface AppliedValidator {
  title: string;
  unappliedHash: string;
  parameters: Array<{ title: string; source: string; value: string }>;
  compiledCode: string;
  hash: string;
  preprodAddress: string;
}

const applied = JSON.parse(readFileSync(join(CONTRACTS, 'cardano-dex', 'deployment', 'applied.json'), 'utf8')) as {
  validators: AppliedValidator[];
};

const venue = JSON.parse(readFileSync(join(CONTRACTS, 'cardano-dex', 'plutus.json'), 'utf8')) as {
  validators: Array<{ title: string; compiledCode: string; hash: string }>;
};

const byTitle = new Map(venue.validators.map((v) => [v.title, v]));

describe('the applied venue scripts', () => {
  it('records both of the ones the package can fix on its own', () => {
    expect(applied.validators.map((v) => v.title)).toEqual([
      'royalty_pool/single_royalty_withdraw_pool.royalty_withdraw_pool.withdraw',
      'royalty_pool/pool.pool.spend',
    ]);
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
