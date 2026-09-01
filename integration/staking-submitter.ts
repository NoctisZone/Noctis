// ============================================================================
// Noctis Zone — Staking Rewards Pool submitter
// ============================================================================
// contracts/cardano/validators/staking_pool.ak — one unparameterized validator
// at one address, shared by every Cardano launch and told apart only by each
// pool's thread NFT.
//
// EVERY ACTION SPENDS THE POOL
// Positions are not UTXOs. They live behind a Merkle root in the pool's own
// datum, so a stake, a claim, an exit and a top-up are all one spend of one
// UTXO — which means they serialise, and two built against the same pool state
// cannot both land. A caller that loses the race rebuilds and retries; nothing
// is lost, because a proof is only valid against the root it was built for.
//
// WHAT THIS FILE OWES THE VALIDATOR
// Three things, and all three fail loudly rather than quietly:
//
//   1. The arithmetic. Every field of the continuing datum is compared on
//      chain against what the validator derives for itself, so this file
//      computes them through staking-math.ts — a line-for-line mirror, pinned
//      by tests against the validator's own.
//   2. The position tree. A proof is built off chain and verified on chain, so
//      the rebuilt tree must derive the root the pool datum actually carries.
//      Checked before any transaction is built (`loadPool`), so a rebuild that
//      is subtly wrong fails here with something to point at.
//   3. The clock. The validator reads the validity range's LOWER bound as
//      "now" and refuses a range wider than ten minutes.
//
// Two signing shapes, the same split as every other submitter here:
//   - WalletApi signing (`*WithWallet`) — the real holder-facing path.
//   - Extended-key signing — the platform-wallet custody scheme, for the CLI
//     verification path.
// ============================================================================

import type {
  LucidEvolution,
  Network as LucidNetwork,
  SpendingValidator,
  TxSignBuilder,
  UTxO,
  WalletApi,
} from '@lucid-evolution/lucid';
import {
  Blockfrost,
  CML,
  Constr,
  credentialToAddress,
  Data,
  getAddressDetails,
  Lucid,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import { bytesToHex, type CapProofStep, hexToBytes, recomputeCapRoot } from './cap-accumulator-tree.js';
import { selectStakingPoolUtxo } from './launch-utxo-lookup.js';
import { STAKING_POOL_REDEEMER } from './redeemer-indices.js';
import { NO_POSITION, StakeAccumulator, type StakePosition, stakeLeafFor } from './stake-accumulator-tree.js';
import {
  advance,
  currentAprPercent,
  debtAt,
  exhaustedAfter,
  owedAt,
  runwayDaysRemaining,
  UNSTAKE_LOCK_MS,
  validityRangeFor,
} from './staking-math.js';
import { type StakingPoolDatumData, StakingPoolDatumSchema, settlementDatum } from './tier-a-schemas.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

function keyHashFromAddress(address: string): string {
  const hash = getAddressDetails(address).paymentCredential?.hash;
  if (!hash) throw new Error(`Could not derive a payment-credential key hash from address ${address}.`);
  return hash;
}

/**
 * Minimum lovelace to keep beside the pool's tokens. The pool UTXO is
 * long-lived and its lovelace never changes, so this is only used when a
 * builder has to restate the value.
 */
const MIN_UTXO_LOVELACE = 2_000_000n;

/**
 * staking_pool.ak's own `min_platform_claim_fee_lovelace`.
 *
 * Mirrored here only so a fee below it fails with a legible message rather
 * than as an opaque on-chain script failure. The contract is the authority;
 * this is a courtesy check, and the same one
 * `tier-a-claims-submitter.ts` performs before a creator-fee claim.
 */
const MIN_PLATFORM_CLAIM_FEE_LOVELACE = 200_000n;

export interface StakingConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  stakingPoolScriptCbor: string;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, from the platform's own record of the
   * launch. The pool UTXO is authenticated against it — reading the policy off
   * the datum being checked would authenticate that datum against itself.
   */
  threadNftPolicyId: string;
}

