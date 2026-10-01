// ============================================================================
// Noctis — Creator Fee Widget: browser entry point (Cardano Launch curve fees)
// ============================================================================
// webpack browser target (see ../webpack.widgets.config.cjs's
// creator-fee-widget block), bundled to assets/js/creator-fee-widget.bundle.js
// in the theme. The creator dashboard loads it when a creator presses Claim,
// never with the page: it carries Mesh, which the dashboard has no other use
// for.
//
// Exposes window.NoctisCreatorFees, the same shape as the other widgets: the
// theme's vanilla JS calls it from a click handler, with the CIP-30 handler
// WeldPress holds for the connected wallet.
//
// A Cardano Launch curve spend references its validator, which is published
// on chain, because carried inline it leaves a transaction almost no room. So
// this is the referenced path, built with Mesh and signed by the creator's own
// wallet (cip30-curve-spend-wallet.ts). Everything it reads goes through the
// site's Blockfrost proxy, so no project id reaches the page.
//
// What a claim moves: `amount` of the launch's accrued creator fees leaves the
// curve to the claiming wallet, and the platform's claim charge enters the
// curve from that same wallet, along with the network fee. The curve pays its
// creator, or the community wallet once a takeover holds, and checks that
// against its own datum; the submitter says so by name before anything is
// signed.
//
// The same bundle withdraws the creator's NoctisSwap pool royalty. That is a
// request, not a spend: the wallet signs the amounts with `signData` and pays a
// small request an executor fills (venue-royalty-withdraw-placer.ts). The page
// offers it only where the site's batcher fills withdraws, which is what
// `venue` in the config says.
//
// A request nobody fills comes back to the wallet that placed it
// (venue-royalty-withdraw-refund.ts). That is offered wherever the site knows
// the request validator, fills or no fills: a request must never be stranded
// because the site stopped filling them.
// ============================================================================

import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import type { CurveNetwork } from '../mesh-curve-spend.js';
import { MESH_NETWORK_ID, type ReferenceScriptPointer, scriptAddressOf } from '../reference-script.js';
import {
  LucidTierBCurveSubmitter,
  meshBlockfrostProvider,
  PLATFORM_CHARGE_LOVELACE,
} from '../tier-b-curve-submitter.js';
import {
  type Cip30SigningApi,
  placeVenueRoyaltyWithdraw,
  readVenuePoolByNft,
} from '../venue-royalty-withdraw-placer.js';
import {
  readVenueRoyaltyWithdrawRequests,
  refundVenueRoyaltyWithdraws,
  venueRequestRef,
} from '../venue-royalty-withdraw-refund.js';

export interface CreatorFeeWidgetConfig {
  /** The site's Blockfrost proxy route. */
  blockfrostUrl: string;
  /** A placeholder: the proxy adds the real key. See blockfrost-proxy.php. */
  blockfrostProjectId: string;
  network: LucidNetwork;
  /** bonding_curve_tier_b.ak's compiled CBOR, from plutus.json, read server-side. */
  curveScriptCbor: string;
  /** Where that validator is published, from the platform's settings. */
  referenceScript: ReferenceScriptPointer;
  /**
   * The venue's scripts, present only where the site fills royalty withdraws:
   * the pool validator as deployed (applied), and the withdraw request
   * validator. Both are read server-side from the venue's blueprints.
   */
  venue?: { poolScriptCbor: string; withdrawScriptCbor: string };
  /**
   * The withdraw request validator, present wherever the venue's blueprint is
   * configured, whether or not the site fills withdraws: what taking a request
   * back spends.
   */
  requestScriptCbor?: string;
}

export interface RoyaltyRefundRequest {
  /** The requests to take back, as `txHash#index`. Each must still be open and placed by this wallet. */
  refs: string[];
  walletApi: WalletApi;
}

export interface RoyaltyWithdrawRequest {
  /** The launch's pool NFT unit, from the platform's record of its pool. */
  poolNft: string;
  walletApi: WalletApi;
}

const CURVE_NETWORK: Partial<Record<LucidNetwork, CurveNetwork>> = {
  Preview: 'preview',
  Preprod: 'preprod',
  Mainnet: 'mainnet',
};

export interface ClaimRequest {
  launchIdHex: string;
  /** From the platform's own record of the launch, so the curve read is authenticated. */
  threadNftPolicyId: string;
  /** Lovelace to take out of the launch's accrued creator fees. */
  amountLovelace: string;
  walletApi: WalletApi;
}

let config: CreatorFeeWidgetConfig | null = null;

function requireConfigured(): CreatorFeeWidgetConfig {
  if (!config) {
    throw new Error('NoctisCreatorFees.configure() must be called before a claim.');
  }
  return config;
}

/** A Blockfrost GET through the site's proxy; 404 is an address holding nothing. */
function proxyGet(cfg: CreatorFeeWidgetConfig) {
  return async (path: string): Promise<unknown> => {
    const res = await fetch(`${cfg.blockfrostUrl}/${path}`);
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`The chain could not be read just now (${res.status}). Try again shortly.`);
    return res.json();
  };
}

