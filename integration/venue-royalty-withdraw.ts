// ============================================================================
// Noctis Zone — NoctisSwap: the creator withdrawing their pool royalty
// ============================================================================
// A creator's 1.0% of every trade accrues in two counters in the pool's own
// datum, `royalty_x` (ADA) and `royalty_y` (the launch token). Taking it out
// is a request, like a swap: the creator signs what they are taking, pays a
// request UTXO to `withdraw_order`, and an executor spends it together with
// the pool.
//
// Three scripts decide the fill, and none of them alone:
//
//   - `pool.ak` action 4 spends the pool and requires a withdrawal at the
//     royalty-withdraw script.
//   - `single_royalty_withdraw_pool.ak`, run by that withdrawal, checks the
//     creator's signature over the amounts and the pool's current nonce, moves
//     the counters and the reserves by exactly those amounts, and bumps the
//     nonce, so one signature pays once.
//   - `withdraw_order.ak` pays the reward to the key the pool's own
//     `royalty_pub_key` hashes to, and leaves the executor exactly `ex_fee`.
//
// **What the creator signs is not a transaction.** The withdraw script checks
//
//     ed25519(royalty_pub_key, additional_bytes ++ payload)
//
// where `payload` is `WithdrawRoyaltyDataToSign { withdraw_data, pool_nonce }`
// as CBOR. That is the shape a CIP-30 wallet's `signData` produces: the wallet
// signs a COSE `Sig_structure` that ends with the payload, so everything before
// it is `additional_bytes`. `venueSignatureFromCip30` takes the wallet's answer
// apart, rebuilds that structure, and checks the signature itself before the
// request is placed, so a request that could never be filled is never paid for.
//
// **`ex_fee` is exact.** Unlike a swap's fee, which is a ceiling a settled
// build charges less of, the request validator requires the executor to take
// `ex_fee` to the lovelace, and the signature covers it. So it is set once, at
// signing, and has to cover the network fee and the least output an executor
// can be paid.
//
// **Where the royalty lands.** The payout must go to the creator's payment key
// with no staking part, or staked to that same key. A wallet's usual address
// has a separate stake key, so the royalty arrives at the key's address without
// one. The creator holds it; some wallets list that address separately.
// ============================================================================

import { Constr, Data, type Network as LucidNetwork } from '@lucid-evolution/lucid';
import { Crypto, Ed25519PublicKey, Ed25519Signature, HexBlob, Serialization } from '@meshsdk/core-cst';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { venueKeyAddress } from './venue-liquidity.js';
import { VenueAssetShape, type VenuePoolConfigData, VenuePoolConfigSchema } from './venue-pool.js';
import type { VenueOrderPosition, VenuePoolUtxo } from './venue-swap.js';
import { venueUnitOf } from './venue-swap.js';

/** The blueprint titles of the request validator and the withdraw script. */
export const VENUE_WITHDRAW_ORDER_TITLE = 'royalty_pool/withdraw_order.withdraw_order.spend';
export const VENUE_ROYALTY_WITHDRAW_TITLE = 'royalty_pool/single_royalty_withdraw_pool.royalty_withdraw_pool.withdraw';

/** `splash/orders/royalty_withdraw/WithdrawData`. */
export const VenueWithdrawDataShape = Data.Object({
  pool_nft: VenueAssetShape,
  withdraw_royalty_x: Data.Integer(),
  withdraw_royalty_y: Data.Integer(),
  ex_fee: Data.Integer(),
});
export type VenueWithdrawData = Data.Static<typeof VenueWithdrawDataShape>;

/** `WithdrawRoyaltyDataToSign` — what the creator's signature covers. */
export const VenueWithdrawToSignShape = Data.Object({
  withdraw_data: VenueWithdrawDataShape,
  pool_nonce: Data.Integer(),
});
export type VenueWithdrawToSign = Data.Static<typeof VenueWithdrawToSignShape>;
export const VenueWithdrawToSignSchema = VenueWithdrawToSignShape as unknown as VenueWithdrawToSign;

