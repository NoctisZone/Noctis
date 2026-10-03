// ============================================================================
// Noctis — DarkVeil Claim Widget: browser entry point (Cardano Launch)
// ============================================================================
// webpack browser target (see ../webpack.widgets.config.cjs's
// darkveil-claim-widget block), bundled to
// assets/js/darkveil-claim-widget.bundle.js in the theme. The DarkVeil claim
// page loads it when a buyer presses Claim, never with the page: it carries
// Mesh, which nothing else on that page needs.
//
// Exposes window.NoctisDarkVeilClaim, the same shape as the other widgets: the
// theme's vanilla JS calls it from a click handler, with the CIP-30 handler
// WeldPress holds for the connected wallet.
//
// A claim settles one registrant's private DarkVeil allocation on the Cardano
// curve: the buyer pays the flat DarkVeil price and receives their tokens,
// revealing their own allocation and nobody else's (claim-flow.ts). It is a
// curve spend, and a Cardano Launch curve spend references its validator,
// which is published on chain, because carried inline it leaves a transaction
// no room. So this is the referenced path, built with Mesh and signed by the
// buyer's own wallet (cip30-curve-spend-wallet.ts), as the creator's fee claim
// is. A page that cannot name the published validator is refused here rather
// than offered a transaction the network would not take.
//
// The allocation itself (amount, salt, proof, leaf index) is the buyer's claim
// record, which the DarkVeil widget fetches behind proof of wallet control or
// loads from the buyer's saved file. Everything this reads goes through the
// site's Blockfrost proxy, so no project id reaches the page.
// ============================================================================

import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import type { ReferenceScriptPointer } from '../reference-script.js';
import { type ClaimTierBParams, claimTierBTokens } from './claim-flow.js';

export interface DarkVeilClaimWidgetConfig {
  /** The site's Blockfrost proxy route. */
  blockfrostUrl: string;
  /** Empty or a placeholder: the proxy adds the real key. See blockfrost-proxy.php. */
  blockfrostProjectId: string;
  network: LucidNetwork;
  /** bonding_curve_tier_b.ak's compiled CBOR, from plutus.json, read server-side. */
  compiledScriptCbor: string;
  /** The launch's thread-NFT policy id, from the platform's record of the launch. */
  threadNftPolicyId: string;
  /** Where the curve validator is published, from the platform's settings. */
  referenceScript?: ReferenceScriptPointer | null;
}

export interface DarkVeilClaimRequest {
  launchIdHex: string;
  walletApi: WalletApi;
  params: ClaimTierBParams;
}

let config: DarkVeilClaimWidgetConfig | null = null;

function requireConfigured(): DarkVeilClaimWidgetConfig & { referenceScript: ReferenceScriptPointer } {
  if (!config) {
    throw new Error('NoctisDarkVeilClaim.configure() must be called before a claim.');
  }
  if (!config.referenceScript) {
    throw new Error(
      'Claims are not open yet: the site has not been given where the curve script is published, and a claim that carries the script cannot be submitted.',
    );
  }
  return config as DarkVeilClaimWidgetConfig & { referenceScript: ReferenceScriptPointer };
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('The launch id is not hex.');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const NoctisDarkVeilClaim = {
  configure(cfg: DarkVeilClaimWidgetConfig): void {
    config = cfg;
  },

  async claim(request: DarkVeilClaimRequest): Promise<{ txHash: string }> {
    const cfg = requireConfigured();
    return claimTierBTokens(
      {
        blockfrostProjectId: cfg.blockfrostProjectId,
        blockfrostUrl: cfg.blockfrostUrl,
        network: cfg.network,
        compiledScriptCbor: cfg.compiledScriptCbor,
        threadNftPolicyId: cfg.threadNftPolicyId,
        referenceScript: cfg.referenceScript,
        launchId: hexToBytes(request.launchIdHex),
      },
      request.walletApi,
      request.params,
    );
  },
};

declare global {
  interface Window {
    NoctisDarkVeilClaim: typeof NoctisDarkVeilClaim;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisDarkVeilClaim = NoctisDarkVeilClaim;
  // The claim page injects this bundle on demand and waits for this, as the
  // other widgets' glue does.
  window.dispatchEvent(new CustomEvent('noctis-darkveil-claim-ready'));
}

export default NoctisDarkVeilClaim;