const NoctisCreatorFees = {
  configure(cfg: CreatorFeeWidgetConfig): void {
    config = cfg;
  },

  /** The platform's charge on a claim, in lovelace, paid into the curve by the claiming wallet. */
  claimChargeLovelace(): string {
    return PLATFORM_CHARGE_LOVELACE.toString();
  },

  async claim(request: ClaimRequest): Promise<{ txHash: string }> {
    const cfg = requireConfigured();
    const amount = BigInt(request.amountLovelace);
    if (amount <= 0n) {
      throw new Error('There is nothing to claim on this launch.');
    }
    const submitter = new LucidTierBCurveSubmitter({
      blockfrostProjectId: cfg.blockfrostProjectId,
      blockfrostUrl: cfg.blockfrostUrl,
      network: cfg.network,
      compiledScriptCbor: cfg.curveScriptCbor,
      launchIdHex: request.launchIdHex,
      threadNftPolicyId: request.threadNftPolicyId,
      referenceScript: cfg.referenceScript,
    });
    return submitter.claimCreatorFeesWithWallet(request.walletApi, amount);
  },

  /**
   * Signs and places a request for everything the pool owes the creator.
   * Returns what it takes and where it will be paid; an executor pays it.
   */
  async withdrawRoyalty(request: RoyaltyWithdrawRequest): Promise<{
    txHash: string;
    takeLovelace: string;
    takeTokens: string;
    feeLovelace: string;
    payoutAddress: string;
  }> {
    const cfg = requireConfigured();
    if (!cfg.venue) {
      throw new Error('Withdrawing a pool royalty is not open on this site yet.');
    }
    const network = CURVE_NETWORK[cfg.network];
    if (!network) throw new Error(`Unknown network "${cfg.network}".`);
    const networkId = MESH_NETWORK_ID[network];
    const pool = await readVenuePoolByNft(
      proxyGet(cfg),
      scriptAddressOf(cfg.venue.poolScriptCbor, networkId),
      request.poolNft,
    );
    const placed = await placeVenueRoyaltyWithdraw({
      api: request.walletApi as unknown as Cip30SigningApi,
      pool,
      network,
      requestAddress: scriptAddressOf(cfg.venue.withdrawScriptCbor, networkId),
      provider: meshBlockfrostProvider(cfg),
    });
    const wd = placed.draft.withdrawData;
    return {
      txHash: placed.txHash,
      takeLovelace: wd.withdraw_royalty_x.toString(),
      takeTokens: wd.withdraw_royalty_y.toString(),
      feeLovelace: wd.ex_fee.toString(),
      payoutAddress: placed.draft.payoutAddress,
    };
  },

  /**
   * Takes back withdraw requests this wallet placed and nobody filled. Each
   * named request is read again first: one filled or taken back since the
   * page was drawn is refused by name rather than built into a transaction
   * that cannot land.
   */
  async refundRoyalty(request: RoyaltyRefundRequest): Promise<{ txHash: string; heldLovelace: string; count: number }> {
    const cfg = requireConfigured();
    if (!cfg.requestScriptCbor) {
      throw new Error('This site has not been given the withdraw request validator, so it cannot take a request back.');
    }
    const network = CURVE_NETWORK[cfg.network];
    if (!network) throw new Error(`Unknown network "${cfg.network}".`);
    const wanted = [...new Set(request.refs)];
    if (wanted.length === 0) throw new Error('There is no withdraw request to take back.');
    const open = await readVenueRoyaltyWithdrawRequests(
      proxyGet(cfg),
      scriptAddressOf(cfg.requestScriptCbor, MESH_NETWORK_ID[network]),
    );
    const byRef = new Map(open.map((r) => [venueRequestRef(r), r]));
    const gone = wanted.filter((ref) => !byRef.has(ref));
    if (gone.length > 0) {
      throw new Error(
        `${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer waiting: filled or taken back since this ` +
          'page was drawn. Refresh to see where it stands.',
      );
    }
    const res = await refundVenueRoyaltyWithdraws({
      api: request.walletApi as unknown as Cip30SigningApi,
      requests: wanted.map((ref) => byRef.get(ref) as NonNullable<ReturnType<typeof byRef.get>>),
      config: { network, requestScriptCbor: cfg.requestScriptCbor, provider: meshBlockfrostProvider(cfg) },
    });
    return { txHash: res.txHash, heldLovelace: res.heldLovelace.toString(), count: wanted.length };
  },
};

declare global {
  interface Window {
    NoctisCreatorFees: typeof NoctisCreatorFees;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisCreatorFees = NoctisCreatorFees;
  // The dashboard injects this bundle on demand and waits for this, as the
  // other widgets' glue does.
  window.dispatchEvent(new CustomEvent('noctis-creator-fees-ready'));
}
