// Guards over deploying a contract's circuits across two transactions.
//
// WHY THIS EXISTS
// The failure mode this protects against is silent: a deploy that quietly
// carries every circuit still builds, still proves, and only fails once the
// ledger prices it — with an error about block limits that says nothing about
// the circuit list. So the properties worth asserting are the ones that would
// let the trim do nothing, or do too much, without saying so.
//
// These run against the REAL compiled eligibility gate rather than a mock. A
// mock would agree with whatever this module does, including being wrong about
// the shape `initialState` returns.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ContractState, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import { Contract as EligibilityGateContract } from '../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import {
  deferCircuitsForDeploy,
  deriveContractSigningKey,
  operationNames,
  trimContractState,
} from '../midnight-deploy-subset.js';

const b32 = (fill: number) => new Uint8Array(32).fill(fill);
const proof = Array.from({ length: 20 }, () => ({ sibling: b32(0), goesLeft: false }));

const witnesses = {
  getUserSecret: () => [undefined, { bytes: b32(7) }],
  getGovernorSecret: () => [undefined, { bytes: b32(7) }],
  getMerkleProof: () => [undefined, proof],
  getRegistrantMerkleProof: () => [undefined, proof],
  getBuyNonce: () => [undefined, b32(0)],
};

const constructorArgs = [
  b32(1),
  b32(2),
  1_000_000_000n,
  5n,
  10_000_000n, // bondAmount
  b32(144), // bondTokenColour
  50_000_000n,
  150_000_000n,
  3n,
  9n,
  BigInt(Math.floor(Date.now() / 1000) + 86_400), // registrationCloseTime
  // The DarkVeil schedule the contract derives and seals: registration runs
  // T-48h to T-2h, a 2h freeze, then 24h of buying.
  BigInt(46 * 3600), // registrationWindowSeconds
  BigInt(2 * 3600), // freezeWindowSeconds
  BigInt(24 * 3600), // buyingWindowSeconds
  5n, // minDvParticipants
  b32(3),
  b32(4),
  b32(5),
  b32(6),
  b32(8),
  2n,
];

// biome-ignore lint/suspicious/noExplicitAny: the compiled class's initialState is positionally typed per contract.
const build = (ctor: any) =>
  new ctor(witnesses).initialState(createConstructorContext(undefined, { bytes: b32(1) }), ...constructorArgs);

// The dispute trio, plus the two late-lifecycle circuits nothing can reach
// until long after deploy. Deferring only the trio no longer fits: the
// permissionless-transition work added circuits, and the deploy that carries
// them all prices above the budget — which is exactly what this file exists to
// catch, and why the real deploy names its own deferral list as an input.
const DEFERRED = [
  'disputeRegistrantExclusion',
  'rebutRegistrantExclusion',
  'claimDisputedBond',
  'expireDvSettlement',
  'sweepForfeitedBond',
];

describe('trimContractState', () => {
  it('keeps every circuit that was not deferred', () => {
    const full: ContractState = build(EligibilityGateContract).currentContractState;
    const trimmed = trimContractState(full, DEFERRED);

    const kept = operationNames(full).filter((name) => !DEFERRED.includes(name));
    expect(operationNames(trimmed).sort()).toEqual(kept.sort());
  });

  it('drops exactly the deferred circuits and no others', () => {
    const full: ContractState = build(EligibilityGateContract).currentContractState;
    const trimmed = trimContractState(full, DEFERRED);

    expect(operationNames(trimmed)).toHaveLength(operationNames(full).length - DEFERRED.length);
    for (const name of DEFERRED) {
      expect(trimmed.operation(name)).toBeUndefined();
    }
  });

  it('leaves the state it was given untouched', () => {
    // The caller still needs the full state afterwards, to build the
    // maintenance updates that carry the deferred keys.
    const full: ContractState = build(EligibilityGateContract).currentContractState;
    const before = operationNames(full).length;
    trimContractState(full, DEFERRED);
    expect(operationNames(full)).toHaveLength(before);
    expect(full.operation('claimDisputedBond')).toBeDefined();
  });

  it('carries the constructor ledger state across', () => {
    // If `data` were dropped, the contract would deploy with a blank ledger —
    // no governor key, no allowlist root — and every later call would fail on
    // a state that looks legitimately empty rather than obviously broken.
    const full: ContractState = build(EligibilityGateContract).currentContractState;
    const trimmed = trimContractState(full, DEFERRED);
    expect(trimmed.data.toString()).toBe(full.data.toString());
  });

  it('refuses a circuit name the contract does not have', () => {
    const full: ContractState = build(EligibilityGateContract).currentContractState;
    expect(() => trimContractState(full, ['claimDisputedBond', 'thisIsNotACircuit'])).toThrow(/no such circuit/);
  });

  it('names the real circuits when it refuses, so a typo is correctable', () => {
    const full: ContractState = build(EligibilityGateContract).currentContractState;
    expect(() => trimContractState(full, ['claimDisputedBnod'])).toThrow(/claimDisputedBond/);
  });

  it('refuses to defer every circuit', () => {
    const full: ContractState = build(EligibilityGateContract).currentContractState;
    expect(() => trimContractState(full, operationNames(full))).toThrow(/no entry points/);
  });

  it('deferring nothing keeps the whole set', () => {
    const full: ContractState = build(EligibilityGateContract).currentContractState;
    expect(operationNames(trimContractState(full, [])).sort()).toEqual(operationNames(full).sort());
  });
});

