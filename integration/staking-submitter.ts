// ============================================================================
// Noctis Zone — Staking Rewards Pool real Cardano submitter
// ============================================================================
// contracts/cardano/validators/staking_pool.ak — one shared validator
// address for Tier A AND Tier B (not tier-specific like bonding_curve vs
// bonding_curve_tier_b). Two datum shapes share the address: Pool (one per
// launch, real depleting reward-token UTXO value) and Position (one per
// stake action). See tier-a-schemas.ts's StakingDatumSchema/
// StakingPoolDatumSchema/StakingPositionDatumSchema for the verified field
// order/constructor indices (confirmed against a freshly-regenerated
// plutus.json, round-tripped through a real Data.to/Data.from encode/
// decode cycle before use — not assumed from .ak source alone).
//
// Constructor indices, StakingPoolRedeemer (verified against plutus.json):
//   Unstake=0 (no fields), ClaimRewards=1 (staker_vkh, claimed_cumulative_
//   amount, merkle_proof), TopUpPool=2 (amount), PublishRewardRoot=3
//   (new_root), QueryState=4 (hardened to always-False, never
//   constructed here).
//
// Staking itself (first or additional stake) needs NO redeemer — creating
// a script UTXO is permissionless on Cardano, same as any deposit. Only
// spending an existing Position/Pool UTXO needs a redeemer.
//
// ClaimRewards is deliberately PERMISSIONLESS on-chain (no signature
// check) — "the proof is the authorization," same idiom as Graduate/
// ExpireCurve elsewhere in this codebase. The staker's own wallet is the
// practical caller in every method below, but nothing on-chain requires
// that; a relayer could submit on a staker's behalf without changing where
// funds land (the payment-credential-only check guarantees
// payout always reaches the real staker_vkh's address regardless of who
// signs/submits the transaction).
//
// Two signing shapes, same split as every other Tier A/B submitter in
// this codebase:
//   - Extended-key signing (topUpPool, publishRewardRoot): the creator/
//     governor platform-wallet custody scheme only ever persists an
//     encrypted extended skey, never a mnemonic — see tier-a-claims-
//     submitter.ts's own header for why.
//   - WalletApi signing (stakeWithWallet, unstakeWithWallet,
//     claimRewardsWithWallet): the real holder-facing production path,
//     lucid.selectWallet.fromAPI(walletApi) + sign.withWallet().
// ============================================================================

