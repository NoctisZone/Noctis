// ============================================================================
// Noctis Zone — NoctisSwap: taking a royalty-withdraw request back
// ============================================================================
// `withdraw_order.ak`'s refund arm is one line:
//
//   Refund -> list.has(self.extra_signatories, cfg.owner)
//
// The placer's key and nothing else: no deadline, no executor, no pool. A
// request an executor will never fill — signed before another withdraw moved
// the pool's nonce, asking for more than the pool now owes, placed where no
// executor serves its pool, or simply not filled yet — comes back to its
// placer whenever they ask.
//
// **`extra_signatories` is the REQUIRED SIGNERS field**, so the placer's key
// is declared in the body, not only signed with: a signature alone leaves the
// list empty and the script refuses, for a reason that names nothing.
//
// **The value returns to the wallet that signs**, whose payment key has to be
// the request's `owner`; that is checked here, by name, before anything is
// built. A request names a key, not an address, so the wallet's own change
// address is where it goes.
//
// **Coin selection never offers a reference script.** A placer's wallet may
// hold the outputs that publish the platform's validators; those are set aside
// for fees and for collateral alike (`spendableForFees`). A request's own ADA
// normally covers its network fee, so the wallet is rarely drawn on at all.
//
// **Refunds batch.** The refund arm has no shape rule, so one transaction takes
// back every request a placer names, for one fee and one signature.
// ============================================================================

import { Data, getAddressDetails } from '@lucid-evolution/lucid';
import { applyCborEncoding, MeshTxBuilder, type UTxO as MeshUTxO } from '@meshsdk/core';
import { type Cip30Api, Cip30CurveSpendWallet } from './cip30-curve-spend-wallet.js';
import {
  type CurveNetwork,
  type CurveSpendProvider,
  type CurveSpendWallet,
  spendableForFees,
} from './mesh-curve-spend.js';
import { MESH_NETWORK_ID, scriptAddressOf } from './reference-script.js';
import { venueRefundRedeemer } from './venue-liquidity.js';
import { VenueRoyaltyWithdrawConfigSchema, type VenueWithdrawOrderUtxo } from './venue-royalty-shapes.js';

/**
 * What one request's refund costs to execute, declared rather than measured
 * in the browser: the arm reads the datum and looks one key up in a list.
 * Measured by the offline evaluator against the compiled validator at 27,049
 * memory and 8,777,007 steps a request (the test holds the measurement under
 * these), with half as much again to spare.
 */
export const VENUE_WITHDRAW_REFUND_EXECUTION_UNITS = Object.freeze({ mem: 40_000, steps: 15_000_000 });

/** A request as the refund reads it, by its output reference. */
export const venueRequestRef = (r: Pick<VenueWithdrawOrderUtxo, 'txHash' | 'outputIndex'>) =>
  `${r.txHash}#${r.outputIndex}`;

/**
 * Every request at the request validator's address, or only those `owner`
 * placed, through a Blockfrost-shaped GET (the site's proxy in a browser).
 *
 * An output whose datum is not a request is passed over: anyone can pay to a
 * script address, and what they leave there is not a request anyone placed.
 */
export async function readVenueRoyaltyWithdrawRequests(
  get: (path: string) => Promise<unknown>,
  requestAddress: string,
  owner?: string,
): Promise<VenueWithdrawOrderUtxo[]> {
  const out: VenueWithdrawOrderUtxo[] = [];
  for (let page = 1; page <= 50; page++) {
    const rows = (await get(`addresses/${requestAddress}/utxos?page=${page}`)) as Array<{
      tx_hash: string;
      output_index: number;
      address: string;
      amount: Array<{ unit: string; quantity: string }>;
      inline_datum: string | null;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      if (!row.inline_datum) continue;
      let datum: VenueWithdrawOrderUtxo['datum'];
      try {
        datum = Data.from(row.inline_datum, VenueRoyaltyWithdrawConfigSchema);
      } catch {
        continue;
      }
      if (owner !== undefined && datum.owner !== owner) continue;
      const assets: Record<string, bigint> = {};
      for (const { unit, quantity } of row.amount) assets[unit] = (assets[unit] ?? 0n) + BigInt(quantity);
      out.push({ txHash: row.tx_hash, outputIndex: row.output_index, address: row.address, assets, datum });
    }
    if (rows.length < 100) break;
  }
  return out;
}