/** One staker's position, as the pool records it. */
export interface StakerPosition {
  stakerVkhHex: string;
  stakedAmount: bigint;
  /** What they could claim right now. */
  owed: bigint;
  /** When the position last grew. The unstake lock runs from here. */
  sinceMs: bigint;
  unstakeUnlocksAtMs: bigint;
}

/** Everything a dashboard needs about one pool, in one read. */
export interface PoolOverview {
  launchIdHex: string;
  tokenUnit: string;
  /** Reward tokens the pool still holds and has not credited to anyone. */
  unallocated: bigint;
  emissionPerDay: bigint;
  totalStaked: bigint;
  stakerCount: number;
  /** The pool's whole token balance: staked tokens plus the reward budget. */
  poolTokenBalance: bigint;
  /** Every open position, so a page can show the pool as well as one wallet. */
  positions: StakerPosition[];
  /**
   * What one token staked earns per year at the CURRENT participation. Null
   * while nothing is staked — the rate is undefined then, not infinite.
   */
  currentAprPercent: number | null;
  /** Days of budget left at the current participation. Null while nothing is staked. */
  runwayDaysRemaining: number | null;
  exhaustedAtMs: bigint | null;
  /** Set once exhausted; a top-up before this clears it and revives the pool. */
  closesAfterMs: bigint | null;
}

/** A pool loaded, its position tree rebuilt, and the two checked against each other. */
interface LoadedPool {
  utxo: UTxO;
  datum: StakingPoolDatumData;
  positions: StakeAccumulator;
}

