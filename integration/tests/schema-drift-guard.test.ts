// schema-drift-guard.test.ts — asserts our hand-mirrored Lucid datum schemas
// still match the REAL compiled CIP-57 blueprint (contracts/cardano/plutus.json).
//
// WHY THIS EXISTS
// ---------------
// `tier-a-schemas.ts` is hand-written to mirror the compiled blueprint, and its
// own header says: "Re-verify against a freshly-regenerated plutus.json if any
// of the .ak files change after this date." That re-verification was a manual
// step nobody is reminded to do. It has already been missed for real once in
// this project: four datum shapes drifted when `cto_governance_credential` /
// `thread_nft_policy` (and vesting's `last_claimed_allocation_timestamp`) were
// added on-chain but not to the TypeScript mirror — which would have broken
// minting AND graduation against current bytecode, not just CTO.
//
// Drift of this kind is silent: TypeScript still compiles, and the failure only
// shows up as a rejected transaction against a real node. This test converts it
// into a failing unit test at the moment the blueprint is regenerated.
//
// Checked as a proper substitute for blueprint codegen, which was investigated
// 2026-08-02 and found unavailable without migrating SDKs: there is no blueprint
// package in the `@lucid-evolution` scope, `aiken blueprint convert --to` emits
// only `cardano-cli` format, and no standalone npm codegen tool exists.
//
// WHAT IS AND IS NOT COMPARED
// ---------------------------
// Compared strictly: constructor index, field COUNT, field ORDER, field NAMES,
// and each field's coarse kind (bytes / integer / boolean / list / map / enum).
// For enum fields, each variant's INDEX and field ARITY are compared.
//
// Variant TITLES are compared through a small documented alias table. Lucid's
// built-in Credential schema names its variants PubKeyCredential/ScriptCredential
// while Aiken's blueprint says VerificationKey/Script. Those are the same thing
// positionally (indices 0 and 1, one field each) — which is what the ledger
// actually cares about — so comparing raw titles would produce a permanent false
// failure. The alias table records that equivalence explicitly rather than
// silently skipping title checks everywhere.
//
// NOT compared: the exact inner type of list items and enum variant payloads.
// Field name + order + constructor index is where real drift shows up; going
// deeper would re-implement a schema compiler for diminishing returns.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Constr } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';

import { CtoGovernanceDatumShape as SubmitterCtoGovernanceDatumShape } from '../cardano-cto-anchor-submitter.js';

import {
  BondingCurveDatumShape,
  BondingCurveTierBDatumShape,
  batchOrderToPlutus,
  CtoGovernanceDatumShape,
  LpEscrowDatumShape,
  OrderDatumShape,
  OutputReferenceShape,
  StakePositionShape,
  StakingPoolDatumShape,
  VestingDatumShape,
} from '../tier-a-schemas.js';

// ---------------------------------------------------------------------------
// Blueprint loading
// ---------------------------------------------------------------------------

const BLUEPRINT_PATH = join(process.cwd(), '..', 'contracts', 'cardano', 'plutus.json');

interface BlueprintVariant {
  title?: string;
  dataType?: string;
  index?: number;
  fields?: BlueprintField[];
}
interface BlueprintField {
  title?: string;
  $ref?: string;
  dataType?: string;
  anyOf?: BlueprintVariant[];
  items?: unknown;
}
interface BlueprintDef {
  title?: string;
  dataType?: string;
  anyOf?: BlueprintVariant[];
  items?: unknown;
}
interface Blueprint {
  definitions: Record<string, BlueprintDef>;
}

const blueprint: Blueprint = JSON.parse(readFileSync(BLUEPRINT_PATH, 'utf-8')) as Blueprint;

/** `#/definitions/aiken~1crypto~1VerificationKeyHash` -> `aiken/crypto/VerificationKeyHash` */
function resolveRefName(ref: string): string {
  return decodeURIComponent(ref.split('/').pop() ?? '').replace(/~1/g, '/');
}

// ---------------------------------------------------------------------------
// Normalisation — both sides reduce to the same comparable shape
// ---------------------------------------------------------------------------

