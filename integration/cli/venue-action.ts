// ============================================================================
// Noctis Zone — NoctisSwap: the venue from the command line
// ============================================================================
//   read-pools   what pools exist at the venue, and what each one holds
//   read-round   what is fillable right now, and why nothing else is
//   read-market  what a venue site states about each pool: its trades since a
//                point the caller holds, its order queue, its liquidity
//                providers and its holders, with the platform's own addresses
//                named so a page can tell a contract from a person
//   batch        run ONE round of fills and stop
//   serve        run rounds on an interval until stopped
//
// The first two touch no key and move nothing, which makes `read-round` the
// honest thing to run first: it reports the same decision `batch` acts on, so
// a round that fills nothing can be explained instead of guessed at.
//
// WHY A SERVICE AND NOT JUST A COMMAND. A browser can price, place, watch and
// cancel an order, and can never move a pool — `venue-swap-widget-entry.ts`
// says so in its own header, and it is the venue's division rather than a
// limitation of the widget. So a placed order rests until an executor fills
// it, and with nothing running, a venue left open for people to trade on is a
// venue where every order rests forever. `serve` is what makes the market
// answer.
//
// A ROUND IS A CHAIN, NOT A SET. Each fill spends the pool output the last one
// made, so the second order against a pool meets a pool that has already
// moved. `VenueBatcher` carries each successor forward and re-asks whether the
// next order still clears its own floor; this file supplies configuration and
// prints outcomes, and decides nothing about what gets filled.
//
// ADDRESSES ARE DERIVED, NEVER SUPPLIED. The pool and order addresses come
// from the venue's own compiled bytes — the applied record for the pool, whose
// parameter has to be applied before it has deployable bytes at all, and the
// venue blueprint for the swap order, which takes none. An address accepted as
// input is an address that can be wrong, and a batcher pointed at the wrong
// one reads an empty book and reports a quiet, healthy-looking nothing.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import { validatorToAddress } from '@lucid-evolution/lucid';
import { BlockfrostProvider, MeshWallet } from '@meshsdk/core';
import { BlockfrostClient } from '../blockfrost-client.js';
import { KeyCurveSpendWallet } from '../key-curve-spend-wallet.js';
import type { CurveNetwork, CurveSpendWallet } from '../mesh-curve-spend.js';
import { MESH_NETWORK_ID, type ReferenceScriptPointer } from '../reference-script.js';
import { VenueBatcher, type VenueBatcherRound, type VenueFillOutcome } from '../venue-batcher.js';
import { readVenueFillRound, readVenuePools, type VenueChainProvider } from '../venue-chain-reader.js';
import { VenueFiller, type VenueScriptSource } from '../venue-fill-submitter.js';
import { readVenueMarket } from '../venue-market-reader.js';
import { VENUE_FACTORY_TITLE } from '../venue-pool.js';
import { venueUnitOf } from '../venue-swap.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadAppliedVenueValidator,
  loadDeployedValidators,
  parseJsonStdin,
  readStdin,
  requireField,
  requireFieldsFalsy,
} from './cli-io.js';

declare const __dirname: string;

type Action = 'read-pools' | 'read-round' | 'read-market' | 'batch' | 'serve';

/** The pool validator, applied with its `royalty_withdraw_vh` parameter. */
const VENUE_POOL_TITLE = 'royalty_pool/pool.pool.spend';
/** The swap order. Takes no parameter, so the blueprint's bytes are the real ones. */
const VENUE_SWAP_ORDER_TITLE = 'royalty_pool/swap_order.swap_order.spend';

/**
 * Least lovelace an output may hold.
 *
 * Properly a function of the chain's `coinsPerUtxoByte` and the output's own
 * size, not a constant — which is why it stays overridable. The default is the
 * protocol's floor for a simple output, and it is what the venue's own tests
 * are written against. Raise it here rather than in the caller if the
 * parameter ever moves.
 */
const DEFAULT_MIN_OUTPUT_LOVELACE = 1_000_000n;

interface Input {
  action: Action;
  network: CurveNetwork;
  blockfrostProjectId: string;
  blockfrostUrl: string;

  /**
   * The executor's key, for `batch` and `serve`. Two ways in, matching every
   * other CLI here: the platform's custody stores an encrypted extended key
   * per role and never a mnemonic, so a scheduled batcher signs with the
   * first pair; the mnemonic stays for harness and hand-driven use.
   *
   * `forAddress` refuses a key that does not sign for the address it is given,
   * which turns a mispaired config into a readable error rather than a
   * transaction the node rejects for a reason naming neither.
   */
  executorSkeyExtendedHex?: string;
  executorAddress?: string;
  executorMnemonic?: string;

