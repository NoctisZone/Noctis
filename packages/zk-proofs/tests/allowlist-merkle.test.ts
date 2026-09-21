// Proves eligibility_gate.compact's verifyAllowlist() actually
// enforces Merkle membership now (previously a placeholder accepting any
// non-zero leaf) — both that real proofs are accepted, and that every
// tampered variant of a proof is rejected. This is the highest-stakes
// piece of Compact code from this pass (a soundness bug here would mean
// the allowlist doesn't actually gate anything), so coverage here is
// deliberately adversarial, not just happy-path.
//
// Security-audit fix (the design requirement, 2026-07-11): the leaf is no longer a free
// witness (getAllowlistLeaf) — verifyAllowlist derives it in-circuit as
// hashAllowlistLeaf(caller), closing the "borrow someone else's leaf+proof"
// impersonation gap a free witness value allowed. Every test below builds
// its tree from REAL derived registrant identities (deriveUserPublicKey),
// not arbitrary opaque leaves, and drives the contract with the matching
// getUserSecret witness rather than a supplied leaf.
import { describe, expect, it } from 'vitest';
import {
  Contract,
  LaunchPhase,
  type Witnesses,
} from '../../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import { deployForTest, fakeBytes32, nextContext } from '../../../contracts/midnight/tests/helpers.js';
import { DOMAINS, deriveRoleKey } from '../../../contracts/midnight/witnesses.js';
import {
  buildAllowlistTree,
  deriveUserPublicKey,
  hashAllowlistLeaf,
  type MerkleProofEntry,
} from '../src/eligibility-gate.js';

type PrivateState = undefined;

/** The launch every contract in this file is deployed with. Identity is
 *  scoped per launch, so every leaf here must derive under this same value
 *  or it will not match what the contract computes. */
const LAUNCH_ID = fakeBytes32(9);

/** Builds the leaf for a registrant identified by their secret-key fill. */
function leafForFill(fill: number): Uint8Array {
  return hashAllowlistLeaf(deriveUserPublicKey(fakeBytes32(fill), LAUNCH_ID));
}

// Phase 2 security-audit fix (2026-07-11): darkveil.compact merged into
// eligibility_gate.compact — getBuyNonce is now part of this contract's
// own witness set, even though this file's tests only exercise the
// registration side.
//
// Fix (2026-07-30): getRegistrantMerkleProof is a required witness
// (verifyRegistrant, called from submitBuyCommit) but is never invoked by
// registerForDarkVeil, the only circuit these tests exercise — an empty
// proof is safe here since it's never read. Fix (2026-07-30):
// getRegistrationNonce was removed as a dead witness (nothing calls it
// since the 2026-07-21 fix dropped the nonce from
// computeRegistrationCommit) — see eligibility_gate.compact's own comment.
function witnessesFor(sk: Uint8Array, proof: MerkleProofEntry[]): Witnesses<PrivateState> {
  return {
    getUserSecret: (_ctx) => [undefined, { bytes: sk }],
    getMerkleProof: (_ctx) => [undefined, proof],
    getRegistrantMerkleProof: (_ctx) => [undefined, []],
    getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
    getBuyNonce: (_ctx) => [undefined, fakeBytes32(7)],
  };
}

function deployWithRoot(root: Uint8Array, witnesses: Witnesses<PrivateState>) {
  const contract = new Contract<PrivateState>(witnesses);
  const { contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    LAUNCH_ID,
    root, // allowlistRoot
    1_000_000_000n, // totalSupply
    5n, // maxWalletPercent
    1000n, // bondAmount
    new Uint8Array(32), // bondTokenColour — 32 zero bytes is the native token
    50_000_000n, // walletCap
    500n, // dvAllocation — not exercised by this file's registration-only tests
    90n, // dvPrice
    1n, // allowlistSize
    1_000_000n, // registrationCloseTime
    // The launch's own schedule, the same 46h/2h/24h a real one carries.
    // The gate derives its open, buying-open and buying-close times from
    // these at deploy, so a registration close of 1,000,000 has to leave
    // room for the registration window behind it.
    165_600n, // registrationWindowSeconds
    7_200n, // freezeWindowSeconds
    86_400n, // buyingWindowSeconds
    1n, // minDvParticipants — permissive, this file's tests don't exercise the floor
    fakeBytes32(88), // creatorPubKey — distinct from any registrant fill used below
    fakeBytes32(60), // platformAddr — one wallet, no treasury/ops split
    // Three distinct allowlist attestors and a 2-of-3 threshold. This suite
    // does not exercise attestation; it needs a deployment the constructor's
    // distinctness check accepts.
    deriveRoleKey({ bytes: fakeBytes32(2) }, DOMAINS.ELIGIBILITY_GOVERNOR).bytes,
    deriveRoleKey({ bytes: fakeBytes32(32) }, DOMAINS.ELIGIBILITY_GOVERNOR).bytes,
    deriveRoleKey({ bytes: fakeBytes32(33) }, DOMAINS.ELIGIBILITY_GOVERNOR).bytes,
    2n,
  );
  const rPhase = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
  const ctx0 = nextContext(contractAddress, rPhase.context);
  // dvState must be Registration before registerForDarkVeil is callable.
  const rStart = contract.circuits.startRegistration(ctx0);
  return { contract, contractAddress, ctx: nextContext(contractAddress, rStart.context) };
}