type Kind = 'bytes' | 'integer' | 'boolean' | 'list' | 'map' | 'enum' | 'unknown';

interface NormVariant {
  index: number;
  title: string;
  arity: number;
}
interface NormField {
  name: string;
  kind: Kind;
  variants?: NormVariant[];
}
interface NormDatum {
  index: number;
  fields: NormField[];
}

/**
 * Variant-title equivalences that are positionally identical but named
 * differently by Lucid vs Aiken. Keep this table SMALL and justified — each
 * entry is an assertion that the two names mean the same constructor index.
 */
const TITLE_ALIASES: Record<string, string> = {
  // Lucid's built-in CredentialSchema vs Aiken's cardano/address/Credential.
  PubKeyCredential: 'VerificationKey',
  ScriptCredential: 'Script',
};

function canonicalTitle(t: string): string {
  return TITLE_ALIASES[t] ?? t;
}

function variantsFrom(anyOf: BlueprintVariant[]): NormVariant[] {
  return anyOf.map((v, i) => ({
    index: v.index ?? i,
    title: canonicalTitle(v.title ?? ''),
    arity: (v.fields ?? []).length,
  }));
}

function isBooleanVariants(vs: NormVariant[]): boolean {
  return (
    vs.length === 2 &&
    vs.every((v) => v.arity === 0) &&
    vs.some((v) => v.title === 'False') &&
    vs.some((v) => v.title === 'True')
  );
}

/** Normalise one field of the compiled blueprint, resolving `$ref` indirection. */
function normalizeBlueprintField(field: BlueprintField): NormField {
  const name = field.title ?? '(unnamed)';

  let node: BlueprintField | BlueprintDef = field;
  if (field.$ref) {
    const resolved = blueprint.definitions[resolveRefName(field.$ref)];
    if (!resolved) return { name, kind: 'unknown' };
    node = resolved;
  }

  if (node.anyOf) {
    const vs = variantsFrom(node.anyOf);
    if (isBooleanVariants(vs)) return { name, kind: 'boolean' };
    return { name, kind: 'enum', variants: vs };
  }
  switch (node.dataType) {
    case 'bytes':
      return { name, kind: 'bytes' };
    case 'integer':
      return { name, kind: 'integer' };
    case 'list':
      return { name, kind: 'list' };
    case 'map':
      return { name, kind: 'map' };
    default:
      return { name, kind: 'unknown' };
  }
}

function normalizeBlueprintDatum(defName: string): NormDatum {
  const def = blueprint.definitions[defName];
  if (!def) throw new Error(`plutus.json has no definition "${defName}"`);
  const ctor = def.anyOf?.[0];
  if (!ctor) throw new Error(`"${defName}" is not a single-constructor record`);
  return {
    index: ctor.index ?? 0,
    fields: (ctor.fields ?? []).map(normalizeBlueprintField),
  };
}

/** Normalise one field of a Lucid `Data.Object` shape (already fully inlined). */
function normalizeLucidField(field: BlueprintField): NormField {
  const name = field.title ?? '(unnamed)';
  if (field.anyOf) {
    const vs = variantsFrom(field.anyOf);
    if (isBooleanVariants(vs)) return { name, kind: 'boolean' };
    return { name, kind: 'enum', variants: vs };
  }
  switch (field.dataType) {
    case 'bytes':
      return { name, kind: 'bytes' };
    case 'integer':
      return { name, kind: 'integer' };
    case 'list':
      return { name, kind: 'list' };
    case 'map':
      return { name, kind: 'map' };
    default:
      return { name, kind: 'unknown' };
  }
}

function normalizeLucidDatum(shape: unknown): NormDatum {
  const s = shape as { anyOf?: BlueprintVariant[] };
  const ctor = s.anyOf?.[0];
  if (!ctor) throw new Error('Lucid shape is not a single-constructor Data.Object');
  return {
    index: ctor.index ?? 0,
    fields: (ctor.fields ?? []).map(normalizeLucidField),
  };
}

// ---------------------------------------------------------------------------
// The mapping under guard
// ---------------------------------------------------------------------------