/** `RoyaltyWithdrawConfig` — the request's datum. */
export const VenueRoyaltyWithdrawConfigShape = Data.Object({
  withdraw_data: VenueWithdrawDataShape,
  signature: Data.Bytes(),
  additional_bytes: Data.Bytes(),
  /** Who placed the request and may take it back. */
  owner: Data.Bytes(),
});
export type VenueRoyaltyWithdrawConfigData = Data.Static<typeof VenueRoyaltyWithdrawConfigShape>;
export const VenueRoyaltyWithdrawConfigSchema =
  VenueRoyaltyWithdrawConfigShape as unknown as VenueRoyaltyWithdrawConfigData;

/**
 * What a withdraw request pays its executor, exactly: **2 ADA**.
 *
 * A fill carries the request validator and the withdraw script (4.7 KB
 * together) and names the pool validator, so it runs three scripts, and its
 * executor is paid in an output that has to clear the ledger's minimum. A swap's
 * 1.5 ADA ceiling is priced for one order script and is settled down to cost;
 * this one cannot be, so it keeps a margin instead of hoping.
 */
export const VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE = 2_000_000n;

/**
 * ADA a request sets aside so the reward output can exist, returned in full.
 *
 * A royalty taken in the launch token alone would otherwise be an output
 * holding tokens and no ADA, which the ledger refuses.
 */
export const VENUE_ROYALTY_REWARD_FLOOR_LOVELACE = 2_000_000n;

/** A withdraw request as the executor holds one. */
export interface VenueWithdrawOrderUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Record<string, bigint>;
  datum: VenueRoyaltyWithdrawConfigData;
  placedAt?: VenueOrderPosition;
}

/** The key hash `royalty_pub_key` pays: blake2b-224 of the public key. */
export function venueRoyaltyKeyHash(royaltyPubKeyHex: string): string {
  return bytesToHex(blake2b(hexToBytes(royaltyPubKeyHex), { dkLen: 28 }));
}

/** Where a pool's royalty is paid: its key, with no staking part. */
export function venueRoyaltyPayoutAddress(pool: VenuePoolUtxo, network: LucidNetwork): string {
  return venueKeyAddress(venueRoyaltyKeyHash(pool.datum.royalty_pub_key), null, network);
}

/** What the pool owes its creator now, ADA side and token side. */
export function venueRoyaltyOwed(pool: VenuePoolUtxo): { x: bigint; y: bigint } {
  return { x: pool.datum.royalty_x, y: pool.datum.royalty_y };
}

/** The bytes the creator signs, CBOR hex. */
export function venueRoyaltyWithdrawPayload(withdrawData: VenueWithdrawData, poolNonce: bigint): string {
  return Data.to({ withdraw_data: withdrawData, pool_nonce: poolNonce }, VenueWithdrawToSignSchema);
}

/** A request ready to sign: what it takes, the payload, and what it carries. */
export interface VenueRoyaltyWithdrawDraft {
  withdrawData: VenueWithdrawData;
  /** CBOR hex of what the creator signs. */
  payloadHex: string;
  /** The pool's nonce the signature is bound to. A fill must meet the pool at this nonce. */
  poolNonce: bigint;
  /** Lovelace the request carries: the executor's fee and the reward floor. */
  requestLovelace: bigint;
  /** Where the royalty will be paid. */
  payoutAddress: string;
}

function requireAdaPool(pool: VenuePoolUtxo): void {
  if (venueUnitOf(pool.datum.pool_x) !== 'lovelace') {
    throw new Error(
      `This pool's first asset is ${venueUnitOf(pool.datum.pool_x)}, not ADA. Every NoctisSwap pool pairs ADA ` +
        'with a launch token, and the withdraw planners do not handle any other shape.',
    );
  }
}

/**
 * A request for some or all of a pool's royalty, ready to sign.
 *
 * Takes everything owed unless told otherwise.
 */