  /**
   * Where the pool and swap-order validators are published, from
   * `publish-reference-script`.
   *
   * Optional, and worth having: without a pointer the script travels in the
   * witness set, which is correct and larger. A fill carries two scripts, so
   * two pointers are the difference between a comfortable transaction and one
   * against the size cap.
   */
  poolReferenceScript?: ReferenceScriptPointer;
  orderReferenceScript?: ReferenceScriptPointer;

  /** Tunables. Every one of these has a documented default in the batcher. */
  minOutputLovelace?: string;
  fillCostLovelace?: string;
  executorPayoutLovelace?: string;
  maxFillsPerPool?: number;
  maxFillsPerRound?: number;

  /** `serve` only: how long to wait between rounds. */
  intervalMs?: number;
  /** `serve` only: stop after this long. Unset, it runs until killed. */
  runForMs?: number;
  /** `read-market` only: one pool by its NFT unit; omitted, every pool. */
  poolNft?: string;
  /** `read-market` only: per pool NFT, the newest transaction the caller already holds. */
  since?: Record<string, string>;
  /** `read-market` only: the most events one read walks per pool. */
  maxEvents?: number;
  /** `read-market` only: how many of a token's largest holders to return. */
  holdersLimit?: number;
}

/**
 * An address the chain has never seen holds nothing — which Blockfrost reports
 * as a 404, not as an empty list.
 *
 * This matters at exactly the moment the venue is most interesting: before the
 * first graduation both venue addresses are unused, so every read fails with
 * "The requested component has not been found" and names neither the address
 * nor the fact that the honest answer is "no pools yet".
 *
 * TWO THINGS MAKE THIS SAFE TO TRANSLATE HERE rather than in the shared
 * client, where a blanket 404-is-empty would mask real faults for every other
 * caller:
 *
 *   1. Both addresses are DERIVED from the venue's own compiled bytes a few
 *      lines below, and the pool's derivation is checked against the hash the
 *      deployment record carries. So a 404 cannot mean "you asked about an
 *      address that isn't ours" — there is no supplied address to be wrong.
 *   2. The match is deliberately narrow. If Blockfrost's message shape ever
 *      moves, this stops matching and the error propagates — loud, not an
 *      empty order book reported as a quiet healthy nothing.
 *
 * `getTxPosition` is left alone on purpose: a 404 there is a transaction the
 * chain does not have, which is a real problem and not an empty set.
 */
function emptyWhenUnused(client: BlockfrostClient): VenueChainProvider {
  return {
    async getAddressUtxosAll(address: string) {
      try {
        return await client.getAddressUtxosAll(address);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Blockfrost API error 404')) return [];
        throw err;
      }
    },
    getTxPosition: (txHash: string) => client.getTxPosition(txHash),
  };
}

/**
 * The launch package's own script addresses, derived from its compiled bytes
 * like the venue's are. A holder list names these so a page can tell a
 * contract holding a token — the curve, the escrow, the staking pool — from a
 * person, without anyone having typed an address in.
 */
const LAUNCH_SCRIPT_LABELS: [string, string][] = [
  ['bonding_curve_tier_b.bonding_curve_tier_b.spend', 'CURVE'],
  ['curve_order.curve_order.spend', 'CURVE ORDERS'],
  ['lp_escrow.lp_escrow.spend', 'LP ESCROW'],
  ['staking_pool.staking_pool.spend', 'STAKING POOL'],
  ['vesting.vesting.spend', 'VESTING'],
];

function launchScriptLabels(network: Parameters<typeof validatorToAddress>[0]): Record<string, string> {
  const labels: Record<string, string> = {};
  const validators = loadDeployedValidators(__dirname);
  for (const [title, label] of LAUNCH_SCRIPT_LABELS) {
    const entry = validators.find((v) => v.title === title);
    if (!entry) continue;
    labels[validatorToAddress(network, { type: 'PlutusV3', script: entry.compiledCode } as never)] = label;
  }
  return labels;
}

/** One venue validator's real bytes, by title, from whichever file holds them. */
function venueBlueprintCbor(title: string): string {
  const entry = loadDeployedValidators(__dirname).find((v) => v.title === title);
  if (!entry) {
    throw new Error(
      `${title} is in neither the venue blueprint nor its deployment record. The venue package may not ` +
        'have been built, or the title may have moved.',
    );
  }
  return entry.compiledCode;
}