import type {
  LucidEvolution,
  Network as LucidNetwork,
  SpendingValidator,
  TxSignBuilder,
  UTxO,
  WalletApi,
} from '@lucid-evolution/lucid';
import { Blockfrost, CML, Constr, Data, getAddressDetails, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { clearedBitmapHex, setBit, testBit } from './claim-bitmap.js';
import { selectStakingPoolUtxo } from './launch-utxo-lookup.js';
import { STAKING_POOL_REDEEMER } from './redeemer-indices.js';
import {
  type StakingDatumData,
  StakingDatumSchema,
  type StakingPoolDatumData,
  type StakingPositionDatumData,
  settlementDatum,
} from './tier-a-schemas.js';

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

/** Same pattern as tier-a-curve-submitter.ts's buyerKeyHashFromAddress. */
function keyHashFromAddress(address: string): string {
  const details = getAddressDetails(address);
  const hash = details.paymentCredential?.hash;
  if (!hash) {
    throw new Error(`Could not derive a payment-credential key hash from address ${address}.`);
  }
  return hash;
}

/** Minimum lovelace to include alongside a real launch token in a Position/
 *  Pool UTXO — same conservative floor value this codebase's own
 *  staking_pool.ak tests use throughout (2 ADA), not a computed min-UTxO
 *  (Lucid Evolution's own coin selection tops this up further if the real
 *  protocol parameter requires more for the actual datum size). */
const MIN_UTXO_LOVELACE = 2_000_000n;

export interface StakingConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  stakingPoolScriptCbor: string;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. Every state UTXO is authenticated against it — reading the
   * policy off the datum being checked would authenticate that datum against
   * itself. See launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export interface StakingPosition {
  utxo: UTxO;
  datum: StakingPositionDatumData;
}

/** Names one of a staker's positions. Both halves, because an index alone is meaningless and a hash alone is not unique. */
export interface PositionRef {
  txHash: string;
  outputIndex: number;
}

/**
 * Which of a staker's positions an unstake should close.
 *
 * Unstaking closes one position and returns its stake. Positions differ in
 * `stake_timestamp`, and the bonding period is measured from it, so closing
 * the wrong one is not interchangeable with closing the right one — it can
 * discard seasoning the staker has already served.
 *
 * So the two ambiguous readings are refused rather than resolved:
 *
 *   - a reference naming a transaction but not an output, which would
 *     otherwise fall back to output 0 and match a position the caller never
 *     named;
 *   - no reference at all while the staker holds more than one position,
 *     which would otherwise close whichever the chain query happened to
 *     return first — an order nothing promises and two of our own chain
 *     backends have already disagreed about.
 *
 * The unambiguous convenience is kept: no reference and exactly one position
 * closes that one.
 */
export function selectPositionToUnstake(
  positions: readonly StakingPosition[],
  ref?: Partial<PositionRef>,
): StakingPosition {
  if (positions.length === 0) {
    throw new Error('No staking positions found for this wallet.');
  }

  const named = (p: StakingPosition) => `${p.utxo.txHash}#${p.utxo.outputIndex}`;

  if (ref?.txHash === undefined && ref?.outputIndex === undefined) {
    if (positions.length > 1) {
      throw new Error(
        `This wallet holds ${positions.length} staking positions, so which one to unstake has to be named: ` +
          `${positions.map(named).join(', ')}. Pass positionTxHash and positionOutputIndex.`,
      );
    }
    return positions[0] as StakingPosition;
  }

  if (ref.txHash === undefined || ref.outputIndex === undefined) {
    throw new Error(
      'A position is named by BOTH positionTxHash and positionOutputIndex. ' +
        'One transaction can carry more than one output, so half a reference names no particular position.',
    );
  }

  const found = positions.find((p) => p.utxo.txHash === ref.txHash && p.utxo.outputIndex === ref.outputIndex);
  if (!found) {
    throw new Error(
      `No staking position at ${ref.txHash}#${ref.outputIndex} for this wallet. ` +
        `It holds: ${positions.map(named).join(', ')}.`,
    );
  }
  return found;
}

export class StakingSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private address: string;

  constructor(private config: StakingConfig) {
    this.validator = { type: 'PlutusV3', script: config.stakingPoolScriptCbor };
    this.address = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  private async allUtxos(lucid: LucidEvolution): Promise<UTxO[]> {
    return lucid.utxosAt(this.address);
  }

  private decodeDatum(utxo: UTxO): StakingDatumData | null {
    if (!utxo.datum) return null;
    try {
      return Data.from<StakingDatumData>(utxo.datum, StakingDatumSchema);
    } catch {
      return null;
    }
  }

  /**
   * The one Pool UTXO for this launch, authenticated by its thread NFT.
   *
   * staking_pool.ak is unparameterized, so every launch's pool and every
   * position of every launch share one address. The datum's `launch_id` is a
   * claim by whoever created the UTXO — paying to a script address runs no
   * validator — so the pool's role-tagged thread NFT is what distinguishes it,
   * and a second UTXO answering to the same launch stops the lookup rather
   * than being silently passed over. Same pair `pool_thread_nft_intact`
   * checks on-chain. See launch-utxo-lookup.ts.
   *
   * Throws if staking was never enabled/seeded (Graduate's staking_seeded
   * check) — as it did before, though the message now names the missing NFT.
   */
  async findPoolUtxo(lucid: LucidEvolution): Promise<{ utxo: UTxO; datum: StakingPoolDatumData }> {
    const utxos = await this.allUtxos(lucid);
    return selectStakingPoolUtxo<StakingPoolDatumData>(
      utxos,
      this.address,
      this.config.launchIdHex,
      StakingDatumSchema,
      this.config.threadNftPolicyId,
    );
  }

  /** Live on-chain pool state — panel calls this directly, same "readCurveDatum()" convention as tier-a-claims-submitter.ts. */
  async readPoolDatum(): Promise<StakingPoolDatumData> {
    const lucid = await this.lucidPromise;
    const { datum } = await this.findPoolUtxo(lucid);
    return datum;
  }

  /**
   * Every real Position UTXO belonging to one staker, for this launch — the
   * panel's "your stakes" list.
   *
   * Deliberately NOT authenticated by a thread NFT the way findPoolUtxo above
   * is, and the Position datum deliberately carries no policy field to do it
   * with: a position is created once per stake action, so there is no
   * singleton for a token to mark. Nothing here needs one either. This returns
   * every match rather than choosing among them, so there is no first-wins
   * decision to get wrong, and a forged position gains its author nothing —
   * `Unstake` pays out the UTXO's own real value, never the `staked_amount`
   * its datum claims, and the reward tree derives weight from that same real
   * balance.
   */
  async findPositions(stakerAddress: string): Promise<StakingPosition[]> {
    const lucid = await this.lucidPromise;
    const stakerVkh = keyHashFromAddress(stakerAddress);
    const utxos = await this.allUtxos(lucid);
    const out: StakingPosition[] = [];
    for (const utxo of utxos) {
      const decoded = this.decodeDatum(utxo);
      if (decoded && 'Position' in decoded) {
        const pos = decoded.Position[0];
        if (pos.launch_id === this.config.launchIdHex && pos.staker_vkh === stakerVkh) {
          out.push({ utxo, datum: pos });
        }
      }
    }
    return out;
  }

  // --------------------------------------------------------------------
  // Stake — plain deposit, no redeemer, no spend
  // --------------------------------------------------------------------

  private async stakeCore(
    lucid: LucidEvolution,
    stakerAddress: string,
    amount: bigint,
    stakeTimestampMsOverride?: number,
  ): Promise<TxSignBuilder> {
    if (amount <= 0n) throw new Error('Stake amount must be positive.');
    const { datum: pool } = await this.findPoolUtxo(lucid);
    const stakerVkh = keyHashFromAddress(stakerAddress);
    const tokenUnit = pool.token_policy_id + pool.token_asset_name;

    const positionDatum: StakingDatumData = {
      Position: [
        {
          launch_id: this.config.launchIdHex,
          staker_vkh: stakerVkh,
          staked_amount: amount,
          // Real POSIX ms — matches this codebase's now-consistent
          // millisecond convention. Not independently
          // re-verified on-chain (staking_pool.ak's own file header: the
          // governor's off-chain reward formula is the only consumer,
          // and it's the staker's OWN wallet signing this deposit — the
          // same self-attested-timestamp trust boundary CLAUDE.md already
          // documents for this field), so a caller-supplied override is
          // safe to accept — unlike backdating a GOVERNOR-trusted action
          // (ActivateCurve etc.), a staker backdating their own stake
          // only ever costs THEM real bonding-period eligibility sooner,
          // never anyone else's funds. Exists so a real Preprod
          // verification pass can test bonding-period accrual without a
          // literal 7-day wait, same precedent already established for
          // ExpireCurve/SealLock/StartVesting.
          stake_timestamp: BigInt(stakeTimestampMsOverride ?? Date.now()),
        },
      ],
    };

    return lucid
      .newTx()
      .pay.ToContract(
        this.address,
        {
          kind: 'inline',
          value: Data.to<StakingDatumData>(positionDatum, StakingDatumSchema),
        },
        { lovelace: MIN_UTXO_LOVELACE, [tokenUnit]: amount },
      )
      .addSigner(stakerAddress)
      .complete();
  }

  /** Real production path. */
  async stakeWithWallet(walletApi: WalletApi, amount: bigint): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const stakerAddress = await lucid.wallet().address();
    const tx = await this.stakeCore(lucid, stakerAddress, amount);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** CLI-driven verification path — mnemonic-based, same pattern as tier-a-curve-submitter.ts's buyTokens() (a test-wallet convenience, not the production signing shape). `stakeTimestampMsOverride` lets a real Preprod verification pass backdate a position's bonding-period clock without a literal 7-day wait — see stakeCore's own comment for why this is safe. */
  async stake(stakerMnemonic: string, amount: bigint, stakeTimestampMsOverride?: number): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(stakerMnemonic);
    const stakerAddress = await lucid.wallet().address();
    const tx = await this.stakeCore(lucid, stakerAddress, amount, stakeTimestampMsOverride);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------
  // Unstake — full withdrawal of one position, staker-signed
  // --------------------------------------------------------------------

  private async unstakeCore(
    lucid: LucidEvolution,
    stakerAddress: string,
    position: StakingPosition,
  ): Promise<TxSignBuilder> {
    const stakerVkh = keyHashFromAddress(stakerAddress);
    if (position.datum.staker_vkh !== stakerVkh) {
      throw new Error('This position does not belong to the connected wallet.');
    }

    // Unstake takes no fields.
    const unstakeRedeemer = new Constr(STAKING_POOL_REDEEMER.Unstake, []);

    return lucid
      .newTx()
      .collectFrom([position.utxo], Data.to(unstakeRedeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToAddressWithData(
        stakerAddress,
        { kind: 'inline', value: settlementDatum(position.utxo) },
        position.utxo.assets,
      )
      .addSigner(stakerAddress)
      .complete();
  }

  /** Real production path. */
  async unstakeWithWallet(walletApi: WalletApi, position: StakingPosition): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const stakerAddress = await lucid.wallet().address();
    const tx = await this.unstakeCore(lucid, stakerAddress, position);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** CLI-driven verification path — mnemonic-based. */
  async unstake(stakerMnemonic: string, position: StakingPosition): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(stakerMnemonic);
    const stakerAddress = await lucid.wallet().address();
    const tx = await this.unstakeCore(lucid, stakerAddress, position);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------
  // ClaimRewards — permissionless, Merkle-proof-of-membership
  // --------------------------------------------------------------------

  /**
   * @param payoutAmount  What the CURRENT reward_root pays this staker — a
   *   delta, not a running total. From the published snapshot's own entry.
   * @param leafIndex  This staker's bit in the pool's nullifier, from the
   *   same snapshot. It is hashed into their leaf, so a proof cannot be
   *   aimed at anybody else's bit.
   * @param merkleProof  This staker's inclusion proof against the current
   *   reward_root, from the same snapshot.
   */
  private async claimRewardsCore(
    lucid: LucidEvolution,
    stakerAddress: string,
    payoutAmount: bigint,
    leafIndex: number,
    merkleProof: Array<{ sibling: string; goesLeft: boolean }>,
  ): Promise<TxSignBuilder> {
    const { utxo: poolUtxo, datum: pool } = await this.findPoolUtxo(lucid);

    if (payoutAmount <= 0n) {
      throw new Error(`payoutAmount must be positive, got ${payoutAmount}.`);
    }
    if (!Number.isInteger(leafIndex) || leafIndex < 0) {
      throw new Error(`leafIndex must be a whole number of at least 0, got ${leafIndex}.`);
    }
    const bitCount = (pool.claimed_bits.length / 2) * 8;
    if (leafIndex >= bitCount) {
      throw new Error(
        `leafIndex ${leafIndex} is outside this root's nullifier, which holds ${bitCount} bit(s). ` +
          'The proof was most likely built against a different root than the one on chain.',
      );
    }
    if (testBit(pool.claimed_bits, leafIndex)) {
      throw new Error(
        `This reward has already been claimed against the current root (bit ${leafIndex} is set). ` +
          'A staker may claim once per published root.',
      );
    }

    const payout = payoutAmount;
    const tokenUnit = pool.token_policy_id + pool.token_asset_name;

    const newPoolDatum: StakingDatumData = {
      Pool: [{ ...pool, claimed_bits: setBit(pool.claimed_bits, leafIndex) }],
    };
    const newPoolAssets = {
      ...poolUtxo.assets,
      [tokenUnit]: (poolUtxo.assets[tokenUnit] ?? 0n) - payout,
    };

    // ClaimRewards: Constr 1, fields (staker_vkh, payout_amount, leaf_index,
    // merkle_proof).
    // MerkleProofStep: Constr 0, fields (sibling, goes_left) — goes_left is
    // a real Aiken Bool, encoded as Constr 1=True/0=False (no fields
    // either way), same pattern darkveil-claim-submitter.ts already
    // established for the structurally identical bonding_curve_tier_b.ak
    // MerkleProofStep — NOT a raw JS boolean, which Data.to can't encode.
    const claimRedeemer = new Constr(STAKING_POOL_REDEEMER.ClaimRewards, [
      keyHashFromAddress(stakerAddress),
      payoutAmount,
      BigInt(leafIndex),
      merkleProof.map((step) => new Constr(0, [step.sibling, new Constr(step.goesLeft ? 1 : 0, [])])),
    ]);

    return lucid
      .newTx()
      .collectFrom([poolUtxo], Data.to(claimRedeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.address,
        {
          kind: 'inline',
          value: Data.to<StakingDatumData>(newPoolDatum, StakingDatumSchema),
        },
        newPoolAssets,
      )
      .pay.ToAddressWithData(
        stakerAddress,
        { kind: 'inline', value: settlementDatum(poolUtxo) },
        { [tokenUnit]: payout },
      )
      .complete();
  }

  /** Real production path — permissionless on-chain, but the connected wallet is the practical caller (see class header). */
  async claimRewardsWithWallet(
    walletApi: WalletApi,
    payoutAmount: bigint,
    leafIndex: number,
    merkleProof: Array<{ sibling: string; goesLeft: boolean }>,
  ): Promise<{ txHash: string; payout: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const stakerAddress = await lucid.wallet().address();

    const tx = await this.claimRewardsCore(lucid, stakerAddress, payoutAmount, leafIndex, merkleProof);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, payout: payoutAmount };
  }

  /** CLI-driven verification path — mnemonic-based. */
  async claimRewards(
    stakerMnemonic: string,
    payoutAmount: bigint,
    leafIndex: number,
    merkleProof: Array<{ sibling: string; goesLeft: boolean }>,
  ): Promise<{ txHash: string; payout: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(stakerMnemonic);
    const stakerAddress = await lucid.wallet().address();

    const tx = await this.claimRewardsCore(lucid, stakerAddress, payoutAmount, leafIndex, merkleProof);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, payout: payoutAmount };
  }

  // --------------------------------------------------------------------
  // TopUpPool — creator-only
  // --------------------------------------------------------------------

  private async topUpPoolCore(lucid: LucidEvolution, creatorAddress: string, amount: bigint): Promise<TxSignBuilder> {
    if (amount <= 0n) throw new Error('Top-up amount must be positive.');
    const { utxo: poolUtxo, datum: pool } = await this.findPoolUtxo(lucid);
    if (keyHashFromAddress(creatorAddress) !== pool.creator_pub_key_hash) {
      throw new Error('Only the launch creator can top up the staking pool.');
    }
    const tokenUnit = pool.token_policy_id + pool.token_asset_name;
    const newPoolAssets = {
      ...poolUtxo.assets,
      [tokenUnit]: (poolUtxo.assets[tokenUnit] ?? 0n) + amount,
    };

    // TopUpPool's one field is the amount.
    const topUpRedeemer = new Constr(STAKING_POOL_REDEEMER.TopUpPool, [amount]);

    return lucid
      .newTx()
      .collectFrom([poolUtxo], Data.to(topUpRedeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.address,
        {
          kind: 'inline',
          value: Data.to<StakingDatumData>({ Pool: [pool] }, StakingDatumSchema),
        },
        newPoolAssets,
      )
      .addSigner(creatorAddress)
      .complete();
  }

  /** CLI-driven path — creator platform-wallet custody only ever persists an extended skey, never a mnemonic (same reasoning as tier-a-claims-submitter.ts). */
  async topUpPool(
    creatorPrivateKeyExtendedHex: string,
    creatorAddress: string,
    amount: bigint,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(creatorPrivateKeyExtendedHex);
    const creatorUtxos = await lucid.utxosAt(creatorAddress);
    lucid.selectWallet.fromAddress(creatorAddress, creatorUtxos);

    const tx = await this.topUpPoolCore(lucid, creatorAddress, amount);
    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** Real production path (browser-connected creator wallet). */
  async topUpPoolWithWallet(walletApi: WalletApi, amount: bigint): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const creatorAddress = await lucid.wallet().address();
    const tx = await this.topUpPoolCore(lucid, creatorAddress, amount);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------
  // PublishRewardRoot — governor-only, automated (WP-Cron)
  // --------------------------------------------------------------------

  /**
   * @param entryCount how many stakers the new root pays. It sizes the root's
   *   own claim nullifier, one bit each — a map too small leaves the highest
   *   leaf indices with no bit to claim against. Take it from the tree that
   *   produced the root, never from a separate count.
   */
  private async publishRewardRootCore(
    lucid: LucidEvolution,
    governorAddress: string,
    newRootHex: string,
    entryCount: number,
    expectedClaimedBitsHex?: string,
  ): Promise<TxSignBuilder> {
    const { utxo: poolUtxo, datum: pool } = await this.findPoolUtxo(lucid);
    if (keyHashFromAddress(governorAddress) !== pool.governor_pub_key_hash) {
      throw new Error('Only the governor can publish a new reward root.');
    }

    // Publishing is what CLEARS the nullifier, and the outgoing nullifier is
    // the only record of who took what under the outgoing root. So whoever
    // folded that record into the running already-paid totals must have read
    // the same bits this transaction is about to erase — a claim landing in
    // between would be erased without ever being counted as paid, and that
    // staker's amount would be handed to them a second time in this very
    // root.
    //
    // Checked rather than assumed: the caller says which bits it folded, and
    // a mismatch aborts instead of publishing. The next run reads the fresh
    // ones and proceeds normally.
    if (expectedClaimedBitsHex !== undefined && pool.claimed_bits !== expectedClaimedBitsHex) {
      throw new Error(
        `The pool's claim record changed while this snapshot was being built ` +
          `(folded ${expectedClaimedBitsHex}, found ${pool.claimed_bits}). ` +
          'Publishing now would clear a claim before it was counted as paid. Rebuild and retry.',
      );
    }

    // A new root is a new roster, so it brings its own nullifier, every bit
    // clear. Publishing is also the only thing that clears the map, which is
    // what lets a staker claim again under the next root.
    const claimedBits = clearedBitmapHex(entryCount);

    const newPoolDatum: StakingDatumData = {
      Pool: [{ ...pool, reward_root: newRootHex, claimed_bits: claimedBits }],
    };

    // PublishRewardRoot's fields are (new_root, claimed_bits).
    const publishRedeemer = new Constr(STAKING_POOL_REDEEMER.PublishRewardRoot, [newRootHex, claimedBits]);

    return lucid
      .newTx()
      .collectFrom([poolUtxo], Data.to(publishRedeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.address,
        {
          kind: 'inline',
          value: Data.to<StakingDatumData>(newPoolDatum, StakingDatumSchema),
        },
        poolUtxo.assets,
      )
      .addSigner(governorAddress)
      .complete();
  }

  /** Governor-signed, automated (WP-Cron → CLI → this method). Same extended-key custody reasoning as topUpPool. */
  async publishRewardRoot(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    newRootHex: string,
    entryCount: number,
    /** The nullifier the caller folded into its already-paid totals — see publishRewardRootCore. */
    expectedClaimedBitsHex?: string,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const tx = await this.publishRewardRootCore(lucid, governorAddress, newRootHex, entryCount, expectedClaimedBitsHex);
    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { extendedHexToBech32PrivateKey, keyHashFromAddress };