const CASES: Array<{ name: string; shape: unknown; definition: string }> = [
  { name: 'BondingCurveDatum', shape: BondingCurveDatumShape, definition: 'bonding_curve/BondingCurveDatum' },
  {
    name: 'BondingCurveTierBDatum',
    shape: BondingCurveTierBDatumShape,
    definition: 'bonding_curve_tier_b/BondingCurveTierBDatum',
  },
  { name: 'OrderDatum', shape: OrderDatumShape, definition: 'curve_order/OrderDatum' },
  { name: 'VestingDatum', shape: VestingDatumShape, definition: 'vesting/VestingDatum' },
  // Every settlement payout carries this as its datum, so a drift here
  // silently mis-tags every payout on the platform at once.
  {
    name: 'OutputReference',
    shape: OutputReferenceShape,
    definition: 'cardano/transaction/OutputReference',
  },
  { name: 'LpEscrowDatum', shape: LpEscrowDatumShape, definition: 'noctis/lp_escrow_datum/LpEscrowDatum' },
  {
    name: 'StakingPoolDatum',
    shape: StakingPoolDatumShape,
    // The datum lives in a shared module rather than the validator, because
    // the curves have to write it at graduation and a validator module may
    // not import another one.
    definition: 'noctis/staking_pool_datum/StakingPoolDatum',
  },
  { name: 'StakePosition', shape: StakePositionShape, definition: 'noctis/stake_accumulator/Position' },
  { name: 'CtoGovernanceDatum', shape: CtoGovernanceDatumShape, definition: 'cto_governance/CtoGovernanceDatum' },
  // The CTO submitters carry their own mirror of the same on-chain datum,
  // because the one above models active_proposal as Data.Any() -- enough for
  // genesis, which always writes null, and not enough to build one. A second
  // definition nothing checked is how that mirror came to be missing two
  // fields and sitting two positions out of order, so it is checked here too.
  {
    name: 'CtoGovernanceDatum (submitter mirror)',
    shape: SubmitterCtoGovernanceDatumShape,
    definition: 'cto_governance/CtoGovernanceDatum',
  },
];

// ---------------------------------------------------------------------------

