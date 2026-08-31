// ============================================================================
// Noctis Zone — Cardano Launch public bonding curve, real Cardano actions
// ============================================================================
// One consolidated CLI (action-dispatched) rather than 7 near-identical
// per-redeemer files, matching the class this session's own fix
// exposed: activate/open-dv-claim/buy/claim-creator-fees/claim-platform-fees/
// expire/claim-buyback are all thin wrappers around
// tier-b-curve-submitter().ts's real methods — one process per call either
// way, just fewer files to keep in sync with that submitter's own method
// signatures.
//
// Input: single JSON object on stdin, `action` selects the operation.
// Output: single JSON object on stdout (the submitter method's own result,
// bigints stringified) or { error }.
// ============================================================================

import { capAccumulatorFromHex } from '../cap-accumulator-tree.js';
import { LucidTierBCurveSubmitter } from '../tier-b-curve-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireField,
  requireFieldsFalsy,
  requireTimestampMs,
} from './cli-io.js';

declare const __dirname: string;

type Action =
  | 'activate'
  | 'open-dv-claim'
  | 'buy'
  | 'sell'
  | 'claim-darkveil'
  | 'claim-creator-fees'
  | 'claim-platform-fees'
  | 'expire'
  | 'claim-buyback';

interface Input {
  action: Action;
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;

  // activate / claim-platform-fees / expire — governor-signed
  governorPrivateKeyExtendedHex?: string;
  governorAddress?: string;

  // activate / open-dv-claim
  currentTimestampMs?: number;

  /** open-dv-claim: how many registrants the DarkVeil allocation tree holds.
   *  It sizes `claimed_bits`, one bit each, so it must cover the highest
   *  leaf_index that tree hands out — too small and those registrants have no
   *  bit to claim against. Take it from the tree, never from a guess. */
  registrantCount?: number;

  // buy / claim-buyback
  buyerMnemonic?: string;
  tokenAmount?: string; // stringified bigint
  skipClientCapCheck?: boolean;

  /** The launch's per-wallet running totals, which the cumulative cap is held
   *  against. Omit only for a curve nothing has been taken from yet — the
   *  submitter refuses to build a transaction unless what it derives matches
   *  the curve datum's own cap_root, so a stale list fails locally. */
  capState?: { keyHashHex: string; total: string }[];

  // sell — same seller-signed mnemonic shape as buyerMnemonic above.
  sellerMnemonic?: string;

  /**
   * claim-darkveil — one registrant settling their own private allocation.
   * The proof comes from `build-dv-allocation-tree`, which prints exactly this
   * shape for every registrant; a buyer is given only their own.
   */
  dvClaim?: {
    dvAmount: string;
    saltHex: string;
    leafIndex: number;
    buyerKeyHashHex: string;
    merkleProof: Array<{ siblingHex: string; goesLeft: boolean }>;
  };

  // claim-creator-fees — same extended-key signing shape as
  // governorPrivateKeyExtendedHex/governorAddress above (see
  // tier-b-curve-submitter().ts's claimCreatorFees() doc comment for why:
  // the platform wallet custody scheme never persists a mnemonic).
  signerPrivateKeyExtendedHex?: string;
  signerAddress?: string;
  platformClaimFeeLovelace?: string; // stringified bigint, optional (defaults to the on-chain floor)

  // claim-*-fees (all three)
  amount?: string; // stringified bigint

  /**
   * Where this curve's validator is published as a reference script.
   *
   * Supplied, a `buy` names the validator instead of carrying it, which is
   * what leaves room in the transaction for the cap proof. Omitted,
   * everything behaves exactly as it did. Publish one with
   * `publish-reference-script`, which prints a pointer in this shape.
   *
   * A pointer from an earlier build of the validator is refused locally,
   * naming both hashes, rather than producing a transaction the node
   * rejects for reasons that mention neither.
   */
  referenceScript?: { txHash: string; outputIndex: number; scriptHash: string };

  /**
   * Declare these execution budgets rather than asking the provider to measure
   * them — see mesh-curve-spend.ts for when that is the right call.
   */
  executionUnits?: { mem: number; steps: number };
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Input>(raw);

  requireFieldsFalsy(input, ['action', 'network', 'launchIdHex', 'blockfrostProjectId', 'blockfrostUrl']);

  const blueprint = loadPlutusBlueprint(__dirname);
  const compiledScriptCbor = loadValidatorCbor(blueprint, 'bonding_curve_tier_b.bonding_curve_tier_b.spend');

