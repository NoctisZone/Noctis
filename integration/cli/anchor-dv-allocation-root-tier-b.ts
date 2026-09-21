// ============================================================================
// Noctis Zone — DarkVeil allocation anchor follow-up
// AnchorDvAllocationRoot — governor-signed, single-phase: the governor holds
// the key and the transaction has one signer, so a build(Lucid)/sign(PHP)/
// submit(Lucid) split would add two hand-offs and change nothing about who
// can authorise it.
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller — same trust boundary it already crosses for the mint flow's
// policy-wallet signing) and the real dv_allocation_root (hex), computed
// off-chain via dv-allocation-tree.ts's buildDvAllocationTree from the
// governor's own DarkVeil-close accounting. Never logged. Output:
// {txHash} on stdout.
// ============================================================================

import { CardanoDvAllocationAnchorSubmitter } from '../cardano-dv-allocation-anchor-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireFieldsFalsy,
} from './cli-io.js';

declare const __dirname: string;

interface AnchorDvAllocationRootInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  dvAllocationRootHex: string;
  /**
   * How many registrants that same tree holds. It sizes the nullifier map
   * anchored alongside the root, one bit each, so it must cover the highest
   * leaf index the tree hands out — a map short of that leaves those
   * registrants no bit to claim against, and nothing after this transaction
   * can resize it. Take it from the tree, never from a guess;
   * `build-dv-allocation-tree` prints it.
   *
   * 0 for a launch with no DarkVeil phase, which anchors no map at all.
   */
  registrantCount: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /**
   * Where this curve's validator is published as a reference script.
   *
   * Supply it. This validator is over 15 KB, so an anchor that carries it has
   * nothing left of the transaction cap for its own inputs and outputs.
   * Publish one with `publish-reference-script`, which prints a pointer in this
   * shape; a pointer from an earlier build is refused locally, naming both
   * hashes, rather than producing a transaction the node rejects for reasons
   * that mention neither.
   */
  referenceScript?: { txHash: string; outputIndex: number; scriptHash: string };
  /** Declare these execution budgets rather than asking the provider to measure. */
  executionUnits?: { mem: number; steps: number };
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<AnchorDvAllocationRootInput>(raw);

  requireFieldsFalsy(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'governorAddress',
    'governorPrivateKeyExtendedHex',
    'dvAllocationRootHex',
    'blockfrostProjectId',
    'blockfrostUrl',
  ]);
  // Checked separately from the list above, which refuses anything falsy: 0 is
  // the real answer for a launch with no DarkVeil phase.
  if (!Number.isInteger(input.registrantCount) || input.registrantCount < 0) {
    throw new Error('registrantCount is required, as a whole number of registrants (0 for no DarkVeil phase).');
  }

  const blueprint = loadPlutusBlueprint(__dirname);
  const compiledScriptCbor = loadValidatorCbor(blueprint, 'bonding_curve_tier_b.bonding_curve_tier_b.spend');

  const submitter = new CardanoDvAllocationAnchorSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    compiledScriptCbor,
    launchIdHex: input.launchIdHex,
    threadNftPolicyId: input.threadNftPolicyId,
    ...(input.referenceScript ? { referenceScript: input.referenceScript } : {}),
    ...(input.executionUnits ? { executionUnits: input.executionUnits } : {}),
  });

  const result = await submitter.anchorDvAllocationRoot(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    input.dvAllocationRootHex,
    input.registrantCount,
  );
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
