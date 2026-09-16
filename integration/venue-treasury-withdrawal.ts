// ============================================================================
// Noctis Zone — NoctisSwap: collecting the platform's slice
// ============================================================================
// A treasury withdrawal is the only transaction on this venue that runs TWO
// scripts against the same pool and lets neither of them decide alone.
//
//   - `pool.ak` action 3 spends the pool and requires a withdrawal at the
//     first `dao_policy` credential. It fixes what may change — the two
//     treasury counters and nothing else — and pins the value movement to the
//     counter movement exactly.
//   - `treasury.ak` runs at that credential and decides how much. It re-finds
//     the pool independently, re-checks the shape, and requires the payout to
//     reach the address the POOL'S OWN DATUM names.
//
// So the platform cannot pay itself somewhere else, cannot take more than has
// accrued, and cannot touch the creator's counters or the reserves on the way
// past. Neither script trusts the other's reading; both do their own.
//
// **Two positions are carried in redeemers, and both are read by index.**
// `PoolRedeemer.self_ix` and `Withdraw.pool_in_ix` both index `self.inputs`,
// which the builder SORTS before it serialises — so they are positions after
// somebody else's sort, not the order this module lists things in. That is the
// same trap the fill builder documents, and it fails the same silent way: a
// well-formed transaction where a script checks the wrong input. This module
// avoids the guesswork rather than predicting through it — it CHOOSES the
// wallet inputs itself instead of leaving them to coin selection, so the whole
// input set is known before the sort, and then decodes the finished
// transaction to confirm the sort came out where it said.
//
// **The transaction cannot pay for itself out of the pool.** Both validators
// pin the successor's value to the counter movement exactly, so not one
// lovelace can be skimmed for the network fee. The platform's wallet funds it,
// which is the opposite of a fill — where the ORDER funds its own execution
// and a wallet input would break the two-input rule outright.
//
// **The payout's ADA side is a floor, not an exact figure, and that is what
// makes a small collection possible at all.** A payout carrying tokens needs
// the protocol's minimum lovelace to exist as a UTXO, which a small ADA
// counter cannot always cover; the surplus comes from the platform's own
// inputs and lands in the platform's own output, so it is a transfer rather
// than a cost. The token side stays exact, because nothing makes a surplus
// there necessary.
// ============================================================================