  // Lazily constructed, and that ordering is the point: the submitter opens a
  // Blockfrost connection in its constructor and stores the promise, which
  // nothing awaits until a method runs. Built before the per-action field
  // checks below, a request that was never valid still opened a connection —
  // and when that connection then failed, its rejection had no awaiter, so
  // Node printed a stack trace to stderr AFTER the real {"error"} answer had
  // already gone to stdout. The output contract held; a human reading the
  // terminal saw a crash next to a correct message.
  //
  // Each case validates its own fields on their own lines before calling
  // `submitter()`, so an invalid request never reaches the network at all.
  let submitterInstance: LucidTierBCurveSubmitter | null = null;
  const submitter = (): LucidTierBCurveSubmitter =>
    (submitterInstance ??= new LucidTierBCurveSubmitter({
      blockfrostProjectId: input.blockfrostProjectId,
      blockfrostUrl: input.blockfrostUrl,
      network: CARDANO_NETWORK_MAP[input.network],
      compiledScriptCbor,
      launchIdHex: input.launchIdHex,
      threadNftPolicyId: input.threadNftPolicyId,
      ...(input.referenceScript ? { referenceScript: input.referenceScript } : {}),
      ...(input.executionUnits ? { executionUnits: input.executionUnits } : {}),
    }));

  let result: unknown;
  switch (input.action) {
    case 'activate': {
      const key = requireField(input, 'governorPrivateKeyExtendedHex', input.action);
      const addr = requireField(input, 'governorAddress', input.action);
      const ts = requireTimestampMs(requireField(input, 'currentTimestampMs', input.action), 'currentTimestampMs');
      result = await submitter().activateCurve(key, addr, ts);
      break;
    }
    // Opens the 24-hour window in which DarkVeil registrants, and only they,
    // settle their allocations. Public trading cannot start until it and the
    // dead window after it have both elapsed, which is what keeps claims and
    // trades off the same UTXO entirely.
    case 'open-dv-claim': {
      const key = requireField(input, 'governorPrivateKeyExtendedHex', input.action);
      const addr = requireField(input, 'governorAddress', input.action);
      const count = requireField(input, 'registrantCount', input.action);
      const ts = requireTimestampMs(requireField(input, 'currentTimestampMs', input.action), 'currentTimestampMs');
      result = await submitter().openDvClaim(key, addr, count, ts);
      break;
    }
    case 'buy': {
      const mnemonic = requireField(input, 'buyerMnemonic', input.action);
      const amount = BigInt(requireField(input, 'tokenAmount', input.action));
      // The cumulative cap's accumulator — on Cardano Launch this spans the DarkVeil
      // claim window as well as public buys. Omit it only for a curve nothing
      // has been taken from yet; the submitter refuses to build a transaction
      // if what it is handed does not derive the datum's own cap_root.
      result = await submitter().buyTokens(
        mnemonic,
        amount,
        capAccumulatorFromHex(input.capState ?? []),
        input.skipClientCapCheck ?? false,
      );
      break;
    }
    case 'claim-darkveil': {
      const mnemonic = requireField(input, 'buyerMnemonic', input.action);
      const claim = requireField(input, 'dvClaim', input.action);
      result = await submitter().claimDarkVeilTokens(
        mnemonic,
        {
          dvAmount: BigInt(claim.dvAmount),
          salt: Buffer.from(claim.saltHex, 'hex'),
          buyerKeyHash: Buffer.from(claim.buyerKeyHashHex, 'hex'),
          leafIndex: claim.leafIndex,
          merkleProof: claim.merkleProof.map((p) => ({
            sibling: new Uint8Array(Buffer.from(p.siblingHex, 'hex')),
            goesLeft: p.goesLeft,
          })),
        },
        capAccumulatorFromHex(input.capState ?? []),
      );
      break;
    }
    case 'sell': {
      const mnemonic = requireField(input, 'sellerMnemonic', input.action);
      const amount = BigInt(requireField(input, 'tokenAmount', input.action));
      result = await submitter().sellTokens(mnemonic, amount, capAccumulatorFromHex(input.capState ?? []));
      break;
    }
    case 'claim-creator-fees': {
      const key = requireField(input, 'signerPrivateKeyExtendedHex', input.action);
      const addr = requireField(input, 'signerAddress', input.action);
      const amount = BigInt(requireField(input, 'amount', input.action));
      const platformFee =
        input.platformClaimFeeLovelace !== undefined ? BigInt(input.platformClaimFeeLovelace) : undefined;
      result =
        platformFee !== undefined
          ? await submitter().claimCreatorFees(key, addr, amount, platformFee)
          : await submitter().claimCreatorFees(key, addr, amount);
      break;
    }
    case 'claim-platform-fees': {
      const key = requireField(input, 'governorPrivateKeyExtendedHex', input.action);
      const addr = requireField(input, 'governorAddress', input.action);
      const amount = BigInt(requireField(input, 'amount', input.action));
      result = await submitter().claimPlatformFees(key, addr, amount);
      break;
    }
    case 'expire': {
      const key = requireField(input, 'governorPrivateKeyExtendedHex', input.action);
      const addr = requireField(input, 'governorAddress', input.action);
      result = await submitter().expireCurve(key, addr);
      break;
    }
    case 'claim-buyback': {
      const mnemonic = requireField(input, 'buyerMnemonic', input.action);
      const amount = BigInt(requireField(input, 'tokenAmount', input.action));
      result = await submitter().claimBuyback(mnemonic, amount);
      break;
    }
    default:
      throw new Error(`Unknown action: ${input.action}`);
  }

  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
