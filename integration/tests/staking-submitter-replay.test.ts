/**
 * The staking pool's position replay.
 *
 * WHY THIS FILE EXISTS
 *
 * Positions live behind a Merkle root, so the set itself exists nowhere on
 * chain in readable form. `rebuildPositions` recovers it by folding every past
 * spend — and every proof the submitter ever builds is built from that result.
 * It therefore has to reproduce EXACTLY what each validator computed, down to
 * the instant each spend was evaluated at.
 *
 * That instant is the transaction's validity-interval lower bound, because
 * that is what the validator reads as "now". It is NOT the block's timestamp,
 * which merely records when a block happened to be minted and has no bearing
 * on what the script saw. The two differ by however long the transaction sat
 * in the mempool plus whatever margin the builder left, so a replay reading
 * the wrong one rebuilds every position with the wrong `since` and `debt` and
 * lands on a root the pool does not carry.
 *
 * This defect is the dangerous shape: a builder that gets a timestamp wrong
 * has its transaction refused, but a replay that gets it wrong returns a
 * plausible-looking answer that no chain will ever accept.
 *
 * The module had no test file at all when four clock defects were found in it
 * on 2026-09-01, which is the other reason this exists.
 */

import { Constr, Data, slotToUnixTime } from '@lucid-evolution/lucid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, type CapProofStep } from '../cap-accumulator-tree.js';
import { StakeAccumulator } from '../stake-accumulator-tree.js';
import { StakingSubmitter } from '../staking-submitter.js';
import { type StakingPoolDatumData, StakingPoolDatumSchema } from '../tier-a-schemas.js';

const NETWORK = 'Preprod' as const;
const LAUNCH_ID = 'ab'.repeat(32);
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);
const THREAD_POLICY = 'cc'.repeat(28);
const STAKER_VKH = '3a'.repeat(28);
const TX_HASH = 'ee'.repeat(32);
const REDEEMER_HASH = 'dd'.repeat(32);

/**
 * A slot whose real time is far from the block time below, so a replay reading
 * the wrong field cannot accidentally agree with one reading the right one.
 */
const INVALID_BEFORE_SLOT = 132_562_544;
const VALIDATED_AT_MS = slotToUnixTime(NETWORK, INVALID_BEFORE_SLOT);
/** Nine minutes later — a transaction sat in the mempool, as they do. */
const BLOCK_TIME_S = Math.floor(VALIDATED_AT_MS / 1000) + 540;

const STAKE_AMOUNT = 5_000n;

function poolDatum(overrides: Partial<StakingPoolDatumData> = {}): StakingPoolDatumData {
  return {
    launch_id: LAUNCH_ID,
    creator_pub_key_hash: '22'.repeat(28),
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    thread_nft_policy: THREAD_POLICY,
    emission_per_day: 22n,
    stake_root: bytesToHex(new StakeAccumulator().root()),
    acc_reward_per_token: 0n,
    total_staked: 0n,
    unallocated: 25_000n,
    last_update_ms: BigInt(VALIDATED_AT_MS) - 600_000n,
    exhausted_at: null,
    governor_pub_key_hash: '11'.repeat(28),
    ...overrides,
  } as StakingPoolDatumData;
}

/** A proof, encoded exactly as the submitter encodes one. */
function proofToData(proof: CapProofStep[]) {
  return proof.map((step) => new Constr(0, [bytesToHex(step.sibling), new Constr(step.goesLeft ? 1 : 0, [])]));
}

/** The Stake redeemer as the submitter encodes it: [vkh, before, proof, amount]. */
function stakeRedeemerCbor(): string {
  const proof = new StakeAccumulator().proofFor(Buffer.from(STAKER_VKH, 'hex'));
  return Data.to(new Constr(0, [STAKER_VKH, new Constr(0, [0n, 0n, 0n]), proofToData(proof), STAKE_AMOUNT]));
}

describe('the staking pool position replay', () => {
  let submitter: StakingSubmitter;
  let poolAddress: string;

  beforeEach(() => {
    submitter = new StakingSubmitter({
      blockfrostProjectId: 'proj',
      blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      network: NETWORK,
      // Any well-formed script: the replay never runs it, it only needs the
      // address it hashes to so it can recognise its own inputs.
      stakingPoolScriptCbor: '590004',
      launchIdHex: LAUNCH_ID,
      threadNftPolicyId: THREAD_POLICY,
    });
    poolAddress = (submitter as unknown as { address: string }).address;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Serves the five Blockfrost reads the replay makes, in canned form. */
  function stubChain(opts: { invalidBefore: string | null; redeemerCbor: string; before?: StakingPoolDatumData }) {
    const before = opts.before ?? poolDatum();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.replace('https://cardano-preprod.blockfrost.io/api/v0', '');
        const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

        if (path.startsWith(`/addresses/${poolAddress}/transactions`)) {
          return json(path.includes('page=1') ? [{ tx_hash: TX_HASH }] : []);
        }
        if (path === `/txs/${TX_HASH}/utxos`) {
          return json({
            inputs: [
              {
                tx_hash: TX_HASH,
                output_index: 0,
                address: poolAddress,
                inline_datum: Data.to<StakingPoolDatumData>(before, StakingPoolDatumSchema),
              },
            ],
          });
        }
        if (path === `/txs/${TX_HASH}/redeemers`) {
          return json([{ purpose: 'spend', redeemer_data_hash: REDEEMER_HASH }]);
        }
        if (path === `/txs/${TX_HASH}`) {
          return json({ valid_contract: true, block_time: BLOCK_TIME_S, invalid_before: opts.invalidBefore });
        }
        if (path === `/scripts/datum/${REDEEMER_HASH}/cbor`) {
          return json({ cbor: opts.redeemerCbor });
        }
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }),
    );
  }

  it('dates a spend by the instant it was VALIDATED at, not by when its block was minted', async () => {
    stubChain({ invalidBefore: String(INVALID_BEFORE_SLOT), redeemerCbor: stakeRedeemerCbor() });

    const rebuilt = await submitter.rebuildPositions(poolDatum());
    const position = rebuilt.get(Buffer.from(STAKER_VKH, 'hex'));

    // The whole point: `since` is the validity bound, and the block time is a
    // materially different number that must NOT appear.
    expect(position.since).toBe(BigInt(VALIDATED_AT_MS));
    expect(position.since).not.toBe(BigInt(BLOCK_TIME_S) * 1000n);
    expect(position.amount).toBe(STAKE_AMOUNT);
  });

  it('skips a spend with no lower bound, because one could not have validated', async () => {
    stubChain({ invalidBefore: null, redeemerCbor: stakeRedeemerCbor() });

    const rebuilt = await submitter.rebuildPositions(poolDatum());
    expect(rebuilt.get(Buffer.from(STAKER_VKH, 'hex')).amount).toBe(0n);
  });
});