export interface VenueRoyaltyWithdrawRefundConfig {
  network: CurveNetwork;
  /** `withdraw_order.ak`'s compiled code, from the venue's blueprint. Carried in the transaction. */
  requestScriptCbor: string;
  provider: CurveSpendProvider;
  /** Budget per request; defaults to VENUE_WITHDRAW_REFUND_EXECUTION_UNITS. Leave unset in a test to measure. */
  executionUnits?: { mem: number; steps: number } | 'evaluate';
}

/** The payment key hash of a bech32 address, or a refusal naming why there is none. */
function paymentKeyOf(address: string): string {
  const credential = getAddressDetails(address).paymentCredential;
  if (credential?.type !== 'Key') {
    throw new Error('This wallet’s address has no payment key, so it cannot have placed a request.');
  }
  return credential.hash;
}

/**
 * Builds the refund of `requests`, unsigned. Every request must sit at the
 * request validator's address and name the wallet's payment key as its owner.
 */
export async function buildVenueRoyaltyWithdrawRefund(
  requests: readonly VenueWithdrawOrderUtxo[],
  wallet: CurveSpendWallet,
  config: VenueRoyaltyWithdrawRefundConfig,
): Promise<string> {
  if (requests.length === 0) {
    throw new Error('There is no withdraw request to take back.');
  }
  const requestAddress = scriptAddressOf(config.requestScriptCbor, MESH_NETWORK_ID[config.network]);
  const changeAddress = await wallet.getChangeAddress();
  const owner = paymentKeyOf(changeAddress);
  const seen = new Set<string>();
  for (const request of requests) {
    const ref = venueRequestRef(request);
    if (seen.has(ref)) throw new Error(`This refund names ${ref} twice. A transaction spends each input once.`);
    seen.add(ref);
    if (request.address !== requestAddress) {
      throw new Error(
        `${ref} sits at ${request.address}, not at the withdraw request address ${requestAddress}, so it is not ` +
          'a request this refund can take back.',
      );
    }
    if (request.datum.owner !== owner) {
      throw new Error(
        `Request ${ref} was placed by key ${request.datum.owner}, not by the connected wallet's key ${owner}. ` +
          'Only the wallet that placed a request can take it back.',
      );
    }
  }

  const [collateral, walletUtxos] = await Promise.all([wallet.getCollateral(), wallet.getUtxos()]);
  const collateralUtxo: MeshUTxO | undefined = collateral[0];
  if (!collateralUtxo) {
    throw new Error('The wallet has no collateral. A script spend needs a plain output of at least 5 ADA set aside.');
  }

  const measure = config.executionUnits === 'evaluate';
  const units: { mem: number; steps: number } =
    config.executionUnits === undefined || config.executionUnits === 'evaluate'
      ? VENUE_WITHDRAW_REFUND_EXECUTION_UNITS
      : config.executionUnits;
  const tx = new MeshTxBuilder({
    fetcher: config.provider as never,
    ...(measure ? { evaluator: config.provider as never } : {}),
    verbose: false,
  });
  const script = applyCborEncoding(config.requestScriptCbor);
  for (const request of requests) {
    tx.spendingPlutusScriptV3()
      .txIn(
        request.txHash,
        request.outputIndex,
        Object.entries(request.assets)
          .filter(([, quantity]) => quantity !== 0n)
          .map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
        request.address,
        0,
      )
      .txInScript(script)
      .txInInlineDatumPresent()
      // A copy each time: the builder writes a measured budget back into the
      // object it is handed, and a shared one would carry it to the next input.
      .txInRedeemerValue(venueRefundRedeemer(), 'CBOR', { ...units });
  }
  return await tx
    // The REQUIRED SIGNERS field, which is what the refund arm reads.
    .requiredSignerHash(owner)
    .txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex,
      collateralUtxo.output.amount,
      collateralUtxo.output.address,
    )
    .selectUtxosFrom(spendableForFees(walletUtxos))
    .changeAddress(changeAddress)
    .setNetwork(config.network)
    .complete();
}

/**
 * Takes the connected wallet's requests back. Returns the transaction hash and
 * what the requests held; the network fee comes out of that.
 */
export async function refundVenueRoyaltyWithdraws(args: {
  api: Cip30Api;
  requests: readonly VenueWithdrawOrderUtxo[];
  config: VenueRoyaltyWithdrawRefundConfig;
}): Promise<{ txHash: string; heldLovelace: bigint }> {
  const wallet = new Cip30CurveSpendWallet(args.api);
  const unsigned = await buildVenueRoyaltyWithdrawRefund(args.requests, wallet, args.config);
  const txHash = await wallet.submitTx(await wallet.signTx(unsigned));
  return { txHash, heldLovelace: args.requests.reduce((sum, r) => sum + (r.assets.lovelace ?? 0n), 0n) };
}