export class StakingSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private address: string;

  constructor(private config: StakingConfig) {
    this.validator = { type: 'PlutusV3', script: config.stakingPoolScriptCbor };
    this.address = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Marks the rejection handled WITHOUT swallowing it: a later await still
    // rejects with the same error. Without this, a caller that constructs the
    // submitter and fails before using it leaves Node printing a stack trace
    // to stderr after the real answer has gone to stdout.
    this.lucidPromise.catch(() => {});
  }

  get poolAddress(): string {
    return this.address;
  }

  private async allUtxos(lucid: LucidEvolution): Promise<UTxO[]> {
    return lucid.utxosAt(this.address);
  }

  /**
   * The one Pool UTXO for this launch, authenticated by its thread NFT.
   *
   * The validator is unparameterized, so every launch's pool shares one
   * address and the datum's `launch_id` is a claim by whoever created the
   * UTXO. The role-tagged thread NFT is what distinguishes it, and a second
   * UTXO answering to the same launch stops the lookup rather than being
   * silently passed over.
   */
  async findPoolUtxo(lucid: LucidEvolution): Promise<{ utxo: UTxO; datum: StakingPoolDatumData }> {
    return selectStakingPoolUtxo<StakingPoolDatumData>(
      await this.allUtxos(lucid),
      this.address,
      this.config.launchIdHex,
      StakingPoolDatumSchema,
      this.config.threadNftPolicyId,
    );
  }

  /** Live on-chain pool state, without rebuilding the position tree. */
  async readPoolDatum(): Promise<StakingPoolDatumData> {
    const lucid = await this.lucidPromise;
    return (await this.findPoolUtxo(lucid)).datum;
  }

  /**
   * The pool, plus its position tree rebuilt from history and CHECKED against
   * the root the datum carries.
   *
   * The check is the point. A proof built from a tree that disagrees with the
   * chain by even one position fails script evaluation with a message naming
   * neither the tree nor the position — so the disagreement is caught here,
   * where it can say what it is. Same discipline as `rebuildCapAccumulator`.
   */
  async loadPool(positions?: StakeAccumulator): Promise<LoadedPool> {
    const lucid = await this.lucidPromise;
    const { utxo, datum } = await this.findPoolUtxo(lucid);
    const tree = positions ?? (await this.rebuildPositions(datum));
    const derived = bytesToHex(tree.root());
    if (derived !== datum.stake_root) {
      throw new Error(
        `The rebuilt position tree does not match the pool. It derives ${derived}, ` +
          `and the pool carries ${datum.stake_root}. Every proof built from it would be refused, ` +
          'so nothing is submitted. Rebuild from a complete history before retrying.',
      );
    }
    return { utxo, datum, positions: tree };
  }

  /**
   * Replay this pool's own spends to recover every open position.
   *
   * Positions live behind a root, so the set behind it exists nowhere on
   * chain in readable form — but every redeemer that ever moved one is public,
   * and each names the staker and the position it started from. Folding them
   * in order reproduces the set. Anyone can do this; nothing here is privileged
   * or private, which is what keeps the pool auditable without a governor.
   */
  async rebuildPositions(datum?: StakingPoolDatumData): Promise<StakeAccumulator> {
    const pool = datum ?? (await this.readPoolDatum());
    const events = await this.readPoolRedeemers();
    const tree = new StakeAccumulator();
    let acc = 0n;
    let unallocated = 0n;
    let totalStaked = 0n;
    let lastUpdate = 0n;
    let seenGenesis = false;

    for (const event of events) {
      if (!seenGenesis) {
        // The first spend acts on the pool as Graduate opened it.
        acc = 0n;
        unallocated = event.poolBefore.unallocated;
        totalStaked = event.poolBefore.total_staked;
        lastUpdate = event.poolBefore.last_update_ms;
        seenGenesis = true;
      }
      const state = {
        emission_per_day: pool.emission_per_day,
        acc_reward_per_token: acc,
        total_staked: totalStaked,
        unallocated,
        last_update_ms: lastUpdate,
      };
      const advanced = advance(state, event.nowMs);
      acc = advanced.acc;
      unallocated = advanced.unallocated;
      lastUpdate = event.nowMs;

      if (event.kind === 'topUp') {
        unallocated += event.amount;
        continue;
      }
      if (event.kind === 'close') break;

      const before = event.before;
      const owed = owedAt(before, acc);
      if (event.kind === 'stake') {
        const amount = before.amount + event.amount + owed;
        tree.set(hexToBytes(event.stakerVkhHex), { amount, debt: debtAt(amount, acc), since: event.nowMs });
        totalStaked += event.amount + owed;
      } else if (event.kind === 'unstake') {
        tree.set(hexToBytes(event.stakerVkhHex), NO_POSITION);
        totalStaked -= before.amount;
      } else {
        tree.set(hexToBytes(event.stakerVkhHex), {
          amount: before.amount,
          debt: debtAt(before.amount, acc),
          since: before.since,
        });
      }
    }
    return tree;
  }

  /**
   * Every spend of this pool, oldest first, decoded from its redeemer.
   *
   * Blockfrost gives a redeemer's DATA HASH rather than its bytes, and indexes
   * the bytes alongside datums — so this is two lookups per spend, the same
   * route tier-a-trade-history-reader.ts already established.
   */
  private async readPoolRedeemers(): Promise<PoolEvent[]> {
    const bf = async <T>(path: string): Promise<T> => {
      const res = await fetch(`${this.config.blockfrostUrl}${path}`, {
        headers: { project_id: this.config.blockfrostProjectId },
      });
      if (!res.ok) throw new Error(`Blockfrost ${path} returned ${res.status}`);
      return res.json() as Promise<T>;
    };

    const txs: Array<{ tx_hash: string }> = [];
    for (let page = 1; ; page++) {
      const batch = await bf<Array<{ tx_hash: string }>>(
        `/addresses/${this.address}/transactions?page=${page}&order=asc&count=100`,
      );
      txs.push(...batch);
      if (batch.length < 100) break;
    }

    const out: PoolEvent[] = [];
    for (const { tx_hash } of txs) {
      const utxos = await bf<{
        inputs: Array<{ tx_hash: string; output_index: number; address: string; inline_datum: string | null }>;
      }>(`/txs/${tx_hash}/utxos`);
      // Only a transaction that SPENT this pool carries a redeemer for it.
      const spentOurs = utxos.inputs.find((i) => i.address === this.address && i.inline_datum);
      if (!spentOurs?.inline_datum) continue;
      let poolBefore: StakingPoolDatumData;
      try {
        poolBefore = Data.from<StakingPoolDatumData>(spentOurs.inline_datum, StakingPoolDatumSchema);
      } catch {
        continue;
      }
      if (poolBefore.launch_id !== this.config.launchIdHex) continue;

      const redeemers = await bf<Array<{ purpose: string; redeemer_data_hash: string }>>(`/txs/${tx_hash}/redeemers`);
      const tx = await bf<{ valid_contract: boolean; block_time: number }>(`/txs/${tx_hash}`);
      if (!tx.valid_contract) continue;

      for (const r of redeemers) {
        if (r.purpose !== 'spend') continue;
        const { cbor } = await bf<{ cbor: string }>(`/scripts/datum/${r.redeemer_data_hash}/cbor`);
        const event = decodePoolRedeemer(cbor, poolBefore, BigInt(tx.block_time) * 1000n);
        if (event) out.push(event);
      }
    }
    return out;
  }

  /** Everything a dashboard needs about this pool, in one call. */
  async overview(): Promise<PoolOverview> {
    const { utxo, datum, positions } = await this.loadPool();
    const nowMs = BigInt(Date.now());
    const { acc } = advance(datum, nowMs);
    const tokenUnit = datum.token_policy_id + datum.token_asset_name;

    const open = positions.all().map(({ stakerVkhHex, position }) => ({
      stakerVkhHex,
      stakedAmount: position.amount,
      owed: owedAt(position, acc),
      sinceMs: position.since,
      unstakeUnlocksAtMs: position.since + UNSTAKE_LOCK_MS,
    }));

    return {
      launchIdHex: datum.launch_id,
      tokenUnit,
      unallocated: datum.unallocated,
      emissionPerDay: datum.emission_per_day,
      totalStaked: datum.total_staked,
      stakerCount: open.length,
      poolTokenBalance: utxo.assets[tokenUnit] ?? 0n,
      positions: open,
      currentAprPercent: currentAprPercent(datum.emission_per_day, datum.total_staked),
      runwayDaysRemaining: runwayDaysRemaining(datum.emission_per_day, datum.unallocated, datum.total_staked),
      exhaustedAtMs: datum.exhausted_at,
      closesAfterMs: datum.exhausted_at === null ? null : datum.exhausted_at + 7_776_000_000n,
    };
  }

  /** One wallet's own position, or null if they have none open. */
  async positionOf(stakerAddress: string): Promise<StakerPosition | null> {
    const vkh = keyHashFromAddress(stakerAddress);
    const { positions } = await this.overview().then(async (o) => ({ positions: o.positions }));
    return positions.find((p) => p.stakerVkhHex === vkh) ?? null;
  }

  // --------------------------------------------------------------------
  // Builders. Each spends the pool and rewrites one position.
  // --------------------------------------------------------------------

  private proofFields(proof: CapProofStep[]): Constr<Data>[] {
    return proof.map((step) => new Constr(0, [bytesToHex(step.sibling), new Constr(step.goesLeft ? 1 : 0, [])]));
  }

  private positionFields(pos: StakePosition): Constr<Data> {
    return new Constr(0, [pos.amount, pos.debt, pos.since]);
  }

  /**
   * Everything the four position-moving redeemers share: advance the pool,
   * rewrite one leaf, and restate the whole continuing datum exactly as the
   * validator will derive it.
   */
  private buildSpend(
    lucid: LucidEvolution,
    loaded: LoadedPool,
    stakerVkhHex: string,
    nowMs: number,
    plan: (ctx: { acc: bigint; unallocated: bigint; before: StakePosition; owed: bigint }) => {
      redeemerIndex: number;
      extraRedeemerFields: Data[];
      after: StakePosition;
      totalStakedDelta: bigint;
      poolTokenDelta: bigint;
      unallocatedExtra?: bigint;
      payout?: bigint;
      signer?: string;
    },
  ): { tx: ReturnType<LucidEvolution['newTx']>; payout: bigint } {
    const { utxo, datum, positions } = loaded;
    const now = BigInt(nowMs);
    const { acc, unallocated } = advance(datum, now);
    const key = hexToBytes(stakerVkhHex);
    const before = positions.get(key);
    const owed = owedAt(before, acc);
    const proof = positions.proofFor(key);

    const step = plan({ acc, unallocated, before, owed });

    // The proof is verified locally against the root the pool actually
    // carries, before anything is submitted. On chain this failing is a script
    // error naming nothing; here it names the position.
    if (bytesToHex(recomputeCapRoot(stakeLeafFor(key, before), proof)) !== datum.stake_root) {
      throw new Error(
        `The proof for ${stakerVkhHex} does not reach the pool's own root. The rebuilt position ` +
          'tree is out of step with the chain; nothing was submitted.',
      );
    }

    positions.set(key, step.after);
    const nextRoot = bytesToHex(positions.root());
    const nextUnallocated = unallocated + (step.unallocatedExtra ?? 0n);

    const nextDatum: StakingPoolDatumData = {
      ...datum,
      stake_root: nextRoot,
      acc_reward_per_token: acc,
      total_staked: datum.total_staked + step.totalStakedDelta,
      unallocated: nextUnallocated,
      last_update_ms: now,
      exhausted_at: exhaustedAfter(datum.exhausted_at, nextUnallocated, now),
    };

    const tokenUnit = datum.token_policy_id + datum.token_asset_name;
    const poolTokens = (utxo.assets[tokenUnit] ?? 0n) + step.poolTokenDelta;
    const poolAssets: Record<string, bigint> = {
      lovelace: utxo.assets.lovelace ?? MIN_UTXO_LOVELACE,
      [this.config.threadNftPolicyId + threadAssetNameFor(datum.launch_id)]: 1n,
    };
    if (poolTokens > 0n) poolAssets[tokenUnit] = poolTokens;

    const { from, to } = validityRangeFor(nowMs);
    let tx = lucid
      .newTx()
      .collectFrom(
        [utxo],
        Data.to(
          new Constr(step.redeemerIndex, [
            stakerVkhHex,
            this.positionFields(before),
            this.proofFields(proof),
            ...step.extraRedeemerFields,
          ]),
        ),
      )
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.address,
        { kind: 'inline', value: Data.to<StakingPoolDatumData>(nextDatum, StakingPoolDatumSchema) },
        poolAssets,
      )
      .validFrom(from)
      .validTo(to);

    if (step.signer) tx = tx.addSigner(step.signer);
    return { tx, payout: step.payout ?? 0n };
  }

  private async payoutTo(
    lucid: LucidEvolution,
    loaded: LoadedPool,
    stakerAddress: string,
    amount: bigint,
    tx: ReturnType<LucidEvolution['newTx']>,
  ): Promise<ReturnType<LucidEvolution['newTx']>> {
    if (amount <= 0n) return tx;
    const { datum, utxo } = loaded;
    const tokenUnit = datum.token_policy_id + datum.token_asset_name;
    // The output NAMES the input it settles. Without the tag, one payment
    // could answer this pool and another contract that happened to owe the
    // same wallet the same amount. See noctis/settlement.
    return tx.pay.ToAddressWithData(
      stakerAddress,
      { kind: 'inline', value: settlementDatum(utxo) },
      { lovelace: MIN_UTXO_LOVELACE, [tokenUnit]: amount },
    );
  }

  /** Open or add to a position. Anything owed is compounded, and the lock restarts. */
  async stakeCore(lucid: LucidEvolution, stakerAddress: string, amount: bigint, nowMs = Date.now()) {
    if (amount <= 0n) throw new Error('Stake amount must be positive.');
    const loaded = await this.loadPool();
    const vkh = keyHashFromAddress(stakerAddress);
    const { tx } = this.buildSpend(lucid, loaded, vkh, nowMs, ({ acc, before, owed }) => {
      const total = before.amount + amount + owed;
      return {
        redeemerIndex: STAKING_POOL_REDEEMER.Stake,
        extraRedeemerFields: [amount],
        after: { amount: total, debt: debtAt(total, acc), since: BigInt(nowMs) },
        totalStakedDelta: amount + owed,
        poolTokenDelta: amount,
        signer: stakerAddress,
      };
    });
    return tx.complete();
  }

  /** Close a position: the stake and everything owed on it, out. */
  async unstakeCore(lucid: LucidEvolution, stakerAddress: string, nowMs = Date.now()) {
    const loaded = await this.loadPool();
    const vkh = keyHashFromAddress(stakerAddress);
    const before = loaded.positions.get(hexToBytes(vkh));
    if (before.amount <= 0n) throw new Error('This wallet has no open staking position in this pool.');
    const unlocksAt = before.since + UNSTAKE_LOCK_MS;
    if (BigInt(nowMs) < unlocksAt) {
      throw new Error(
        `This position is locked until ${new Date(Number(unlocksAt)).toISOString()}. ` +
          'Adding to a stake restarts the lock; claiming rewards does not.',
      );
    }
    const { tx, payout } = this.buildSpend(lucid, loaded, vkh, nowMs, ({ before: pos, owed }) => ({
      redeemerIndex: STAKING_POOL_REDEEMER.Unstake,
      extraRedeemerFields: [],
      after: NO_POSITION,
      totalStakedDelta: -pos.amount,
      poolTokenDelta: -(pos.amount + owed),
      payout: pos.amount + owed,
      signer: stakerAddress,
    }));
    return (await this.payoutTo(lucid, loaded, stakerAddress, payout, tx)).complete();
  }

  /** Take what is owed and leave the position open. */
  /**
   * Claim accrued rewards.
   *
   * @param platformClaimFeeLovelace  The real dollar-equivalent of
   *   STAKING_CLAIM_FEE_USD, computed by the CALLER via
   *   `ada-price-oracle.ts`'s `usdToMinAdaLovelace()`. This class stays
   *   oracle-agnostic, the same convention `tier-a-claims-submitter.ts`
   *   already follows for the creator-fee claim. Must be at least the
   *   contract's own floor.
   *
   *   It is a real output to the governor rather than a client convention,
   *   because `ClaimRewards` takes no signature: anyone can build this
   *   transaction themselves, so only the validator can make the charge stick.
   */
  async claimCore(lucid: LucidEvolution, stakerAddress: string, platformClaimFeeLovelace: bigint, nowMs = Date.now()) {
    if (platformClaimFeeLovelace < MIN_PLATFORM_CLAIM_FEE_LOVELACE) {
      throw new Error(
        `platformClaimFeeLovelace (${platformClaimFeeLovelace}) is below the contract's own floor ` +
          `(${MIN_PLATFORM_CLAIM_FEE_LOVELACE}) — the transaction would fail on-chain.`,
      );
    }
    const loaded = await this.loadPool();
    const vkh = keyHashFromAddress(stakerAddress);
    const { acc } = advance(loaded.datum, BigInt(nowMs));
    const before = loaded.positions.get(hexToBytes(vkh));
    if (before.amount <= 0n) throw new Error('This wallet has no open staking position in this pool.');
    if (owedAt(before, acc) <= 0n) throw new Error('Nothing has accrued on this position yet.');

    const { tx, payout } = this.buildSpend(lucid, loaded, vkh, nowMs, ({ acc: a, before: pos, owed }) => ({
      redeemerIndex: STAKING_POOL_REDEEMER.ClaimRewards,
      extraRedeemerFields: [],
      // `since` is untouched: taking rewards is not a new commitment, so it
      // neither restarts the unstake lock nor extends it.
      after: { amount: pos.amount, debt: debtAt(pos.amount, a), since: pos.since },
      totalStakedDelta: 0n,
      poolTokenDelta: -owed,
      payout: owed,
    }));
    const withPayout = await this.payoutTo(lucid, loaded, stakerAddress, payout, tx);
    return this.chargeGovernor(loaded, platformClaimFeeLovelace, withPayout).complete();
  }

  /**
   * The flat claim charge, paid to the governor the pool was opened with and
   * tagged with the pool input like every other settlement output.
   *
   * The validator nets this rather than merely reading the address, so the
   * charge has to be lovelace that really arrives — a transaction the governor
   * itself funded would not satisfy it.
   */
  private chargeGovernor(
    loaded: LoadedPool,
    feeLovelace: bigint,
    tx: ReturnType<LucidEvolution['newTx']>,
  ): ReturnType<LucidEvolution['newTx']> {
    const governorAddress = credentialToAddress(this.config.network, {
      type: 'Key',
      hash: loaded.datum.governor_pub_key_hash,
    });
    return tx.pay.ToAddressWithData(
      governorAddress,
      { kind: 'inline', value: settlementDatum(loaded.utxo) },
      { lovelace: feeLovelace },
    );
  }

  /** Add to the reward budget. Permissionless — anyone may. */
  async topUpCore(lucid: LucidEvolution, funderAddress: string, amount: bigint, nowMs = Date.now()) {
    if (amount <= 0n) throw new Error('Top-up amount must be positive.');
    const { utxo, datum } = await this.findPoolUtxo(lucid);
    const now = BigInt(nowMs);
    const { acc, unallocated } = advance(datum, now);
    const tokenUnit = datum.token_policy_id + datum.token_asset_name;
    const nextDatum: StakingPoolDatumData = {
      ...datum,
      acc_reward_per_token: acc,
      unallocated: unallocated + amount,
      last_update_ms: now,
      // Revived: a top-up clears the exhaustion stamp, so the close cooldown
      // starts again from scratch if this budget runs out in turn.
      exhausted_at: null,
    };
    const { from, to } = validityRangeFor(nowMs);
    return lucid
      .newTx()
      .collectFrom([utxo], Data.to(new Constr(STAKING_POOL_REDEEMER.TopUpPool, [amount])))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.address,
        { kind: 'inline', value: Data.to<StakingPoolDatumData>(nextDatum, StakingPoolDatumSchema) },
        {
          lovelace: utxo.assets.lovelace ?? MIN_UTXO_LOVELACE,
          [this.config.threadNftPolicyId + threadAssetNameFor(datum.launch_id)]: 1n,
          [tokenUnit]: (utxo.assets[tokenUnit] ?? 0n) + amount,
        },
      )
      .validFrom(from)
      .validTo(to)
      .complete();
  }

  // --------------------------------------------------------------------
  // Wallet-signed entry points
  // --------------------------------------------------------------------

  private async withWallet(
    walletApi: WalletApi,
    build: (lucid: LucidEvolution, address: string) => Promise<TxSignBuilder>,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const address = await lucid.wallet().address();
    const tx = await build(lucid, address);
    const signed = await tx.sign.withWallet().complete();
    return { txHash: await signed.submit() };
  }

  stakeWithWallet(walletApi: WalletApi, amount: bigint): Promise<{ txHash: string }> {
    return this.withWallet(walletApi, (lucid, address) => this.stakeCore(lucid, address, amount));
  }

  unstakeWithWallet(walletApi: WalletApi): Promise<{ txHash: string }> {
    return this.withWallet(walletApi, (lucid, address) => this.unstakeCore(lucid, address));
  }

  claimRewardsWithWallet(walletApi: WalletApi, platformClaimFeeLovelace: bigint): Promise<{ txHash: string }> {
    return this.withWallet(walletApi, (lucid, address) => this.claimCore(lucid, address, platformClaimFeeLovelace));
  }

  topUpWithWallet(walletApi: WalletApi, amount: bigint): Promise<{ txHash: string }> {
    return this.withWallet(walletApi, (lucid, address) => this.topUpCore(lucid, address, amount));
  }

  // --------------------------------------------------------------------
  // Extended-key signing — the CLI verification path
  // --------------------------------------------------------------------

  private async withKey(
    privateKeyExtendedHex: string,
    address: string,
    build: (lucid: LucidEvolution) => Promise<TxSignBuilder>,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(privateKeyExtendedHex);
    lucid.selectWallet.fromAddress(address, await lucid.utxosAt(address));
    const tx = await build(lucid);
    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    return { txHash: await signed.submit() };
  }

  stakeWithKey(keyHex: string, address: string, amount: bigint, nowMs?: number) {
    return this.withKey(keyHex, address, (lucid) => this.stakeCore(lucid, address, amount, nowMs));
  }

  unstakeWithKey(keyHex: string, address: string, nowMs?: number) {
    return this.withKey(keyHex, address, (lucid) => this.unstakeCore(lucid, address, nowMs));
  }

  claimWithKey(keyHex: string, address: string, platformClaimFeeLovelace: bigint, nowMs?: number) {
    return this.withKey(keyHex, address, (lucid) => this.claimCore(lucid, address, platformClaimFeeLovelace, nowMs));
  }

  topUpWithKey(keyHex: string, address: string, amount: bigint, nowMs?: number) {
    return this.withKey(keyHex, address, (lucid) => this.topUpCore(lucid, address, amount, nowMs));
  }
}

