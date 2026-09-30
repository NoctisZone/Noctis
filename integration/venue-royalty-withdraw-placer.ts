// ============================================================================
// Noctis Zone — NoctisSwap: a creator placing a royalty-withdraw request
// ============================================================================
// The browser half of `venue-royalty-withdraw.ts`. The creator's connected
// wallet does two things: it signs the request's payload with `signData`, and
// it signs the ordinary payment that places the request at `withdraw_order`.
// An executor fills it from there.
//
// **The wallet has to be the one the pool pays.** The withdraw script checks
// the signature against the pool's `royalty_pub_key`, so a request signed by
// any other key can never fill. The signature is taken apart and checked here,
// against the pool as read, before any ADA moves.
//
// **The payment never spends a reference script.** A creator's wallet may hold
// the outputs that publish the platform's validators, and a browser wallet
// choosing its own inputs can spend one. Placement is built here, from the
// wallet's outputs with those set aside (`spendableForFees`), and the wallet is
// only asked to sign.
// ============================================================================

import { Data, getAddressDetails, type Network as LucidNetwork } from '@lucid-evolution/lucid';
import { MeshTxBuilder } from '@meshsdk/core';
import { type Cip30Api, Cip30CurveSpendWallet } from './cip30-curve-spend-wallet.js';
import { type CurveNetwork, type CurveSpendProvider, spendableForFees } from './mesh-curve-spend.js';
import { VenuePoolConfigSchema } from './venue-pool.js';
import {
  type Cip30SignedData,
  draftVenueRoyaltyWithdraw,
  VenueRoyaltyWithdrawConfigSchema,
  type VenueRoyaltyWithdrawDraft,
  venueRoyaltyWithdrawDatum,
  venueSignatureFromCip30,
} from './venue-royalty-withdraw.js';
import { type VenuePoolUtxo, venueUnitOf } from './venue-swap.js';

/** A CIP-30 wallet that can also sign data. */
export interface Cip30SigningApi extends Cip30Api {
  signData(address: string, payload: string): Promise<Cip30SignedData>;
}

const LUCID_NETWORK: Record<CurveNetwork, LucidNetwork> = {
  preview: 'Preview',
  preprod: 'Preprod',
  mainnet: 'Mainnet',
};

/**
 * One pool, read by its NFT through a Blockfrost-shaped GET.
 *
 * `get` takes a Blockfrost path and returns its JSON; in the browser it goes
 * through the site's proxy. The NFT names exactly one output at the pool
 * address, and that output's datum has to name the same NFT, or it is not the
 * pool.
 */
export async function readVenuePoolByNft(
  get: (path: string) => Promise<unknown>,
  poolAddress: string,
  poolNft: string,
): Promise<VenuePoolUtxo> {
  const found = (await get(`addresses/${poolAddress}/utxos/${poolNft}`)) as Array<{
    tx_hash: string;
    output_index: number;
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    inline_datum: string | null;
  }>;
  if (!Array.isArray(found) || found.length !== 1 || !found[0]) {
    throw new Error(
      `The pool holding ${poolNft} could not be found at the pool address. It may be mid-trade; try again shortly.`,
    );
  }
  const utxo = found[0];
  if (!utxo.inline_datum) throw new Error('The pool output carries no inline datum, so it is not a pool.');
  const datum = Data.from(utxo.inline_datum, VenuePoolConfigSchema);
  if (venueUnitOf(datum.pool_nft) !== poolNft) {
    throw new Error(`The output holding ${poolNft} names a different pool in its datum, so it is not that pool.`);
  }
  const assets: Record<string, bigint> = {};
  for (const { unit, quantity } of utxo.amount) assets[unit] = (assets[unit] ?? 0n) + BigInt(quantity);
  return { txHash: utxo.tx_hash, outputIndex: utxo.output_index, address: utxo.address, assets, datum };
}

/** What a placed request takes, and where it will be paid. */
export interface VenueRoyaltyWithdrawPlaced {
  txHash: string;
  draft: VenueRoyaltyWithdrawDraft;
}

/**
 * Signs and places a request for everything the pool owes, unless told to
 * take less.
 */
export async function placeVenueRoyaltyWithdraw(args: {
  api: Cip30SigningApi;
  pool: VenuePoolUtxo;
  network: CurveNetwork;
  /** `withdraw_order`'s address. */
  requestAddress: string;
  provider: CurveSpendProvider;
  takeX?: bigint;
  takeY?: bigint;
}): Promise<VenueRoyaltyWithdrawPlaced> {
  const { api, pool } = args;
  const draft = draftVenueRoyaltyWithdraw({
    pool,
    network: LUCID_NETWORK[args.network],
    ...(args.takeX !== undefined ? { takeX: args.takeX } : {}),
    ...(args.takeY !== undefined ? { takeY: args.takeY } : {}),
  });

  const wallet = new Cip30CurveSpendWallet(api);
  const changeAddress = await wallet.getChangeAddress();
  const owner = getAddressDetails(changeAddress).paymentCredential;
  if (owner?.type !== 'Key') {
    throw new Error('This wallet’s address has no payment key, so it cannot own a request it could later refund.');
  }

  const signature = await venueSignatureFromCip30(
    await api.signData(await api.getChangeAddress(), draft.payloadHex),
    draft.payloadHex,
  );
  if (signature.publicKeyHex !== pool.datum.royalty_pub_key) {
    throw new Error(
      'This wallet signed with a key the pool does not pay. Connect the wallet that created this launch; its ' +
        'royalty is paid to that key and to no other. Nothing was placed.',
    );
  }

  const datumCbor = Data.to(venueRoyaltyWithdrawDatum(draft, signature, owner.hash), VenueRoyaltyWithdrawConfigSchema);
  const tx = new MeshTxBuilder({ fetcher: args.provider as never, verbose: false });
  tx.txOut(args.requestAddress, [{ unit: 'lovelace', quantity: draft.requestLovelace.toString() }])
    .txOutInlineDatumValue(datumCbor, 'CBOR')
    .changeAddress(changeAddress)
    .selectUtxosFrom(spendableForFees(await wallet.getUtxos()))
    .setNetwork(args.network);
  const unsigned = await tx.complete();
  const txHash = await wallet.submitTx(await wallet.signTx(unsigned));
  return { txHash, draft };
}