function scriptSource(cbor: string, pointer: ReferenceScriptPointer | undefined): VenueScriptSource {
  return pointer ? { compiledScriptCbor: cbor, referenceScript: pointer } : { embeddedScriptCbor: cbor };
}

/**
 * The executor's wallet.
 *
 * Custody is an operations decision this file deliberately does not make: it
 * asks for a change address, a collateral UTXO and a signature, and never for
 * a secret it keeps.
 */
async function executorWallet(input: Input): Promise<CurveSpendWallet> {
  const provider = new BlockfrostProvider(input.blockfrostProjectId);
  if (input.executorSkeyExtendedHex || input.executorAddress) {
    return KeyCurveSpendWallet.forAddress({
      address: requireField(input, 'executorAddress', input.action),
      privateKeyExtendedHex: requireField(input, 'executorSkeyExtendedHex', input.action),
      provider,
    });
  }
  const mnemonic = requireField(input, 'executorMnemonic', input.action);
  return new MeshWallet({
    networkId: MESH_NETWORK_ID[input.network],
    fetcher: provider,
    submitter: provider,
    key: { type: 'mnemonic', words: mnemonic.trim().split(/\s+/) },
  }) as unknown as CurveSpendWallet;
}

/** A fill outcome, flattened so a log line says which order and what happened. */
function outcomeSummary(outcome: VenueFillOutcome) {
  const order = `${outcome.order.txHash}#${outcome.order.outputIndex}`;
  const pool = venueUnitOf(outcome.order.datum.pool_nft);
  switch (outcome.status) {
    case 'filled':
      return {
        order,
        pool,
        status: outcome.status,
        txHash: outcome.txHash,
        traded: outcome.traded,
        exFeeTaken: outcome.exFeeTaken,
        networkFee: outcome.networkFee,
      };
    default:
      return { order, pool, status: outcome.status, reason: outcome.reason };
  }
}

