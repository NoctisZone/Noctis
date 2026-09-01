// ============================================================================
// Noctis Zone — Staking Rewards Pool real Cardano actions
// ============================================================================
// One consolidated CLI (action-dispatched), matching tier-b-curve-action.ts's
// established pattern rather than one file per action.
//
// Input: single JSON object on stdin, `action` selects the operation.
// Output: single JSON object on stdout (bigints stringified) or { error }.
//
// There is no publish, no snapshot and no proof-serving action here, and that
// absence is the point: the pool computes what it owes from its own state, so
// nothing off chain decides anything. What remains is the four actions a
// participant takes and two reads.
// ============================================================================

import { usdToMinAdaLovelace } from '../ada-price-oracle.js';
import { StakingSubmitter } from '../staking-submitter.js';
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

type Action = 'stake' | 'unstake' | 'claim-rewards' | 'top-up' | 'read-pool' | 'read-position';

interface Input {
  action: Action;
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  /** The launch's thread-NFT policy id, from WordPress's own launch record —
   *  never from a datum. Every action reads the pool UTXO, and that read is
   *  authenticated against this. */
  threadNftPolicyId: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;

  /** stake / unstake / claim-rewards / top-up — the CLI signs with a real
   *  extended key, the same platform-wallet custody scheme every other
   *  submitter here uses. The browser path signs through CIP-30 instead. */
  signerPrivateKeyExtendedHex?: string;
  signerAddress?: string;

  /** stake / top-up */
  amount?: string;

  /** read-position */
  stakerAddress?: string;

  /**
   * Overrides "now". The validator reads the transaction's own validity range,
   * so this only shifts the window a spend declares — it cannot make the chain
   * believe a different time. For Preprod rehearsals of the unstake lock.
   */
  nowMs?: number;
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());

  requireFieldsFalsy(input, [
    'action',
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'blockfrostProjectId',
    'blockfrostUrl',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);
  const stakingPoolScriptCbor = loadValidatorCbor(blueprint, 'staking_pool.staking_pool.spend');

  // Lazily constructed, and that ordering is the point: the submitter opens a
  // Blockfrost connection in its constructor, which nothing awaits until a
  // method runs. Built before the per-action field checks, a request that was
  // never valid still opened a connection — and when that connection then
  // failed, its rejection had no awaiter, so Node printed a stack trace to
  // stderr AFTER the real {"error"} answer had gone to stdout.
  let instance: StakingSubmitter | null = null;
  const submitter = (): StakingSubmitter =>
    (instance ??= new StakingSubmitter({
      blockfrostProjectId: input.blockfrostProjectId,
      blockfrostUrl: input.blockfrostUrl,
      network: CARDANO_NETWORK_MAP[input.network],
      stakingPoolScriptCbor,
      launchIdHex: input.launchIdHex,
      threadNftPolicyId: input.threadNftPolicyId,
    }));

  /** The signing pair every write action needs. */
  const signer = () => ({
    key: requireField(input, 'signerPrivateKeyExtendedHex', input.action),
    address: requireField(input, 'signerAddress', input.action),
  });

  let result: unknown;
  switch (input.action) {
    case 'stake': {
      const amount = BigInt(requireField(input, 'amount', input.action));
      const { key, address } = signer();
      result = await submitter().stakeWithKey(key, address, amount, input.nowMs);
      break;
    }
    case 'unstake': {
      const { key, address } = signer();
      result = await submitter().unstakeWithKey(key, address, input.nowMs);
      break;
    }
    case 'claim-rewards': {
      const { key, address } = signer();
      // STAKING_CLAIM_FEE_USD, priced live. The contract's own check is a
      // conservative 0.2 ADA floor because Aiken has no in-circuit oracle, so
      // this real figure clears it comfortably. Reported alongside the hash so
      // a caller can see what was actually charged.
      const { minLovelace: platformClaimFeeLovelace } = await usdToMinAdaLovelace(1);
      const claimed = await submitter().claimWithKey(key, address, platformClaimFeeLovelace, input.nowMs);
      result = { ...claimed, platformClaimFeeLovelace: platformClaimFeeLovelace.toString() };
      break;
    }
    case 'top-up': {
      const amount = BigInt(requireField(input, 'amount', input.action));
      const { key, address } = signer();
      result = await submitter().topUpWithKey(key, address, amount, input.nowMs);
      break;
    }
    case 'read-pool': {
      // The whole pool: budget, rate, everyone staked, and what each is owed.
      // Rebuilds the position tree from history and refuses to answer unless
      // it derives the root the pool actually carries.
      //
      // The claim charge rides along because a browser cannot price it: the
      // widget builds its own claim transaction and needs the figure, and this
      // is the response the page already fetches. Priced here, server-side,
      // like every other USD-denominated amount on the platform.
      const overview = await submitter().overview();
      const { minLovelace: platformClaimFeeLovelace } = await usdToMinAdaLovelace(1);
      result = { ...overview, platformClaimFeeLovelace: platformClaimFeeLovelace.toString() };
      break;
    }
    case 'read-position': {
      const stakerAddress = requireField(input, 'stakerAddress', input.action);
      result = await submitter().positionOf(stakerAddress);
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