describe('deferCircuitsForDeploy', () => {
  it('produces a contract whose initial state omits the deferred circuits', () => {
    const { contract } = deferCircuitsForDeploy(EligibilityGateContract, DEFERRED);
    const names = operationNames(build(contract).currentContractState);

    expect(names).not.toContain('claimDisputedBond');
    expect(names).toContain('registerForDarkVeil');
  });

  it('reports the deferred circuits so the caller can complete the deploy', () => {
    const { deferred } = deferCircuitsForDeploy(EligibilityGateContract, DEFERRED);
    expect(deferred).toEqual([...DEFERRED].sort());
  });

  it('hides the deferred circuits from provableCircuits', () => {
    // This is what the executable reads to decide which verifier keys to fetch.
    // If it still listed the deferred ones it would look them up on a state
    // that no longer has them and fail mid-deploy.
    const { contract } = deferCircuitsForDeploy(EligibilityGateContract, DEFERRED);
    // biome-ignore lint/suspicious/noExplicitAny: reading the raw compiled shape.
    const instance = new (contract as any)(witnesses);
    expect(Object.keys(instance.provableCircuits)).not.toContain('claimDisputedBond');
    expect(Object.keys(instance.provableCircuits)).toContain('registerForDarkVeil');
  });

  it('leaves the real class alone', () => {
    // Same class object is reused for findDeployedContract and every call, so
    // a subclass that mutated it would quietly break connecting to the
    // contract afterwards.
    deferCircuitsForDeploy(EligibilityGateContract, DEFERRED);
    // biome-ignore lint/suspicious/noExplicitAny: reading the raw compiled shape.
    const instance = new (EligibilityGateContract as any)(witnesses);
    expect(Object.keys(instance.provableCircuits)).toContain('claimDisputedBond');
    expect(operationNames(build(EligibilityGateContract).currentContractState)).toContain('claimDisputedBond');
  });

  it('refuses a circuit name the contract does not have', () => {
    const { contract } = deferCircuitsForDeploy(EligibilityGateContract, ['nope']);
    // biome-ignore lint/suspicious/noExplicitAny: reading the raw compiled shape.
    expect(() => new (contract as any)(witnesses)).toThrow(/not a circuit/);
  });

  it('deduplicates a repeated name rather than counting it twice', () => {
    const { deferred } = deferCircuitsForDeploy(EligibilityGateContract, ['claimDisputedBond', 'claimDisputedBond']);
    expect(deferred).toEqual(['claimDisputedBond']);
  });
});

// ---------------------------------------------------------------------------
// The one property the unit tests above cannot check: that the trimmed state
// is one the ledger will actually accept. Needs real verifier keys, so it runs
// against the full ZK build and skips where that build is not present.
// ---------------------------------------------------------------------------

const ZK_BUILD = 'contracts/midnight/compiled_realzk/eligibility_gate';

