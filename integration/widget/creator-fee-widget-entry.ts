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
      async (path) => {
        const res = await fetch(`${cfg.blockfrostUrl}/${path}`);
        // Blockfrost answers 404 for an address holding none of the asset.
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`The chain could not be read just now (${res.status}). Try again shortly.`);
        return res.json();
      },
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