function roundSummary(round: VenueBatcherRound) {
  return {
    filled: round.filled,
    failed: round.failed,
    outcomes: round.outcomes.map(outcomeSummary),
    skipped: round.skipped,
  };
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, ['action', 'network', 'blockfrostProjectId', 'blockfrostUrl']);

  const lucidNetwork = CARDANO_NETWORK_MAP[input.network];
  if (!lucidNetwork) {
    throw new Error(
      `Unknown network "${String(input.network)}". Its slot configuration is not one of the known ones, and ` +
        'guessing it would silently widen every transaction validity range.',
    );
  }

  // The factory's applied bytes and its hash together: the hash IS the minting
  // policy, and a pool is a pool because that policy minted its NFT.
  const factory = loadAppliedVenueValidator(__dirname, VENUE_FACTORY_TITLE);
  const pool = loadAppliedVenueValidator(__dirname, VENUE_POOL_TITLE);
  const orderCbor = venueBlueprintCbor(VENUE_SWAP_ORDER_TITLE);

  const poolAddress = validatorToAddress(lucidNetwork, { type: 'PlutusV3', script: pool.compiledCode } as never);
  const orderAddress = validatorToAddress(lucidNetwork, { type: 'PlutusV3', script: orderCbor } as never);
  const factoryPolicyId = factory.hash;

  const provider = emptyWhenUnused(new BlockfrostClient({ apiKey: input.blockfrostProjectId, network: input.network }));
  const fillCostLovelace = input.fillCostLovelace ? BigInt(input.fillCostLovelace) : undefined;

  // Addresses are part of every answer, including a failing one: a round that
  // finds nothing and a round pointed somewhere empty look identical without
  // them.
  const where = { poolAddress, orderAddress, factoryPolicyId, poolHash: pool.hash };

  let result: unknown;
  switch (input.action) {
    case 'read-pools': {
      const read = await readVenuePools(provider, { poolAddress, factoryPolicyId });
      result = {
        ...where,
        pools: read.pools.map((p) => ({
          utxo: `${p.txHash}#${p.outputIndex}`,
          poolNft: venueUnitOf(p.datum.pool_nft),
          assets: p.assets,
          datum: p.datum,
        })),
        skipped: read.skipped,
      };
      break;
    }

    case 'read-round': {
      const round = await readVenueFillRound(provider, {
        poolAddress,
        orderAddress,
        factoryPolicyId,
        ...(fillCostLovelace !== undefined ? { fillCostLovelace } : {}),
      });
      result = {
        ...where,
        candidates: round.candidates.map((c) => ({
          order: `${c.order.txHash}#${c.order.outputIndex}`,
          pool: `${c.pool.txHash}#${c.pool.outputIndex}`,
          poolNft: venueUnitOf(c.order.datum.pool_nft),
          traded: c.traded,
        })),
        unfillable: round.unfillable.map((u) => ({
          order: `${u.order.txHash}#${u.order.outputIndex}`,
          reason: u.reason,
        })),
        skipped: round.skipped,
      };
      break;
    }

    case 'read-market': {
      const client = new BlockfrostClient({ apiKey: input.blockfrostProjectId, network: input.network });
      const market = await readVenueMarket(
        {
          chain: provider,
          history: client,
          blocks: {
            async getTxBlock(txHash: string) {
              const info = (await client.getTxInfo(txHash)) as { block_height: number; block_time: number };
              return { height: info.block_height, timeSeconds: info.block_time };
            },
          },
          holders: {
            // An asset the chain has never seen holds nothing: Blockfrost says
            // 404, and here that is an empty list rather than a fault.
            async getAssetAddresses(unit: string) {
              try {
                return await client.getAssetAddresses(unit);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (message.includes('Blockfrost API error 404')) return [];
                throw err;
              }
            },
          },
        },
        {
          poolAddress,
          orderAddress,
          factoryPolicyId,
          ...(input.poolNft ? { poolNft: input.poolNft } : {}),
          ...(input.since ? { since: input.since } : {}),
          ...(input.maxEvents ? { maxEvents: input.maxEvents } : {}),
          ...(input.holdersLimit !== undefined ? { holdersLimit: input.holdersLimit } : {}),
          ...(fillCostLovelace !== undefined ? { fillCostLovelace } : {}),
        },
      );
      result = {
        ...where,
        labels: { ...launchScriptLabels(lucidNetwork), [poolAddress]: 'POOL', [orderAddress]: 'ORDER BOOK' },
        pools: market.pools,
        skipped: market.skipped,
      };
      break;
    }

    case 'batch':
    case 'serve': {
      const filler = new VenueFiller({
        network: input.network,
        poolScript: scriptSource(pool.compiledCode, input.poolReferenceScript),
        orderScript: scriptSource(orderCbor, input.orderReferenceScript),
        provider: new BlockfrostProvider(input.blockfrostProjectId),
      });

      const batcher = new VenueBatcher({
        provider,
        filler,
        wallet: await executorWallet(input),
        network: input.network,
        poolAddress,
        orderAddress,
        factoryPolicyId,
        minOutputLovelace: input.minOutputLovelace ? BigInt(input.minOutputLovelace) : DEFAULT_MIN_OUTPUT_LOVELACE,
        ...(fillCostLovelace !== undefined ? { fillCostLovelace } : {}),
        ...(input.executorPayoutLovelace ? { executorPayoutLovelace: BigInt(input.executorPayoutLovelace) } : {}),
        ...(input.maxFillsPerPool ? { maxFillsPerPool: input.maxFillsPerPool } : {}),
        ...(input.maxFillsPerRound ? { maxFillsPerRound: input.maxFillsPerRound } : {}),
      });

      if (input.action === 'batch') {
        result = { ...where, ...roundSummary(await batcher.runRound()) };
        break;
      }

      // `serve` prints each round to stderr as it happens and the totals to
      // stdout at the end, so the one-JSON-object-on-stdout contract survives
      // a run of any length. A round that throws is reported and waited out
      // rather than allowed to end the service: a batcher that exits on the
      // first failed request stops the venue's market for as long as nobody is
      // watching it.
      const intervalMs = input.intervalMs ?? 20_000;
      const controller = new AbortController();
      const rounds: ReturnType<typeof roundSummary>[] = [];
      const errors: string[] = [];

      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      const timer = input.runForMs ? setTimeout(stop, input.runForMs) : undefined;

      await batcher.run({
        intervalMs,
        signal: controller.signal,
        onRound: (round) => {
          const summary = roundSummary(round);
          // Only a round that did something is worth a line; a quiet venue is
          // the normal state and should not fill a log with it.
          if (summary.filled > 0 || summary.failed > 0) {
            rounds.push(summary);
            process.stderr.write(`${JSON.stringify(jsonSafe(summary))}\n`);
          }
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          process.stderr.write(`${JSON.stringify({ roundError: message })}\n`);
        },
      });

      if (timer) clearTimeout(timer);
      result = {
        ...where,
        intervalMs,
        rounds: rounds.length,
        filled: rounds.reduce((n, r) => n + r.filled, 0),
        failed: rounds.reduce((n, r) => n + r.failed, 0),
        errors,
      };
      break;
    }

    default:
      throw new Error(`Unknown action: ${String(input.action)}`);
  }

  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