export function draftVenueRoyaltyWithdraw(args: {
  pool: VenuePoolUtxo;
  network: LucidNetwork;
  takeX?: bigint;
  takeY?: bigint;
  exFee?: bigint;
  rewardFloor?: bigint;
}): VenueRoyaltyWithdrawDraft {
  const { pool } = args;
  requireAdaPool(pool);
  const owed = venueRoyaltyOwed(pool);
  const takeX = args.takeX ?? owed.x;
  const takeY = args.takeY ?? owed.y;
  if (takeX < 0n || takeY < 0n) {
    throw new Error(`A withdrawal takes a non-negative amount from each side; this one takes ${takeX}/${takeY}.`);
  }
  if (takeX > owed.x || takeY > owed.y) {
    throw new Error(
      `The pool owes ${owed.x} lovelace and ${owed.y} tokens; this withdrawal asks for ${takeX} and ${takeY}.`,
    );
  }
  if (takeX === 0n && takeY === 0n) {
    throw new Error('This pool owes no royalty right now, so there is nothing to withdraw.');
  }
  const exFee = args.exFee ?? VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE;
  const withdrawData: VenueWithdrawData = {
    pool_nft: pool.datum.pool_nft,
    withdraw_royalty_x: takeX,
    withdraw_royalty_y: takeY,
    ex_fee: exFee,
  };
  return {
    withdrawData,
    payloadHex: venueRoyaltyWithdrawPayload(withdrawData, pool.datum.nonce),
    poolNonce: pool.datum.nonce,
    requestLovelace: exFee + (args.rewardFloor ?? VENUE_ROYALTY_REWARD_FLOOR_LOVELACE),
    payoutAddress: venueRoyaltyPayoutAddress(pool, args.network),
  };
}

/** A CIP-30 `signData` answer: a COSE_Sign1 and a COSE_Key, both CBOR hex. */
export interface Cip30SignedData {
  signature: string;
  key: string;
}

/** The signature as the withdraw script checks it. */
export interface VenueRoyaltySignature {
  signatureHex: string;
  /** Everything the wallet signed before the payload. */
  additionalBytesHex: string;
  /** The key that signed, from the wallet's COSE_Key. */
  publicKeyHex: string;
  /** The wallet signed blake2b-224 of the payload rather than the payload. */
  hashed: boolean;
}

/** COSE_Sign1 is sometimes wrapped in tag 18. */
const COSE_SIGN1_TAG = 18;
/** COSE_Key label for an OKP key's public bytes. */
const COSE_KEY_X = -2;

function readCoseSign1(hex: string): {
  protectedBytes: Uint8Array;
  hashed: boolean;
  payload: Uint8Array | null;
  signature: Uint8Array;
} {
  const { CborReader, CborReaderState } = Serialization;
  const reader = new CborReader(HexBlob(hex));
  if (reader.peekState() === CborReaderState.Tag) {
    const tag = Number(reader.readTag());
    if (tag !== COSE_SIGN1_TAG) throw new Error(`The wallet's signature is tagged ${tag}, not COSE_Sign1.`);
  }
  if (reader.readStartArray() !== 4) throw new Error('The wallet returned a signature that is not a COSE_Sign1.');
  const protectedBytes = reader.readByteString();
  let hashed = false;
  const entries = reader.readStartMap();
  for (let i = 0; entries === null || i < entries; i += 1) {
    if (entries === null && reader.peekState() === CborReaderState.EndMap) break;
    const labelIsText = reader.peekState() === CborReaderState.TextString;
    const label = labelIsText ? reader.readTextString() : String(reader.readInt());
    if (label === 'hashed' && reader.peekState() === CborReaderState.Boolean) hashed = reader.readBoolean();
    else reader.skipValue();
  }
  reader.readEndMap();
  const payload = reader.peekState() === CborReaderState.Null ? (reader.readNull(), null) : reader.readByteString();
  const signature = reader.readByteString();
  return { protectedBytes, hashed, payload, signature };
}

function readCoseKeyX(hex: string): Uint8Array {
  const { CborReader, CborReaderState } = Serialization;
  const reader = new CborReader(HexBlob(hex));
  const entries = reader.readStartMap();
  for (let i = 0; entries === null || i < entries; i += 1) {
    if (entries === null && reader.peekState() === CborReaderState.EndMap) break;
    const state = reader.peekState();
    const label =
      state === CborReaderState.UnsignedInteger || state === CborReaderState.NegativeInteger
        ? Number(reader.readInt())
        : (reader.skipValue(), Number.NaN);
    if (label === COSE_KEY_X) return reader.readByteString();
    reader.skipValue();
  }
  throw new Error('The wallet returned a key with no public key in it.');
}

/**
 * Takes a CIP-30 `signData` answer apart into what the withdraw script checks,
 * and checks it.
 *
 * The wallet signed COSE's `Sig_structure`:
 *
 *     ["Signature1", protected, h'', payload]
 *
 * The payload is its last element, so the structure's encoding ends with the
 * payload's bytes, and whatever precedes them is `additional_bytes`. It is
 * rebuilt here rather than trusted, and the signature is verified against it,
 * so a wallet that signed something else fails here and not at the pool.
 */