describe('eligibility_gate.compact — allowlist Merkle verification (the design requirement caller-binding)', () => {
  it('accepts a real proof for each registrant in a 5-entry (non-power-of-2) tree', () => {
    const fills = [1, 2, 3, 4, 5];
    const tree = buildAllowlistTree(fills.map(leafForFill));

    for (let i = 0; i < fills.length; i++) {
      const { contract, ctx } = deployWithRoot(tree.root, witnessesFor(fakeBytes32(fills[i]), tree.getProof(i)));
      const result = contract.circuits.registerForDarkVeil(ctx);
      expect(result.context).toBeDefined(); // does not throw
    }
  });

  it('accepts a single-registrant tree (edge case: zero real levels, all 32 are padding)', () => {
    const tree = buildAllowlistTree([leafForFill(42)]);
    const { contract, ctx } = deployWithRoot(tree.root, witnessesFor(fakeBytes32(42), tree.getProof(0)));
    expect(() => contract.circuits.registerForDarkVeil(ctx)).not.toThrow();
  });

  it('rejects a proof with a tampered sibling at a real (non-padding) level', () => {
    const fills = [1, 2, 3, 4];
    const tree = buildAllowlistTree(fills.map(leafForFill));
    const proof = tree.getProof(0);
    const tampered = proof.map((entry, i) => (i === 0 ? { ...entry, sibling: fakeBytes32(99) } : entry));

    const { contract, ctx } = deployWithRoot(tree.root, witnessesFor(fakeBytes32(fills[0]), tampered));
    expect(() => contract.circuits.registerForDarkVeil(ctx)).toThrow(/Invalid allowlist proof/);
  });

  it('rejects a proof with a flipped direction bit at a real level', () => {
    const fills = [1, 2, 3, 4];
    const tree = buildAllowlistTree(fills.map(leafForFill));
    const proof = tree.getProof(0);
    const tampered = proof.map((entry, i) => (i === 0 ? { ...entry, goesLeft: !entry.goesLeft } : entry));

    const { contract, ctx } = deployWithRoot(tree.root, witnessesFor(fakeBytes32(fills[0]), tampered));
    expect(() => contract.circuits.registerForDarkVeil(ctx)).toThrow(/Invalid allowlist proof/);
  });

  it('rejects a proof with a tampered sibling in the padding levels', () => {
    // A one-leaf tree, so every level of its proof is depth padding.
    const tree = buildAllowlistTree([leafForFill(1)]);
    const proof = tree.getProof(0);
    // The LAST level, found from the proof rather than named: an index
    // pinned to a particular depth silently stops tampering with anything
    // the moment the depth changes, and the test then passes a valid proof.
    const topLevel = proof.length - 1;
    const tampered = proof.map((entry, i) => (i === topLevel ? { ...entry, sibling: fakeBytes32(99) } : entry));

    const { contract, ctx } = deployWithRoot(tree.root, witnessesFor(fakeBytes32(1), tampered));
    expect(() => contract.circuits.registerForDarkVeil(ctx)).toThrow(/Invalid allowlist proof/);
  });

  it('rejects a registrant presenting a real proof built for a DIFFERENT registrant (the exact the design requirement impersonation gap)', () => {
    const fills = [1, 2];
    const tree = buildAllowlistTree(fills.map(leafForFill));
    const proofForRegistrant0 = tree.getProof(0);

    // Security-audit fix regression: before the design requirement, a caller who knew
    // registrant 0's leaf+proof could present them regardless of whose
    // secret they actually held. Now the leaf is derived from THIS
    // caller's own identity (fill 2), which won't match a proof built for
    // registrant 0's leaf at this tree position.
    const { contract, ctx } = deployWithRoot(tree.root, witnessesFor(fakeBytes32(fills[1]), proofForRegistrant0));
    expect(() => contract.circuits.registerForDarkVeil(ctx)).toThrow(/Invalid allowlist proof/);
  });

  it('rejects a well-formed proof against the wrong root (registrant not on this allowlist)', () => {
    const treeA = buildAllowlistTree([leafForFill(1), leafForFill(2)]);
    const treeB = buildAllowlistTree([leafForFill(3), leafForFill(4)]);

    // Valid proof for treeA's registrant 0, but the contract was deployed with treeB's root
    const { contract, ctx } = deployWithRoot(treeB.root, witnessesFor(fakeBytes32(1), treeA.getProof(0)));
    expect(() => contract.circuits.registerForDarkVeil(ctx)).toThrow(/Invalid allowlist proof/);
  });

  it('rejects an all-zero garbage proof (the old placeholder would have accepted any non-zero leaf)', () => {
    const tree = buildAllowlistTree([leafForFill(1)]);
    // Depth reduced 32 -> 20 — garbage proof length must match the
    // circuit's current fixed-depth witness shape exactly.
    const garbageProof: MerkleProofEntry[] = Array.from({ length: 20 }, () => ({
      sibling: fakeBytes32(0),
      goesLeft: true,
    }));
    const { contract, ctx } = deployWithRoot(tree.root, witnessesFor(fakeBytes32(1), garbageProof));
    expect(() => contract.circuits.registerForDarkVeil(ctx)).toThrow(/Invalid allowlist proof/);
  });

  it('rejects a caller whose secret is not on the allowlist at all, even with a structurally-valid-looking proof for someone else', () => {
    // A caller who isn't a registrant can't construct ANY valid proof for
    // their own derived leaf (the design requirement's core guarantee) — proves this
    // distinctly from the "wrong registrant's proof" case above by using a
    // secret that was never included in the tree at all.
    const tree = buildAllowlistTree([leafForFill(1), leafForFill(2)]);
    const { contract, ctx } = deployWithRoot(tree.root, witnessesFor(fakeBytes32(999), tree.getProof(0)));
    expect(() => contract.circuits.registerForDarkVeil(ctx)).toThrow(/Invalid allowlist proof/);
  });
});