describe('a deploy built from the trimmed state', () => {
  const keysPresent = existsSync(join(process.cwd(), '..', ZK_BUILD, 'keys'));

  it.skipIf(!keysPresent)("is priced within one block's write budget", async () => {
    const { ContractDeploy, ContractOperation, ContractState, Intent, LedgerParameters, Transaction } = await import(
      '@midnight-ntwrk/ledger-v8'
    );
    const base = join(process.cwd(), '..', ZK_BUILD);
    const { Contract } = await import(pathToFileURL(join(base, 'contract/index.js')).href);

    const { contract: Subset } = deferCircuitsForDeploy(Contract, DEFERRED);
    const trimmed: ContractState = build(Subset).currentContractState;

    const priced = (state: ContractState) => {
      const ledgerState = ContractState.deserialize(state.serialize());
      for (const name of operationNames(state)) {
        const operation = new ContractOperation();
        operation.verifierKey = new Uint8Array(readFileSync(join(base, 'keys', `${name}.verifier`)));
        ledgerState.setOperation(name, operation);
      }
      const intent = Intent.new(new Date(Date.now() + 3_600_000)).addDeploy(new ContractDeploy(ledgerState));
      return Transaction.fromParts('undeployed', undefined, undefined, intent);
    };

    const params = LedgerParameters.initialParameters();
    const tx = priced(trimmed);

    // Preprod publishes the same 50,000-byte write budget as the ledger's own
    // initial parameters; both were read directly rather than assumed.
    expect(Number(tx.cost(params).bytesWritten)).toBeLessThan(50_000);
    // A price at all is the real assertion: fees() throws when a transaction
    // cannot fit in a block, which is how this surfaces at deploy time.
    expect(tx.fees(params)).toBeGreaterThan(0n);
  });

  it.skipIf(!keysPresent)('is what the full circuit set could not be', async () => {
    // Guards the premise. If the untrimmed contract ever fits again, the
    // deferral is dead weight and should be removed rather than left in place.
    const { ContractDeploy, ContractOperation, ContractState, Intent, LedgerParameters, Transaction } = await import(
      '@midnight-ntwrk/ledger-v8'
    );
    const base = join(process.cwd(), '..', ZK_BUILD);
    const { Contract } = await import(pathToFileURL(join(base, 'contract/index.js')).href);
    const full: ContractState = build(Contract).currentContractState;

    const ledgerState = ContractState.deserialize(full.serialize());
    for (const name of operationNames(full)) {
      const operation = new ContractOperation();
      operation.verifierKey = new Uint8Array(readFileSync(join(base, 'keys', `${name}.verifier`)));
      ledgerState.setOperation(name, operation);
    }
    const intent = Intent.new(new Date(Date.now() + 3_600_000)).addDeploy(new ContractDeploy(ledgerState));
    const tx = Transaction.fromParts('undeployed', undefined, undefined, intent);

    expect(Number(tx.cost(LedgerParameters.initialParameters()).bytesWritten)).toBeGreaterThan(50_000);
  });
});

describe('deriveContractSigningKey', () => {
  const governor = new Uint8Array(32).fill(11);
  const launch = new Uint8Array(32).fill(22);

  it('is the same key every time', () => {
    // The whole point: the process that completes the deploy is not the one
    // that started it, so this has to be recomputable rather than remembered.
    expect(deriveContractSigningKey(governor, launch)).toBe(deriveContractSigningKey(governor, launch));
  });

  it('still derives the key already-deployed contracts were deployed under', () => {
    // Every other test here would pass just as happily if the digest under
    // this function changed — they check that it is deterministic, distinct
    // per launch and per governor, and a valid curve point, all of which a
    // DIFFERENT hash satisfies too. Nothing pinned the actual value.
    //
    // A contract's maintenance authority is fixed at deploy. If this key
    // moves, the deferred circuits can no longer be added to any contract
    // already on chain, and the failure surfaces as a rejected maintenance
    // update rather than as anything pointing back here.
    //
    // Derived independently with node:crypto's createHmac, the implementation
    // in place before this moved to @noble/hashes.
    expect(deriveContractSigningKey(new Uint8Array(32).fill(7), new Uint8Array(32).fill(11))).toBe(
      'ada4d8e231269cbb27abfb4dc12e897699fa183ddd6238a4ec9cf11098584309',
    );
  });

  it('differs per launch', () => {
    // One launch's maintenance authority must not be another's.
    expect(deriveContractSigningKey(governor, launch)).not.toBe(
      deriveContractSigningKey(governor, new Uint8Array(32).fill(23)),
    );
  });

  it('differs per governor', () => {
    expect(deriveContractSigningKey(governor, launch)).not.toBe(
      deriveContractSigningKey(new Uint8Array(32).fill(12), launch),
    );
  });

  it('is not the governor secret in disguise', () => {
    // A derivation that leaked the secret through would hand contract
    // maintenance to anyone who ever sees a signing key.
    expect(deriveContractSigningKey(governor, launch)).not.toContain(Buffer.from(governor).toString('hex'));
  });

  it('produces a key the ledger accepts', async () => {
    const { signatureVerifyingKey } = await import('@midnight-ntwrk/midnight-js-protocol/compact-runtime');
    expect(() => signatureVerifyingKey(deriveContractSigningKey(governor, launch))).not.toThrow();
  });

  it('refuses a launch id that is not 32 bytes', () => {
    expect(() => deriveContractSigningKey(governor, new Uint8Array(16))).toThrow(/32 bytes/);
  });
});