export async function venueSignatureFromCip30(
  signed: Cip30SignedData,
  payloadHex: string,
): Promise<VenueRoyaltySignature> {
  const cose = readCoseSign1(signed.signature);
  const payload = hexToBytes(payloadHex);
  const signedPayload = cose.hashed ? blake2b(payload, { dkLen: 28 }) : payload;
  if (cose.payload !== null && bytesToHex(cose.payload) !== bytesToHex(signedPayload)) {
    throw new Error('The wallet signed a different message from the one it was given. Nothing was placed.');
  }
  const writer = new Serialization.CborWriter();
  writer.writeStartArray(4);
  writer.writeTextString('Signature1');
  writer.writeByteString(cose.protectedBytes);
  writer.writeByteString(new Uint8Array());
  writer.writeByteString(signedPayload);
  const message = writer.encode();
  const prefix = message.slice(0, message.length - signedPayload.length);
  const publicKey = readCoseKeyX(signed.key);

  await Crypto.ready();
  const ok = Ed25519PublicKey.fromBytes(publicKey).verify(
    Ed25519Signature.fromBytes(cose.signature),
    HexBlob(bytesToHex(message)),
  );
  if (!ok) {
    throw new Error("The wallet's signature does not verify against the key it names. Nothing was placed.");
  }
  return {
    signatureHex: bytesToHex(cose.signature),
    additionalBytesHex: bytesToHex(prefix),
    publicKeyHex: bytesToHex(publicKey),
    hashed: cose.hashed,
  };
}

/** The request's datum, from a draft and the checked signature. */
export function venueRoyaltyWithdrawDatum(
  draft: Pick<VenueRoyaltyWithdrawDraft, 'withdrawData'>,
  signature: Pick<VenueRoyaltySignature, 'signatureHex' | 'additionalBytesHex'>,
  ownerKeyHash: string,
): VenueRoyaltyWithdrawConfigData {
  return {
    withdraw_data: draft.withdrawData,
    signature: signature.signatureHex,
    additional_bytes: signature.additionalBytesHex,
    owner: ownerKeyHash,
  };
}

/** `RoyaltyWithdrawRedeemer { pool_in_ix, order_in_ix, hash }`. */
export function venueRoyaltyWithdrawRedeemer(poolInIx: number, orderInIx: number, hash: boolean): string {
  return Data.to(new Constr(0, [BigInt(poolInIx), BigInt(orderInIx), new Constr(hash ? 1 : 0, [])]));
}

/**
 * Whether the request's signature is good for this pool as it stands, and in
 * which of the two forms the withdraw script accepts.
 *
 * The signature is bound to the pool's nonce, and every withdrawal bumps it,
 * so a request signed before another withdrawal landed can never be filled.
 */
export async function venueWithdrawSignatureForm(
  pool: VenuePoolUtxo,
  request: Pick<VenueWithdrawOrderUtxo, 'datum'>,
): Promise<{ hashed: boolean }> {
  const cfg = request.datum;
  const payload = hexToBytes(venueRoyaltyWithdrawPayload(cfg.withdraw_data, pool.datum.nonce));
  const prefix = hexToBytes(cfg.additional_bytes);
  await Crypto.ready();
  const key = Ed25519PublicKey.fromHex(pool.datum.royalty_pub_key as never);
  const signature = Ed25519Signature.fromHex(cfg.signature as never);
  for (const hashed of [false, true]) {
    const body = hashed ? blake2b(payload, { dkLen: 28 }) : payload;
    const message = new Uint8Array(prefix.length + body.length);
    message.set(prefix);
    message.set(body, prefix.length);
    if (key.verify(signature, HexBlob(bytesToHex(message)))) return { hashed };
  }
  throw new Error(
    `This request's signature does not verify against pool ${venueUnitOf(pool.datum.pool_nft)} at nonce ` +
      `${pool.datum.nonce}. It was signed for another pool, by another key, or before a withdrawal that has ` +
      'since landed, and can only be refunded by its placer.',
  );
}