/** noctis/thread_nft's `thread_asset_name`: role byte, then the launch id. */
function threadAssetNameFor(launchIdHex: string): string {
  return `05${launchIdHex}`.slice(0, 64);
}

type PoolEvent =
  | {
      kind: 'stake';
      stakerVkhHex: string;
      before: StakePosition;
      amount: bigint;
      nowMs: bigint;
      poolBefore: StakingPoolDatumData;
    }
  | {
      kind: 'unstake' | 'claim';
      stakerVkhHex: string;
      before: StakePosition;
      nowMs: bigint;
      poolBefore: StakingPoolDatumData;
    }
  | { kind: 'topUp'; amount: bigint; nowMs: bigint; poolBefore: StakingPoolDatumData }
  | { kind: 'close'; nowMs: bigint; poolBefore: StakingPoolDatumData };

/**
 * One pool spend, from its raw redeemer.
 *
 * Read positionally from a bare `Constr` rather than through a schema: what is
 * needed is the constructor INDEX and the fields under it, and the redeemer is
 * a sum type whose variants differ in arity.
 */
function decodePoolRedeemer(cborHex: string, poolBefore: StakingPoolDatumData, nowMs: bigint): PoolEvent | null {
  let decoded: unknown;
  try {
    decoded = Data.from(cborHex);
  } catch {
    return null;
  }
  if (!(decoded instanceof Constr)) return null;
  const { index, fields } = decoded;

  const positionAt = (i: number): StakePosition | null => {
    const raw = fields[i];
    if (!(raw instanceof Constr) || raw.fields.length !== 3) return null;
    const [amount, debt, since] = raw.fields;
    if (typeof amount !== 'bigint' || typeof debt !== 'bigint' || typeof since !== 'bigint') return null;
    return { amount, debt, since };
  };

  switch (index) {
    case STAKING_POOL_REDEEMER.Stake: {
      const before = positionAt(1);
      const amount = fields[3];
      if (typeof fields[0] !== 'string' || !before || typeof amount !== 'bigint') return null;
      return { kind: 'stake', stakerVkhHex: fields[0], before, amount, nowMs, poolBefore };
    }
    case STAKING_POOL_REDEEMER.Unstake:
    case STAKING_POOL_REDEEMER.ClaimRewards: {
      const before = positionAt(1);
      if (typeof fields[0] !== 'string' || !before) return null;
      return {
        kind: index === STAKING_POOL_REDEEMER.Unstake ? 'unstake' : 'claim',
        stakerVkhHex: fields[0],
        before,
        nowMs,
        poolBefore,
      };
    }
    case STAKING_POOL_REDEEMER.TopUpPool: {
      if (typeof fields[0] !== 'bigint') return null;
      return { kind: 'topUp', amount: fields[0], nowMs, poolBefore };
    }
    case STAKING_POOL_REDEEMER.ClosePool:
      return { kind: 'close', nowMs, poolBefore };
    default:
      return null;
  }
}

export { decodePoolRedeemer, extendedHexToBech32PrivateKey, keyHashFromAddress };
