// ============================================================================
// Noctis Zone — the order lifecycle, from the command line
// ============================================================================
// place   create an order UTXO holding the funds to be traded
// list    read a launch's open orders
// cancel  the owner takes their funds back, any time
// sweep   anyone returns an expired order's funds TO ITS OWNER
//
// The last two are what make the arrangement non-custodial: a batcher that
// stalls or turns hostile costs an owner time, never funds, because both exits
// work without it.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import { OrderSubmitter } from '../order-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireField,
  requireFieldsFalsy,
} from './cli-io.js';

declare const __dirname: string;

type Action = 'place' | 'list' | 'cancel' | 'sweep';

interface Input {
  action: Action;
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /** Which curve these orders may be applied against. */
  tier: 'B';

  // place
  ownerMnemonic?: string;
  isBuy?: boolean;
  amount?: string;
  minReceived?: string;
  /** The most of the order's own funds that may leave it. The batcher's
   *  ceiling as well as the curve's. */
  maxSpend?: string;
  deadlineMs?: string;
  tokenPolicyId?: string;
  tokenAssetName?: string;
  lovelace?: string;

  // cancel / sweep — which order, and who is calling
  orderTxHash?: string;
  orderOutputIndex?: number;
  callerMnemonic?: string;
}

const CURVE_TITLE = 'bonding_curve_tier_b.bonding_curve_tier_b.spend';

// The linear-curve path is retired, so the only tier this resolves is the
// quadratic one. Checked at runtime rather than left to the type: input
// arrives as JSON, and a retired tier silently resolving to a different
// validator would run this command against a contract nobody named.
function requireLiveTier(tier: string): void {
  if (tier !== 'B') {
    throw new Error(`tier must be "B" - the linear-curve path is retired (got "${tier}")`);
  }
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, ['action', 'network', 'launchIdHex', 'blockfrostProjectId', 'blockfrostUrl', 'tier']);
  requireLiveTier(input.tier);

  const blueprint = loadPlutusBlueprint(__dirname);
  const submitter = new OrderSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    compiledScriptCbor: loadValidatorCbor(blueprint, 'curve_order.curve_order.spend'),
    curveScriptCbor: loadValidatorCbor(blueprint, CURVE_TITLE),
  });

  let result: unknown;
  switch (input.action) {
    case 'place': {
      result = await submitter.placeOrder(requireField(input, 'ownerMnemonic', 'place'), {
        launchIdHex: input.launchIdHex,
        isBuy: input.isBuy ?? true,
        amount: BigInt(requireField(input, 'amount', 'place')),
        minReceived: BigInt(requireField(input, 'minReceived', 'place')),
        maxSpend: BigInt(requireField(input, 'maxSpend', 'place')),
        deadlineMs: BigInt(requireField(input, 'deadlineMs', 'place')),
        tokenPolicyId: requireField(input, 'tokenPolicyId', 'place'),
        tokenAssetName: requireField(input, 'tokenAssetName', 'place'),
        lovelace: BigInt(requireField(input, 'lovelace', 'place')),
      });
      break;
    }
    case 'list': {
      const open = await submitter.openOrders(input.launchIdHex);
      result = {
        orderAddress: submitter.orderAddress,
        orders: open.map(({ utxo, datum }) => ({
          txHash: utxo.txHash,
          outputIndex: utxo.outputIndex,
          assets: utxo.assets,
          datum,
        })),
      };
      break;
    }
    case 'cancel':
    case 'sweep': {
      const utxo = await findOrder(submitter, input);
      result =
        input.action === 'cancel'
          ? await submitter.cancelOrder(requireField(input, 'callerMnemonic', 'cancel'), utxo)
          : await submitter.sweepExpiredOrder(requireField(input, 'callerMnemonic', 'sweep'), utxo);
      break;
    }
    default:
      throw new Error(`Unknown action: ${String(input.action)}`);
  }

  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

/** The named order, looked up among the launch's own — never taken on trust. */
async function findOrder(submitter: OrderSubmitter, input: Input) {
  const txHash = requireField(input, 'orderTxHash', input.action);
  const outputIndex = requireField(input, 'orderOutputIndex', input.action);
  const open = await submitter.openOrders(input.launchIdHex);
  const found = open.find((o) => o.utxo.txHash === txHash && o.utxo.outputIndex === outputIndex);
  if (!found) {
    throw new Error(
      `No open order ${txHash}#${outputIndex} for launch ${input.launchIdHex}. It may already have been ` +
        'filled, cancelled, or swept.',
    );
  }
  return found.utxo;
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