/** One withdraw fill, laid out. */
export interface VenueRoyaltyWithdrawFill {
  /** The pool's successor value. */
  poolAssets: Record<string, bigint>;
  /** Its datum, counters lowered and nonce bumped, CBOR hex. */
  nextDatumCbor: string;
  nextDatum: VenuePoolConfigData;
  /** The creator's payout. */
  reward: { address: string; assets: Record<string, bigint> };
  /** Which form the signature takes, for the withdraw script's redeemer. */
  hashed: boolean;
  /** What the executor keeps: the whole of `ex_fee`, network fee included. */
  exFee: bigint;
}

function pruneZero(assets: Record<string, bigint>): Record<string, bigint> {
  return Object.fromEntries(Object.entries(assets).filter(([, q]) => q !== 0n));
}

/**
 * Lays out a withdraw fill and checks it against all three scripts' rules.
 *
 * Refuses, with the reason, a request no executor could fill: the wrong pool,
 * anything but ADA in it, more than is owed, a signature that no longer
 * verifies, or too little ADA for its fee and its reward.
 */
export async function planVenueRoyaltyWithdrawFill(args: {
  pool: VenuePoolUtxo;
  request: VenueWithdrawOrderUtxo;
  network: LucidNetwork;
  minOutputLovelace: bigint;
}): Promise<VenueRoyaltyWithdrawFill> {
  const { pool, request } = args;
  requireAdaPool(pool);
  const cfg = pool.datum;
  const wd = request.datum.withdraw_data;
  if (venueUnitOf(wd.pool_nft) !== venueUnitOf(cfg.pool_nft)) {
    throw new Error(
      `This request names pool NFT ${venueUnitOf(wd.pool_nft)} and this pool carries ${venueUnitOf(cfg.pool_nft)}.`,
    );
  }
  const stray = Object.entries(request.assets).find(([unit, q]) => q !== 0n && unit !== 'lovelace');
  if (stray) {
    throw new Error(
      `This request also holds ${stray[1]} of ${stray[0]}. A withdraw request carries ADA and nothing else, so ` +
        'it can only be refunded.',
    );
  }
  if (wd.withdraw_royalty_x < 0n || wd.withdraw_royalty_y < 0n) {
    throw new Error('This request takes a negative amount, which the withdraw script refuses.');
  }
  if (wd.withdraw_royalty_x > cfg.royalty_x || wd.withdraw_royalty_y > cfg.royalty_y) {
    throw new Error(
      `This request takes ${wd.withdraw_royalty_x}/${wd.withdraw_royalty_y} and the pool owes ` +
        `${cfg.royalty_x}/${cfg.royalty_y}.`,
    );
  }
  const { hashed } = await venueWithdrawSignatureForm(pool, request);

  const requestLovelace = request.assets.lovelace ?? 0n;
  const setAside = requestLovelace - wd.ex_fee;
  if (setAside < 0n) {
    throw new Error(`This request holds ${requestLovelace} lovelace against a fee of ${wd.ex_fee}.`);
  }
  const xUnit = venueUnitOf(cfg.pool_x);
  const yUnit = venueUnitOf(cfg.pool_y);
  const rewardLovelace = wd.withdraw_royalty_x + setAside;
  if (rewardLovelace < args.minOutputLovelace) {
    throw new Error(
      `The payout would carry ${rewardLovelace} lovelace, under the ${args.minOutputLovelace} an output must hold. ` +
        'The request set too little aside; it can only be refunded.',
    );
  }

  const poolAssets = { ...pool.assets };
  poolAssets[xUnit] = (poolAssets[xUnit] ?? 0n) - wd.withdraw_royalty_x;
  poolAssets[yUnit] = (poolAssets[yUnit] ?? 0n) - wd.withdraw_royalty_y;
  const nextDatum: VenuePoolConfigData = {
    ...cfg,
    royalty_x: cfg.royalty_x - wd.withdraw_royalty_x,
    royalty_y: cfg.royalty_y - wd.withdraw_royalty_y,
    nonce: cfg.nonce + 1n,
  };
  return {
    poolAssets: pruneZero(poolAssets),
    nextDatum,
    nextDatumCbor: Data.to(nextDatum, VenuePoolConfigSchema),
    reward: {
      address: venueRoyaltyPayoutAddress(pool, args.network),
      assets: pruneZero({ lovelace: rewardLovelace, [yUnit]: wd.withdraw_royalty_y }),
    },
    hashed,
    exFee: wd.ex_fee,
  };
}