import { Constr, credentialToAddress, credentialToRewardAddress, Data } from '@lucid-evolution/lucid';
import { applyCborEncoding, MeshTxBuilder, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import type { CurveNetwork, CurveSpendProvider, CurveSpendWallet } from './mesh-curve-spend.js';
import { VENUE_TREASURY_REDEEMER } from './redeemer-indices.js';
import {
  MESH_NETWORK_ID,
  type ResolvedReferenceScript,
  resolveReferenceScript,
  scriptHashOf,
} from './reference-script.js';
import type { VenueScriptSource } from './venue-fill-submitter.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from './venue-pool.js';
import { VENUE_POOL_ACTION, type VenuePoolUtxo, venuePoolRedeemer, venueUnitOf } from './venue-swap.js';

/** The chains Lucid names differently from Mesh. One setting, not two. */
const LUCID_NETWORK = { preview: 'Preview', preprod: 'Preprod', mainnet: 'Mainnet' } as const;

/**
 * The least lovelace a payout output can carry, when it carries a token too.
 *
 * Not a policy figure — the protocol's per-byte minimum decides it, and this
 * is what the platform must top a small ADA counter up to so the output can
 * exist. It is charged to the platform's own wallet and paid straight back
 * into the platform's own output, so it costs nothing but the working capital
 * it ties up alongside the tokens.
 *
 * **Overshooting is safe.** `treasury.ak` states the ADA side as
 * `paid >= -delta`, so a payout carrying more lovelace than the pool released
 * is accepted; a payout carrying more TOKENS is not, and the plan below never
 * builds one. Re-measure when the protocol's per-byte parameters move.
 */
export const VENUE_TREASURY_PAYOUT_FLOOR_LOVELACE = 1_500_000n;

/**
 * Lovelace the funding selection aims for on top of what the payout needs.
 *
 * The network fee and the change output's own minimum both come out of the
 * platform's inputs, and a selection that covers the fee but leaves change
 * below its minimum is refused by the builder rather than by the node. This
 * is the headroom that stops that being a live concern.
 */
export const VENUE_TREASURY_FUNDING_HEADROOM_LOVELACE = 5_000_000n;

/**
 * Budgets declared for the two scripts, rather than measured.
 *
 * Reasoned rather than simulated, and marked as such: the pool's DAO arm does
 * what its swap arm does less the constant-product arithmetic, so the swap's
 * measured 730,000 is a ceiling over it; the treasury script does a comparable
 * amount of searching and comparing over a smaller transaction. Left unset on
 * the config, the provider's evaluator measures the real transaction and these
 * are only a starting value — which is the normal case. Pinned, they are
 * declared as-is, for the reason the fill builder pins its own: a remote
 * evaluator is a third party that can be wrong, and when it is, it fails in a
 * form that names nothing. Measure both before mainnet.
 */
export const VENUE_TREASURY_POOL_EXECUTION_UNITS = { mem: 730_000, steps: 250_000_000 } as const;
export const VENUE_TREASURY_WITHDRAW_EXECUTION_UNITS = { mem: 500_000, steps: 180_000_000 } as const;

/** `TreasuryAction.Withdraw` — two positions the validator resolves by number. */
export function venueTreasuryWithdrawRedeemer(poolInIx: number, treasuryOutIx: number): string {
  return Data.to(new Constr(VENUE_TREASURY_REDEEMER.Withdraw, [BigInt(poolInIx), BigInt(treasuryOutIx)]));
}

/** `TreasuryAction.SetTreasuryFee` — the platform's other move, same shape. */
export function venueSetTreasuryFeeRedeemer(poolInIx: number, newFee: bigint): string {
  return Data.to(new Constr(VENUE_TREASURY_REDEEMER.SetTreasuryFee, [BigInt(poolInIx), newFee]));
}

/** Encodes a pool datum the way the pool's own output carries it. */
export function venuePoolDatumCbor(datum: VenuePoolConfigData): string {
  return Data.to(datum, VenuePoolConfigSchema);
}

/** One withdrawal, described without reference to any transaction library. */
export interface VenueTreasuryWithdrawalPlan {
  pool: VenuePoolUtxo;
  /** How much of each counter this takes. Both non-negative, at least one positive. */
  takeX: bigint;
  takeY: bigint;
  /** The pool's continuing datum and value. Always placed first. */
  nextDatum: VenuePoolConfigData;
  nextDatumCbor: string;
  nextAssets: Record<string, bigint>;
  /** The platform's payout. Always placed second — the redeemer names its index. */
  payoutAddress: string;
  payoutAssets: Record<string, bigint>;
  /**
   * Lovelace the platform adds so the payout can exist as a UTXO.
   *
   * Not a cost. It leaves the platform's wallet and arrives in the platform's
   * own output in the same transaction; what it does is tie that much up
   * beside the tokens until they are spent.
   */
  topUpLovelace: bigint;
}

function held(assets: Readonly<Record<string, bigint>>, unit: string): bigint {
  return assets[unit] ?? 0n;
}

/**
 * The script credential the pool defers its treasury action to.
 *
 * `dao_policy[0]`, written by the factory. The pool reads its treasury
 * authority from that entry and its governance authority from the next, so the
 * order is load-bearing — and a withdrawal at any other credential runs
 * something the pool never asked for. `null` when the datum names no script
 * there, which is a pool no treasury action can move at all.
 */
export function venueTreasuryCredentialOf(cfg: VenuePoolConfigData): string | null {
  const entry = cfg.dao_policy[0] as unknown;
  if (typeof entry !== 'object' || entry === null || !('StakingHash' in entry)) return null;
  const inner = (entry as { StakingHash: unknown[] }).StakingHash[0] as unknown;
  if (typeof inner !== 'object' || inner === null || !('ScriptCredential' in inner)) return null;
  const hash = (inner as { ScriptCredential: unknown[] }).ScriptCredential[0];
  return typeof hash === 'string' ? hash : null;
}

/**
 * The withdrawal, worked out and checked against both validators' rules.
 *
 * Every refusal below is one a script would make anyway. Making it here is
 * what turns "a script exited early" into a sentence naming the pool, the
 * counter and the amount — the same reason the fill builder refuses an
 * under-funded order by name rather than letting the node refuse it without
 * one.
 */
export function planVenueTreasuryWithdrawal(args: {
  pool: VenuePoolUtxo;
  network: CurveNetwork;
  /** How much of each counter to take. Both default to everything accrued. */
  takeX?: bigint;
  takeY?: bigint;
  /** The platform wallet's stake key, if the payout should be a base address. */
  payoutStakePkh?: string;
  payoutFloorLovelace?: bigint;
}): VenueTreasuryWithdrawalPlan {
  const cfg = args.pool.datum;
  const unitX = venueUnitOf(cfg.pool_x);
  const unitY = venueUnitOf(cfg.pool_y);
  const takeX = args.takeX ?? cfg.treasury_x;
  const takeY = args.takeY ?? cfg.treasury_y;
  const poolNft = venueUnitOf(cfg.pool_nft);

  if (takeX < 0n || takeY < 0n) {
    throw new Error(`A withdrawal takes a non-negative amount from each counter; this one takes ${takeX}/${takeY}.`);
  }
  if (takeX === 0n && takeY === 0n) {
    throw new Error(
      `This withdrawal from pool ${poolNft} moves nothing. \`treasury.ak\` requires one side to really ` +
        'fall, so a transaction that takes zero from both counters is refused rather than wasted.',
    );
  }
  if (takeX > cfg.treasury_x || takeY > cfg.treasury_y) {
    throw new Error(
      `Pool ${poolNft} has accrued ${cfg.treasury_x}/${cfg.treasury_y} to the platform, and this ` +
        `withdrawal asks for ${takeX}/${takeY}. A counter may not go below zero, and the reserves beside ` +
        'it belong to the pool rather than to the platform.',
    );
  }

  // A datum claiming more than the UTXO holds is not withdrawable: the pool's
  // own reserves would already read negative. Caught here because the message
  // a script gives for it names neither the pool nor the discrepancy.
  const heldX = held(args.pool.assets, unitX);
  const heldY = held(args.pool.assets, unitY);
  if (takeX > heldX || takeY > heldY) {
    throw new Error(
      `Pool ${poolNft} holds ${heldX} ${unitX} and ${heldY} ${unitY}, and this withdrawal would take ` +
        `${takeX}/${takeY} out of it. The datum is claiming more than the UTXO carries.`,
    );
  }

  const nextDatum: VenuePoolConfigData = {
    ...cfg,
    treasury_x: cfg.treasury_x - takeX,
    treasury_y: cfg.treasury_y - takeY,
  };
  const nextAssets: Record<string, bigint> = { ...args.pool.assets };
  nextAssets[unitX] = heldX - takeX;
  nextAssets[unitY] = heldY - takeY;

  // `v_len` unchanged and every named balance still positive: the pool must
  // come out of this holding the same set of assets it went in with.
  for (const [unit, quantity] of Object.entries(nextAssets)) {
    if (quantity <= 0n) {
      throw new Error(
        `This withdrawal would leave pool ${poolNft} holding ${quantity} of ${unit}. An asset that leaves ` +
          "the pool's value entirely changes what the pool is, and the pool validator counts its assets.",
      );
    }
  }

  // `treasury.ak` requires the payout to reach `VerificationKey(treasury_address)`,
  // so that field has to be a payment key hash and nothing else. A datum
  // carrying anything else names an address that cannot be paid, and the
  // failure would otherwise surface as an address-encoding error naming no pool.
  if (!/^[0-9a-f]{56}$/.test(cfg.treasury_address)) {
    throw new Error(
      `Pool ${poolNft} names ${cfg.treasury_address} as its treasury address, which is not a 28-byte ` +
        'payment key hash. The treasury validator pays that credential and no other, so nothing can be ' +
        'collected from this pool until the datum names a real one.',
    );
  }

  const floor = args.payoutFloorLovelace ?? VENUE_TREASURY_PAYOUT_FLOOR_LOVELACE;
  const payoutAssets: Record<string, bigint> = {};
  if (takeX > 0n) payoutAssets[unitX] = takeX;
  if (takeY > 0n) payoutAssets[unitY] = takeY;
  // Whichever side is lovelace is a floor rather than an exact figure — and
  // when neither is, the payout still needs lovelace to exist, and none of it
  // came from the pool.
  const payoutLovelace = held(payoutAssets, 'lovelace');
  const topUpLovelace = payoutLovelace >= floor ? 0n : floor - payoutLovelace;
  if (topUpLovelace > 0n) payoutAssets.lovelace = payoutLovelace + topUpLovelace;

  return {
    pool: args.pool,
    takeX,
    takeY,
    nextDatum,
    nextDatumCbor: venuePoolDatumCbor(nextDatum),
    nextAssets,
    payoutAddress: credentialToAddress(
      LUCID_NETWORK[args.network],
      { type: 'Key', hash: cfg.treasury_address },
      args.payoutStakePkh ? { type: 'Key', hash: args.payoutStakePkh } : undefined,
    ),
    payoutAssets,
    topUpLovelace,
  };
}

export interface VenueTreasuryWithdrawerConfig {
  network: CurveNetwork;
  /** The pool validator, applied with its `royalty_withdraw_vh` parameter. */
  poolScript: VenueScriptSource;
  /** The treasury validator, applied with its authority, ceiling and pool hash. */
  treasuryScript: VenueScriptSource;
  provider: CurveSpendProvider;
  /**
   * The key `treasury.ak` was applied with, when that authority is a key.
   *
   * Declared as a REQUIRED SIGNER, which is what `extra_signatories` actually
   * reads — a transaction that is signed but never declares the key hands the
   * script an empty list and is refused for a reason naming nothing. Omitted
   * for a script authority, which authorises by its own withdrawal instead.
   */
  authorityKeyHash?: string;
  /** Budgets to declare instead of measuring. */
  executionUnits?: { mem: number; steps: number };
}

/** Lovelace and assets, in Mesh's shape. */
function toMesh(assets: Readonly<Record<string, bigint>>): Array<{ unit: string; quantity: string }> {
  return Object.entries(assets)
    .filter(([, quantity]) => quantity !== 0n)
    .map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
}

function lovelaceOf(utxo: MeshUTxO): bigint {
  return BigInt(utxo.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');
}

/**
 * Which of the platform's UTXOs fund the transaction, chosen rather than left
 * to coin selection.
 *
 * The choice is what makes the input positions predictable: two redeemers
 * index into the sorted input list, and a set the builder picks for itself is
 * a set this module cannot sort in advance. Pure-lovelace UTXOs come first so
 * a collection does not shuffle the platform's token holdings through change
 * for no reason, then the largest, so the fewest inputs meet the target.
 */
export function venueFundingUtxos(
  walletUtxos: readonly MeshUTxO[],
  targetLovelace: bigint,
  exclude: ReadonlySet<string> = new Set(),
): MeshUTxO[] {
  const candidates = walletUtxos
    .filter((utxo) => !exclude.has(`${utxo.input.txHash}#${utxo.input.outputIndex}`))
    .sort((a, b) => {
      const pureA = a.output.amount.length === 1;
      const pureB = b.output.amount.length === 1;
      if (pureA !== pureB) return pureA ? -1 : 1;
      const diff = lovelaceOf(b) - lovelaceOf(a);
      return diff === 0n ? 0 : diff > 0n ? 1 : -1;
    });

  const chosen: MeshUTxO[] = [];
  let total = 0n;
  for (const utxo of candidates) {
    if (total >= targetLovelace) break;
    chosen.push(utxo);
    total += lovelaceOf(utxo);
  }
  if (total < targetLovelace) {
    throw new Error(
      `The platform wallet offers ${total} lovelace across ${chosen.length} usable UTXOs, and this ` +
        `withdrawal needs ${targetLovelace} to fund itself. The pool cannot pay for it — both validators ` +
        "pin the pool's value to the counter movement exactly, so nothing may be skimmed for the fee.",
    );
  }
  return chosen;
}

/** Sorted position of one input among them all, by the ledger's own ordering. */
function sortedInputIndex(
  all: ReadonlyArray<{ txHash: string; outputIndex: number }>,
  target: { txHash: string; outputIndex: number },
): number {
  const ordered = [...all].sort((a, b) =>
    a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1,
  );
  return ordered.findIndex((i) => i.txHash === target.txHash && i.outputIndex === target.outputIndex);
}

/**
 * Holds the finished transaction to the positions the two redeemers name.
 *
 * The failure this catches has no other signal: a transaction whose inputs
 * came out in another order still decodes, still evaluates, and hands each
 * script the wrong input — so it is refused at the node for a reason that
 * names neither.
 */
function assertPositions(
  unsignedTxHex: string,
  pool: { txHash: string; outputIndex: number },
  poolInIx: number,
  treasuryOutIx: number,
  payoutAddress: string,
): void {
  const body = deserializeTx(unsignedTxHex).body();
  const inputs = body.inputs().toCore();
  const got = inputs[poolInIx];
  const gotHash = String(got?.txId ?? '');
  const gotIndex = Number(got?.index ?? -1);
  if (gotHash !== pool.txHash || gotIndex !== pool.outputIndex) {
    throw new Error(
      `Both redeemers name input ${poolInIx} as the pool (${pool.txHash}#${pool.outputIndex}), but the ` +
        `built transaction has ${gotHash}#${gotIndex} there. Inputs were sorted by a rule this builder no ` +
        'longer predicts, so every position in this transaction points at the wrong input.',
    );
  }
  const outputs = body.outputs();
  const payout = outputs[treasuryOutIx];
  const payoutAt = payout?.address()?.toBech32?.();
  if (payoutAt !== payoutAddress) {
    throw new Error(
      `The redeemer names output ${treasuryOutIx} as the platform's payout (${payoutAddress}), but the ` +
        `built transaction has ${payoutAt ?? 'nothing'} there. Outputs are not sorted, so this means the ` +
        'builder placed or appended one that this module did not account for.',
    );
  }
}

/** Builds and submits the platform's collection, one pool at a time. */
export class VenueTreasuryWithdrawer {
  private readonly poolRef?: ResolvedReferenceScript;
  private readonly treasuryRef?: ResolvedReferenceScript;

  constructor(private readonly config: VenueTreasuryWithdrawerConfig) {
    const networkId = MESH_NETWORK_ID[config.network];
    if ('referenceScript' in config.poolScript) {
      this.poolRef = resolveReferenceScript(
        config.poolScript.compiledScriptCbor,
        config.poolScript.referenceScript,
        networkId,
      );
    }
    if ('referenceScript' in config.treasuryScript) {
      this.treasuryRef = resolveReferenceScript(
        config.treasuryScript.compiledScriptCbor,
        config.treasuryScript.referenceScript,
        networkId,
      );
    }
  }

  /**
   * The treasury validator's own hash, whichever way the transaction reaches
   * it — a reference and an embedded copy of the same applied script are the
   * same script, and a withdrawal at anything else runs nothing.
   */
  treasuryHash(): string {
    return (
      this.treasuryRef?.scriptHash ??
      ('embeddedScriptCbor' in this.config.treasuryScript
        ? scriptHashOf(this.config.treasuryScript.embeddedScriptCbor)
        : /* c8 ignore next -- unreachable: a source is one shape or the other. */ '')
    );
  }

  /** The stake address the treasury script's authorising withdrawal sits at. */
  rewardAddress(): string {
    return credentialToRewardAddress(LUCID_NETWORK[this.config.network], {
      type: 'Script',
      hash: this.treasuryHash(),
    });
  }

  /**
   * Builds the withdrawal. Returns the unsigned transaction, CBOR hex.
   *
   * The pool is spent under action 3, and the transaction carries a
   * zero-lovelace withdrawal at the treasury script — which is the whole point
   * of a withdrawal at a script credential: it runs the script, so its
   * presence is evidence the script approved.
   *
   * `fundingUtxos` overrides which of the wallet's UTXOs pay for it. A caller
   * collecting from several pools at once has to say, because each collection
   * would otherwise select from the same wallet snapshot and the second would
   * name a UTXO the first had already spent. Given, these are used exactly —
   * they are still checked against what the transaction needs, and the
   * collateral is still held out of them.
   */
  async build(
    plan: VenueTreasuryWithdrawalPlan,
    wallet: CurveSpendWallet,
    opts: { fundingUtxos?: readonly MeshUTxO[] } = {},
  ): Promise<string> {
    if (this.poolRef && plan.pool.address !== this.poolRef.scriptAddress) {
      throw new Error(
        `The pool UTXO sits at ${plan.pool.address}, but this withdrawer references a pool validator whose ` +
          `address is ${this.poolRef.scriptAddress}. Spending it would need the validator that locks it.`,
      );
    }

    // The pool defers to the credential its OWN datum names, and this builder
    // withdraws at the script it was configured with. A mismatch builds a
    // transaction that is well formed, runs both scripts, and is refused
    // because the pool never saw the withdrawal it required — naming neither.
    const named = venueTreasuryCredentialOf(plan.pool.datum);
    const configured = this.treasuryHash();
    if (named !== configured) {
      throw new Error(
        `Pool ${venueUnitOf(plan.pool.datum.pool_nft)} defers its treasury action to ` +
          `${named ?? 'no script credential at all'}, and this withdrawer holds the treasury validator ` +
          `${configured}. The pool requires a withdrawal at the credential its own datum names.`,
      );
    }

    const [changeAddress, collateral, walletUtxos] = await Promise.all([
      wallet.getChangeAddress(),
      wallet.getCollateral(),
      opts.fundingUtxos ?? wallet.getUtxos(),
    ]);
    const collateralUtxo: MeshUTxO | undefined = collateral[0];
    if (!collateralUtxo) {
      throw new Error(
        'The platform wallet has no collateral UTXO. A Plutus spend needs one — a pure-ada UTXO the wallet ' +
          'sets aside, which most wallets create on request.',
      );
    }

    // Collateral is not an input in the ledger's sense, but it is the same
    // UTXO — offering it to the funding selection as well would build a
    // transaction that spends it twice.
    const funding = venueFundingUtxos(
      walletUtxos,
      plan.topUpLovelace + VENUE_TREASURY_FUNDING_HEADROOM_LOVELACE,
      new Set([`${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`]),
    );

    const allInputs = [
      { txHash: plan.pool.txHash, outputIndex: plan.pool.outputIndex },
      ...funding.map((utxo) => ({ txHash: utxo.input.txHash, outputIndex: utxo.input.outputIndex })),
    ];
    const poolInIx = sortedInputIndex(allInputs, plan.pool);
    // The payout is the second output this builder places, and outputs are
    // never sorted — change is appended after them.
    const treasuryOutIx = 1;

    const tx = new MeshTxBuilder({
      fetcher: this.config.provider as never,
      submitter: this.config.provider as never,
      ...(this.config.executionUnits ? {} : { evaluator: this.config.provider as never }),
      verbose: false,
    });

    tx.spendingPlutusScriptV3().txIn(
      plan.pool.txHash,
      plan.pool.outputIndex,
      toMesh(plan.pool.assets),
      plan.pool.address,
      0,
    );
    if (this.poolRef) {
      tx.spendingTxInReference(
        this.poolRef.txHash,
        this.poolRef.outputIndex,
        String(this.poolRef.rawSizeBytes),
        this.poolRef.scriptHash,
      );
    } else if ('embeddedScriptCbor' in this.config.poolScript) {
      tx.txInScript(applyCborEncoding(this.config.poolScript.embeddedScriptCbor));
    }
    tx.txInInlineDatumPresent().txInRedeemerValue(
      venuePoolRedeemer(VENUE_POOL_ACTION.DAOAction, poolInIx),
      'CBOR',
      this.config.executionUnits ?? VENUE_TREASURY_POOL_EXECUTION_UNITS,
    );

    for (const utxo of funding) {
      // The trailing zero is the input's reference-script size, and it is not
      // optional: a `txIn` without one is INCOMPLETE to the builder, which
      // then goes to the provider to look the UTXO up rather than using what
      // it was handed.
      tx.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address, 0);
    }

    tx.txOut(plan.pool.address, toMesh(plan.nextAssets)).txOutInlineDatumValue(plan.nextDatumCbor, 'CBOR');
    tx.txOut(plan.payoutAddress, toMesh(plan.payoutAssets));

    tx.withdrawalPlutusScriptV3().withdrawal(this.rewardAddress(), '0');
    if (this.treasuryRef) {
      tx.withdrawalTxInReference(
        this.treasuryRef.txHash,
        this.treasuryRef.outputIndex,
        String(this.treasuryRef.rawSizeBytes),
        this.treasuryRef.scriptHash,
      );
    } else if ('embeddedScriptCbor' in this.config.treasuryScript) {
      tx.withdrawalScript(applyCborEncoding(this.config.treasuryScript.embeddedScriptCbor));
    }
    tx.withdrawalRedeemerValue(
      venueTreasuryWithdrawRedeemer(poolInIx, treasuryOutIx),
      'CBOR',
      this.config.executionUnits ?? VENUE_TREASURY_WITHDRAW_EXECUTION_UNITS,
    );

    if (this.config.authorityKeyHash) tx.requiredSignerHash(this.config.authorityKeyHash);

    tx.txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex,
      collateralUtxo.output.amount,
      collateralUtxo.output.address,
    )
      // Deliberately empty: the funding above was chosen so the input
      // positions the two redeemers name are known before the sort.
      .selectUtxosFrom([])
      .changeAddress(changeAddress)
      .setNetwork(this.config.network);

    const unsigned = await tx.complete();
    assertPositions(unsigned, plan.pool, poolInIx, treasuryOutIx, plan.payoutAddress);
    return unsigned;
  }

  /** Builds, signs and submits. Returns the transaction hash. */
  async submit(
    plan: VenueTreasuryWithdrawalPlan,
    wallet: CurveSpendWallet,
    opts: { fundingUtxos?: readonly MeshUTxO[] } = {},
  ): Promise<string> {
    const unsigned = await this.build(plan, wallet, opts);
    return wallet.submitTx(await wallet.signTx(unsigned));
  }
}