describe('schema drift guard — plutus.json is the source of truth', () => {
  it('loads the compiled blueprint', () => {
    expect(blueprint.definitions).toBeDefined();
    expect(Object.keys(blueprint.definitions).length).toBeGreaterThan(0);
  });

  describe.each(CASES)('$name', ({ shape, definition }) => {
    const onChain = normalizeBlueprintDatum(definition);
    const mirrored = normalizeLucidDatum(shape);

    it('field NAMES and ORDER match the blueprint exactly', () => {
      // Compared as arrays so order is part of the assertion — a reordered
      // datum encodes positionally and would be silently wrong on-chain.
      expect(mirrored.fields.map((f) => f.name)).toEqual(onChain.fields.map((f) => f.name));
    });

    it('field COUNT matches (catches a field added on-chain but not mirrored)', () => {
      expect(mirrored.fields).toHaveLength(onChain.fields.length);
    });

    it('constructor index matches', () => {
      expect(mirrored.index).toBe(onChain.index);
    });

    it('every field has the same kind', () => {
      const mine = mirrored.fields.map((f) => `${f.name}:${f.kind}`);
      const theirs = onChain.fields.map((f) => `${f.name}:${f.kind}`);
      expect(mine).toEqual(theirs);
    });

    it('enum fields have matching variant indices and arities', () => {
      for (const expected of onChain.fields) {
        if (expected.kind !== 'enum') continue;
        const actual = mirrored.fields.find((f) => f.name === expected.name);
        expect(actual, `mirrored schema is missing enum field "${expected.name}"`).toBeDefined();
        expect(actual?.kind).toBe('enum');
        expect(
          actual?.variants?.map((v) => `${v.index}:${v.title}/${v.arity}`),
          `variant drift in "${expected.name}"`,
        ).toEqual(expected.variants?.map((v) => `${v.index}:${v.title}/${v.arity}`));
      }
    });
  });

  // BatchOrder is not a Data.Object — the batch redeemer sits at a non-zero
  // constructor index, so it and everything nested in it are hand-built with
  // raw Constr. That puts it OUTSIDE the mapping guarded above, which is
  // precisely why it needs its own check: a hand-built shape has nothing but a
  // comment holding it to the validator's declaration, and a field inserted or
  // reordered on either side type-checks on both.
  describe('BatchOrder, which is hand-built and therefore unguarded by the mapping above', () => {
    const ENCODED_ORDER_FIELDS = [
      'owner',
      'order_ref',
      'is_buy',
      'amount',
      'min_received',
      'cap_committed_before',
      'cap_proof',
    ];

    for (const module of ['bonding_curve', 'bonding_curve_tier_b']) {
      it(`${module} declares exactly the fields the encoder writes, in that order`, () => {
        const def = blueprint.definitions[`${module}/BatchOrder`] as
          | { anyOf?: Array<{ fields?: Array<{ title?: string }> }> }
          | undefined;
        expect(def, `${module}/BatchOrder missing from the blueprint`).toBeDefined();
        const fields = def?.anyOf?.[0]?.fields ?? [];
        expect(fields.map((f) => f.title)).toEqual(ENCODED_ORDER_FIELDS);
      });
    }

    it('encodes those fields positionally, at constructor 0', () => {
      const encoded = batchOrderToPlutus({
        ownerKeyHashHex: 'ab'.repeat(28),
        orderRef: { txHash: 'cd'.repeat(32), outputIndex: 3 },
        isBuy: true,
        amount: 100n,
        minReceived: 90n,
        capCommittedBefore: 7n,
        capProof: [],
      }) as Constr<unknown>;

      expect(encoded.index).toBe(0);
      expect(encoded.fields).toHaveLength(ENCODED_ORDER_FIELDS.length);

      const [owner, orderRef, isBuy, amount, minReceived, before, proof] = encoded.fields;
      expect(owner).toBe('ab'.repeat(28));
      // The order reference, as the curve reads it back off the fill's datum.
      const ref = orderRef as Constr<unknown>;
      expect(ref.index).toBe(0);
      expect(ref.fields).toEqual(['cd'.repeat(32), 3n]);
      // Aiken encodes False as constructor 0 and True as constructor 1, so a
      // boolean written the other way round reverses every order in a batch.
      expect((isBuy as Constr<unknown>).index).toBe(1);
      expect(amount).toBe(100n);
      expect(minReceived).toBe(90n);
      expect(before).toBe(7n);
      expect(proof).toEqual([]);
    });

    it('writes a sell as constructor 0, the way Aiken reads False', () => {
      const encoded = batchOrderToPlutus({
        ownerKeyHashHex: 'ab'.repeat(28),
        orderRef: { txHash: 'cd'.repeat(32), outputIndex: 0 },
        isBuy: false,
        amount: 1n,
        minReceived: 1n,
        capCommittedBefore: 0n,
        capProof: [],
      }) as Constr<unknown>;
      expect((encoded.fields[2] as Constr<unknown>).index).toBe(0);
    });
  });

  it('no on-chain Datum definition is silently unmirrored', () => {
    // A new *Datum in the blueprint that nothing here covers is itself a signal
    // — either a schema needs writing, or this list needs an explicit exclusion.
    const covered = new Set(CASES.map((c) => c.definition));
    const KNOWN_UNMIRRORED = new Set([
      // These validators have no TypeScript submitter that builds their datum
      // yet, so no mirror exists to drift. Remove from this list when one is
      // written, and add a CASES entry instead.
      'cto_sybil_challenge/CtoSybilChallengeDatum',
      'nhop_challenge/NHopChallengeDatum',
      'token_metadata/TokenMetadataDatum',
      'zk_anchor/ZkAnchorDatum',
      'staking_pool/StakingDatum', // wrapper enum over Pool/Position, mirrored as StakingDatumSchema
    ]);

    const allDatums = Object.keys(blueprint.definitions).filter((k) => k.endsWith('Datum'));
    const unaccounted = allDatums.filter((d) => !covered.has(d) && !KNOWN_UNMIRRORED.has(d));

    expect(unaccounted, 'new Datum(s) in plutus.json with no mirrored schema and no explicit exclusion').toEqual([]);
  });
});
