// ============================================================================
// Noctis Zone — NoctisSwap: the royalty withdraw request's on-chain shapes
// ============================================================================
// The request's datum and the payload the creator signs, as the validators read
// them, and the titles both scripts are published under. They live apart from
// venue-royalty-withdraw.ts because reading a request off the chain needs only
// these, while drafting and checking one needs Mesh's signature types: the
// venue's browser panel reads requests, and keeps Mesh out of its bundle by
// importing from here.
// ============================================================================

import { Data } from '@lucid-evolution/lucid';
import { VenueAssetShape } from './venue-pool.js';
import type { VenueOrderPosition } from './venue-swap.js';

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

/** A withdraw request as the executor holds one. */
export interface VenueWithdrawOrderUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Record<string, bigint>;
  datum: VenueRoyaltyWithdrawConfigData;
  placedAt?: VenueOrderPosition;
}
