// Noctis Zone — esbuild build script.
// Node-platform CLI bundles only (for PHP's proc_open-invoked one-shot
// checks). Run: node build.mjs [--watch]
//
// (2026-07-17): the browser widget bundles (DarkVeil, the linear curve buy) moved
// OFF esbuild entirely, to webpack.widgets.config.cjs — esbuild's WASM
// handling cannot correctly link wasm-bindgen's `--target bundler` output
// that several Lucid Evolution/Midnight transitive deps ship, which broke
// window.NoctisDarkVeil/window.NoctisTierABuy at runtime with no build-time
// error. Run `npm run build:widgets` for those. This file no longer builds
// or references either widget.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Source maps are a debugging aid, so they are built on request rather than
// by default: `NOCTIS_SOURCEMAPS=1 node build.mjs`. A watch build turns them
// on regardless — that is someone sitting at the code, which is exactly when
// a stack trace needs to point at a real line.
//
// They are the single largest thing this repo produces. Left on, the maps
// outweigh the code they describe several times over and every byte of that
// is deployed to a host that charges for the space and reads it on backup.
const sourcemap = watch || process.env.NOCTIS_SOURCEMAPS === "1";

const cliConfig = {
	entryPoints: [join(__dirname, "cli/check-night-balance.ts")],
	outfile: join(__dirname, "cli/dist/check-night-balance.mjs"),
	bundle: true,
	platform: "node",
	// ESM output (not CJS): @midnight-ntwrk/ledger-v8's WASM loader resolves
	// its .wasm file's path via a real `import.meta.url` — under esbuild's
	// CJS output, import.meta has no equivalent and gets shimmed to
	// `undefined`, breaking that path resolution (found the hard way: same
	// TypeError as a raw `fileURLToPath(undefined)` call). ESM output keeps
	// import.meta.url real and correct.
	//
	// The tradeoff: `cbor` (a CJS-only package) has a dynamic (non-static)
	// require() call esbuild can't safely convert for ESM output, and throws
	// "Dynamic require of 'stream' is not supported" if bundled. Rather than
	// bundle it, `cbor` is left external below — Node's own ESM/CJS interop
	// resolves a plain `import` of a CJS package via real node_modules
	// resolution at runtime (walking up from this file's real location, i.e.
	// finding integration/node_modules/cbor regardless of invocation cwd),
	// with no esbuild shim involved for it at all.
	external: ["cbor"],
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
	// A transitive dep does a dynamic require('assert'/'events'). esbuild's
	// ESM output can't convert that; shim a real require() from
	// import.meta.url so the bundle resolves Node built-ins/CJS deps at
	// runtime. Found 2026-07-30: this config was missing the same banner
	// deriveMidnightAddressCliConfig/midnightWalletBalanceCliConfig already
	// carry for this exact issue class — without it, the bundled .mjs crashed
	// immediately at import time with "Dynamic require of 'assert' is not
	// supported", before main() ever ran. Confirmed pre-existing (not
	// introduced by any later change) via git stash + rebuild from pristine
	// source, same crash either way.
	banner: {
		js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
	},
};

// Banner note (2026-07-30, applied to this + the next 4 ESM configs below
// that lacked it): a transitive dep may do a dynamic require() of a Node
// builtin, which esbuild's ESM output can't convert on its own. This
// config's own real bundled deps don't currently hit that path (verified —
// smoke-tests clean either way), but readDvPurchasesCliConfig/
// publishAllowlistRootCliConfig below DO (crash at import time without
// this), via the exact same @midnight-ntwrk/ledger-v8 dependency class this
// file also pulls in transitively. Added here too, defensively and inertly
// (a no-op unless something actually calls require), rather than waiting
// for this file's own dependency tree to shift and hit the same crash
// later. See cliConfig's own banner comment for the original discovery.
const allowlistTreeCliConfig = {
	entryPoints: [join(__dirname, "cli/build-allowlist-tree.ts")],
	outfile: join(__dirname, "cli/dist/build-allowlist-tree.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
	banner: {
		js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
	},
};

// (2026-07-19): pure off-chain crypto, no Lucid/Midnight WASM
// dependency — same simple ESM shape as allowlistTreeCliConfig above.
// Banner added 2026-07-30 for the same defensive reason as that config.
const buildDvAllocationTreeCliConfig = {
	entryPoints: [join(__dirname, "cli/build-dv-allocation-tree.ts")],
	outfile: join(__dirname, "cli/dist/build-dv-allocation-tree.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
	banner: {
		js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
	},
};

const getDvAllocationProofCliConfig = {
	entryPoints: [join(__dirname, "cli/get-dv-allocation-proof.ts")],
	outfile: join(__dirname, "cli/dist/get-dv-allocation-proof.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
	banner: {
		js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
	},
};

const verifyCtoVoterRegistrationCliConfig = {
	entryPoints: [join(__dirname, "cli/verify-cto-voter-registration.ts")],
	outfile: join(__dirname, "cli/dist/verify-cto-voter-registration.mjs"),
	bundle: true,
	platform: "node",
	// ESM, not CJS — found the hard way (real runtime error, not assumed):
	// this CLI is the first in this codebase to mix BOTH Midnight
	// (witnesses.ts's deriveUserPublicKey, transitively needing
	// @midnight-ntwrk/ledger-v8's WASM loader, which needs a real
	// import.meta.url — the same reasoning cliConfig above documents) AND
	// Cardano/Lucid Evolution (verifyData/getAddressDetails, transitively
	// needing CML's WASM loader, which readTierALaunchStateCliConfig's own
	// comment says needs a real bare __dirname instead). Tried CJS first
	// (matching the other Lucid-only CLIs) — failed at runtime with
	// `fileURLToPath(undefined)` inside midnight-ledger-wasm's loader
	// (import.meta.url shimmed to undefined under CJS). ESM alone then
	// failed the OTHER way — `ReferenceError: __dirname is not defined`
	// inside CML's own loader, once esbuild had inlined/relocated it into
	// the single bundle file. Neither format alone satisfies both. Fixed by
	// marking CML external (same idiom as cbor below) — Node's own native
	// ESM/CJS interop then resolves it fresh from its real node_modules
	// location at runtime, where __dirname is genuinely still valid,
	// instead of esbuild concatenating it into a context where it isn't.
	// Externalizing individual WASM-bearing packages kept surfacing the same
	// class of error against a NEW transitive package each time (CML, then
	// bip39, then @lucid-evolution/uplc, then @subsquid/util-internal-hex —
	// each doing its own dynamic require() of a Node builtin esbuild's ESM
	// shim can't handle). This CLI is the first in this codebase mixing
	// Midnight's + Cardano's FULL dependency trees in one bundle, and
	// whack-a-moling individual package names has no clear end. Switched
	// strategy entirely: `packages: 'external'` (a real, documented esbuild
	// option) stops bundling ANY node_modules dependency at all — only this
	// CLI's own local relative imports (../cto-voter-registration.js etc.)
	// get bundled; every real npm package resolves natively via Node's own
	// module resolution at runtime, where its own __dirname/import.meta.url
	// context is always correct regardless of format. This sidesteps the
	// whole class of conflict in one step rather than chasing it package by
	// package. WASM_FILES copying (below) still applies unchanged — those
	// packages' own real file locations in node_modules are what matters now
	// that they're not relocated by bundling.
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const checkCtoBadgeStatusCliConfig = {
	entryPoints: [join(__dirname, "cli/check-cto-badge-status.ts")],
	outfile: join(__dirname, "cli/dist/check-cto-badge-status.mjs"),
	bundle: true,
	platform: "node",
	// ESM, same reasoning as cliConfig above — this touches Midnight packages
	// (indexer-public-data-provider, the compiled cto_governance contract's
	// ledger()), same WASM/import.meta.url class as check-night-balance.ts.
	external: ["cbor"],
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
	// Same missing-banner gap as cliConfig above, found and fixed in the same
	// pass (2026-07-30) — see that config's comment for the full story.
	banner: {
		js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
	},
};

const readTierALaunchStateCliConfig = {
	entryPoints: [join(__dirname, "cli/read-tier-a-launch-state.ts")],
	outfile: join(__dirname, "cli/dist/read-tier-a-launch-state.cjs"),
	bundle: true,
	platform: "node",
	// CJS, not ESM — unlike cliConfig (which needs import.meta.url for real
	// for @midnight-ntwrk/ledger-v8's WASM loading), this script is pure
	// Cardano/Lucid Evolution with no Midnight dependency. Found the hard way
	// (real runtime error, not assumed): @anastasia-labs/cardano-multiplatform-
	// lib-nodejs (a Lucid Evolution transitive dep) references a bare
	// `__dirname` internally to locate its own WASM file — a CJS-only global
	// that doesn't exist under ESM output and that esbuild does not shim for
	// bundled (not external) dependencies. CJS format provides it natively.
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const buildGenesisDatumsCliConfig = {
	entryPoints: [join(__dirname, "cli/build-tier-a-genesis-datums.ts")],
	outfile: join(__dirname, "cli/dist/build-tier-a-genesis-datums.cjs"),
	bundle: true,
	platform: "node",
	// CJS for the same reason as readTierALaunchStateCliConfig above (a Lucid
	// Evolution transitive dep needs a real bare __dirname).
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const mintLaunchCliConfig = {
	entryPoints: [join(__dirname, "cli/mint-tier-a-launch.ts")],
	outfile: join(__dirname, "cli/dist/mint-tier-a-launch.cjs"),
	bundle: true,
	platform: "node",
	// CJS for the same reason as buildGenesisDatumsCliConfig above.
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const usdToAdaCliConfig = {
	entryPoints: [join(__dirname, "cli/usd-to-ada.ts")],
	outfile: join(__dirname, "cli/dist/usd-to-ada.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const activateCurveCliConfig = {
	entryPoints: [join(__dirname, "cli/activate-tier-a-curve.ts")],
	outfile: join(__dirname, "cli/dist/activate-tier-a-curve.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// (2026-07-21): one consolidated action-dispatched CLI for Cardano Launch's
// public curve (activate/buy/claim-*-fees/expire/claim-buyback) — same
// __dirname/CML-WASM CJS reasoning as activateCurveCliConfig above (Lucid
// Evolution's own bundled CML dependency needs a real __dirname at runtime,
// which ESM output doesn't provide the same way).
const tierBCurveActionCliConfig = {
	entryPoints: [join(__dirname, "cli/tier-b-curve-action.ts")],
	outfile: join(__dirname, "cli/dist/tier-b-curve-action.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// token_metadata.ak CIP-68 logo feature — same __dirname/CML-WASM CJS
// reasoning as tierBCurveActionCliConfig above.
const tokenMetadataActionCliConfig = {
	entryPoints: [join(__dirname, "cli/token-metadata-action.ts")],
	outfile: join(__dirname, "cli/dist/token-metadata-action.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// Staking UI (2026-07-22): one consolidated action-dispatched CLI for
// staking_pool.ak (stake/unstake/claim-rewards/top-up/publish-reward-root/
// read-pool/read-positions/build-reward-snapshot/get-reward-proof), same
// pattern as tierBCurveActionCliConfig above.
const stakeActionCliConfig = {
	entryPoints: [join(__dirname, "cli/stake-action.ts")],
	outfile: join(__dirname, "cli/dist/stake-action.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const anchorDvAllocationRootCliConfig = {
	entryPoints: [join(__dirname, "cli/anchor-dv-allocation-root-tier-b.ts")],
	outfile: join(__dirname, "cli/dist/anchor-dv-allocation-root-tier-b.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const buyCurveCliConfig = {
	entryPoints: [join(__dirname, "cli/buy-tier-a-curve.ts")],
	outfile: join(__dirname, "cli/dist/buy-tier-a-curve.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const sellCurveCliConfig = {
	entryPoints: [join(__dirname, "cli/sell-tier-a-curve.ts")],
	outfile: join(__dirname, "cli/dist/sell-tier-a-curve.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const expireCurveCliConfig = {
	entryPoints: [join(__dirname, "cli/expire-tier-a-curve.ts")],
	outfile: join(__dirname, "cli/dist/expire-tier-a-curve.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const claimBuybackCliConfig = {
	entryPoints: [join(__dirname, "cli/claim-buyback-tier-a.ts")],
	outfile: join(__dirname, "cli/dist/claim-buyback-tier-a.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const graduateLaunchCliConfig = {
	entryPoints: [join(__dirname, "cli/graduate-tier-a-launch.ts")],
	outfile: join(__dirname, "cli/dist/graduate-tier-a-launch.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const graduateTierBLaunchCliConfig = {
	entryPoints: [join(__dirname, "cli/graduate-tier-b-launch.ts")],
	outfile: join(__dirname, "cli/dist/graduate-tier-b-launch.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// cto_governance.ak's remaining 3 real redeemers with no prior submitter
// (ExecuteProposal/VoidPendingProposal/ReclaimRelayerBond) — same
// __dirname/CML-WASM CJS reasoning as readTierALaunchStateCliConfig.
const executeCtoProposalCliConfig = {
	entryPoints: [join(__dirname, "cli/execute-cto-proposal.ts")],
	outfile: join(__dirname, "cli/dist/execute-cto-proposal.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const voidCtoProposalCliConfig = {
	entryPoints: [join(__dirname, "cli/void-cto-proposal.ts")],
	outfile: join(__dirname, "cli/dist/void-cto-proposal.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const reclaimCtoRelayerBondCliConfig = {
	entryPoints: [join(__dirname, "cli/reclaim-cto-relayer-bond.ts")],
	outfile: join(__dirname, "cli/dist/reclaim-cto-relayer-bond.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const reclaimReferenceScriptsCliConfig = {
	entryPoints: [join(__dirname, "cli/reclaim-reference-scripts.ts")],
	outfile: join(__dirname, "cli/dist/reclaim-reference-scripts.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const rebuildCapStateCliConfig = {
	entryPoints: [join(__dirname, "cli/rebuild-cap-state.ts")],
	outfile: join(__dirname, "cli/dist/rebuild-cap-state.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const batchActionCliConfig = {
	entryPoints: [join(__dirname, "cli/batch-action.ts")],
	outfile: join(__dirname, "cli/dist/batch-action.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const orderActionCliConfig = {
	entryPoints: [join(__dirname, "cli/order-action.ts")],
	outfile: join(__dirname, "cli/dist/order-action.cjs"),
	bundle: true,
	platform: "node",
	// CJS for the same reason as the other Cardano CLIs: a bundled transitive
	// dependency reads a bare `__dirname` to find its own WASM.
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const publishReferenceScriptCliConfig = {
	entryPoints: [join(__dirname, "cli/publish-reference-script.ts")],
	outfile: join(__dirname, "cli/dist/publish-reference-script.cjs"),
	bundle: true,
	platform: "node",
	// CJS for the same reason as the other Cardano CLIs: a bundled transitive
	// dependency reads a bare `__dirname` to find its own WASM.
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const startVestingCliConfig = {
	entryPoints: [join(__dirname, "cli/start-vesting-tier-a.ts")],
	outfile: join(__dirname, "cli/dist/start-vesting-tier-a.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const proposeDexChangeCliConfig = {
	entryPoints: [join(__dirname, "cli/propose-dex-change-tier-a.ts")],
	outfile: join(__dirname, "cli/dist/propose-dex-change-tier-a.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const executeDexChangeCliConfig = {
	entryPoints: [join(__dirname, "cli/execute-dex-change-tier-a.ts")],
	outfile: join(__dirname, "cli/dist/execute-dex-change-tier-a.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const migrateLpToMinswapCliConfig = {
	entryPoints: [join(__dirname, "cli/migrate-lp-to-minswap-tier-a.ts")],
	outfile: join(__dirname, "cli/dist/migrate-lp-to-minswap-tier-a.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const claimVestedCliConfig = {
	entryPoints: [join(__dirname, "cli/claim-vested-tier-a.ts")],
	outfile: join(__dirname, "cli/dist/claim-vested-tier-a.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const claimCreatorFeesCliConfig = {
	entryPoints: [join(__dirname, "cli/claim-creator-fees-tier-a.ts")],
	outfile: join(__dirname, "cli/dist/claim-creator-fees-tier-a.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const readTradeHistoryCliConfig = {
	entryPoints: [join(__dirname, "cli/read-tier-a-trade-history.ts")],
	outfile: join(__dirname, "cli/dist/read-tier-a-trade-history.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const checkCtoCreatorActivityCliConfig = {
	entryPoints: [join(__dirname, "cli/check-cto-creator-activity-tier-a.ts")],
	outfile: join(__dirname, "cli/dist/check-cto-creator-activity-tier-a.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs", // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// (2026-07-20): governor-side reader for eligibility_gate.compact's
// dvTokensPurchased map — touches Midnight packages (ledger()/indexer
// provider), same real-import.meta.url/WASM reasoning as
// checkCtoBadgeStatusCliConfig above.
const readDvPurchasesCliConfig = {
	entryPoints: [join(__dirname, "cli/read-dv-purchases.ts")],
	outfile: join(__dirname, "cli/dist/read-dv-purchases.mjs"),
	bundle: true,
	platform: "node",
	external: ["cbor"],
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
	// Confirmed broken without this (2026-07-30): a transitive dep
	// (@subsquid/util-internal-hex, pulled in via the Midnight indexer chain)
	// does a dynamic require('assert'), crashing the bundle at import time —
	// "Dynamic require of 'assert' is not supported", before main() even
	// runs. Same fix as cliConfig's own banner above.
	banner: {
		js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
	},
};

// (2026-07-21): server-side wallet + ContractProviders assembly
// (midnight-server-wallet.ts) for the governor allowlist-root publisher —
// depends on @midnight-ntwrk/wallet-sdk-* (HD derivation, WalletFacade)
// plus midnight-js-contracts, same WASM dependency (ledger-v8) as
// readDvPurchasesCliConfig, no package-specific WASM of its own.
// Deploys a Cardano Launch eligibility gate. Same packages:external treatment as
// publishAllowlistRootCliConfig below and for the same reason — it pulls the
// identical Midnight dependency tree, so it cannot be bundled either.
// Completes a gate that was deployed in phases, one maintenance update per
// circuit. Same packages:external treatment as the deploy CLI above and for
// the same reason — it pulls the identical Midnight dependency tree.
// Drives a Cardano Launch DarkVeil phase: the governor's phase transitions and each
// registrant's own register/commit/reveal/claim. Same packages:external
// treatment as the deploy CLI and for the same reason — identical Midnight
// dependency tree.
const darkVeilActionCliConfig = {
	entryPoints: [join(__dirname, "cli/darkveil-action.ts")],
	outfile: join(__dirname, "cli/dist/darkveil-action.mjs"),
	bundle: true,
	platform: "node",
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const deliverDeferredCircuitsCliConfig = {
	entryPoints: [join(__dirname, "cli/deliver-deferred-circuits.ts")],
	outfile: join(__dirname, "cli/dist/deliver-deferred-circuits.mjs"),
	bundle: true,
	platform: "node",
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const deployEligibilityGateCliConfig = {
	entryPoints: [join(__dirname, "cli/deploy-eligibility-gate.ts")],
	outfile: join(__dirname, "cli/dist/deploy-eligibility-gate.mjs"),
	bundle: true,
	platform: "node",
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// CTO governance on Midnight: the governance contract's deploy, and the one
// action CLI that publishes snapshots, files proposals, casts votes,
// finalizes and executes. Same packages:external treatment as the DarkVeil
// CLIs above and for the same reason.
const deployCtoGovernanceCliConfig = {
	entryPoints: [join(__dirname, "cli/deploy-cto-governance.ts")],
	outfile: join(__dirname, "cli/dist/deploy-cto-governance.mjs"),
	bundle: true,
	platform: "node",
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const ctoGovernanceActionCliConfig = {
	entryPoints: [join(__dirname, "cli/cto-governance-action.ts")],
	outfile: join(__dirname, "cli/dist/cto-governance-action.mjs"),
	bundle: true,
	platform: "node",
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// Pure: builds the balance-snapshot bundle voters prove against. Pulls the
// compact runtime for the hashes, so it takes the same external treatment.
const buildCtoSnapshotBundleCliConfig = {
	entryPoints: [join(__dirname, "cli/build-cto-snapshot-bundle.ts")],
	outfile: join(__dirname, "cli/dist/build-cto-snapshot-bundle.mjs"),
	bundle: true,
	platform: "node",
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// Registers a wallet's NIGHT UTXOs for DUST generation, which every wallet
// needs once before it can pay for anything. Builds on midnight-server-wallet.ts
// exactly as the deploy CLI above does, so it inherits the same unbundlable
// Midnight dependency tree and the same packages:external treatment.
const midnightRegisterDustCliConfig = {
	entryPoints: [join(__dirname, "cli/midnight-register-dust.ts")],
	outfile: join(__dirname, "cli/dist/midnight-register-dust.mjs"),
	bundle: true,
	platform: "node",
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// Replays wallets to a spendable DUST balance, one wallet at a time, restarting
// each attempt in a fresh child process that resumes from the last snapshot.
// Same unbundlable Midnight dependency tree as the two CLIs above.
//
// This one re-launches ITSELF as the per-attempt child, so the bundle has to be
// directly runnable by node — which packages:external already gives it.
const midnightSyncWalletsCliConfig = {
	entryPoints: [join(__dirname, "cli/midnight-sync-wallets.ts")],
	outfile: join(__dirname, "cli/dist/midnight-sync-wallets.mjs"),
	bundle: true,
	platform: "node",
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// Turns server-held wallets into a launch's allowlist root plus one membership
// proof per registrant. Pure computation over the zk-proofs package — no
// Midnight SDK, so this bundles normally rather than needing packages:external.
const buildDvAllowlistBundleCliConfig = {
	entryPoints: [join(__dirname, "cli/build-dv-allowlist-bundle.ts")],
	outfile: join(__dirname, "cli/dist/build-dv-allowlist-bundle.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// Freezes the registrant set into the root startBuying publishes, plus one
// membership proof each. Reads the set off the chain rather than from a list,
// so it pulls in the indexer provider and needs packages:external like the
// other SDK-touching CLIs.
const buildDvRegistrantBundleCliConfig = {
	entryPoints: [join(__dirname, "cli/build-dv-registrant-bundle.ts")],
	outfile: join(__dirname, "cli/dist/build-dv-registrant-bundle.mjs"),
	bundle: true,
	platform: "node",
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

const publishAllowlistRootCliConfig = {
	entryPoints: [join(__dirname, "cli/publish-allowlist-root.ts")],
	outfile: join(__dirname, "cli/dist/publish-allowlist-root.mjs"),
	bundle: true,
	platform: "node",
	// packages: 'external', not bundle+banner (2026-07-30): this CLI pulls in
	// BOTH @subsquid/util-internal-hex (dynamic require('assert') — the
	// banner alone fixes this, confirmed) AND classic-level's binding.js
	// (does `require_node_gyp_build2()(__dirname)` — a real __dirname
	// REFERENCE, not a require() call, which the banner's require-shim can't
	// help with; crashed with "ReferenceError: __dirname is not defined in ES
	// module scope" even with the banner applied). This is the exact mixed
	// dependency-tree conflict verifyCtoVoterRegistrationCliConfig's own
	// comment documents (Midnight's + Cardano's full trees in one bundle,
	// different transitive packages each doing their own dynamic
	// require()/__dirname access esbuild's ESM output can't shim uniformly)
	// — same fix: stop bundling node_modules entirely so every package
	// resolves fresh via Node's own module resolution at runtime, where its
	// own __dirname/import.meta.url context is always correct. WASM_FILES
	// copying (below) still applies unchanged.
	packages: "external",
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// Pure Lucid Evolution address parsing (getAddressDetails) — CJS for
// the same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig.
const resolveAddressVkhCliConfig = {
	entryPoints: [join(__dirname, "cli/resolve-address-payment-key-hashes.ts")],
	outfile: join(__dirname, "cli/dist/resolve-address-payment-key-hashes.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap,
	logLevel: "info",
};

// Midnight unshielded address derivation from a wallet seed — uses the wallet
// SDK (HD + unshielded keystore), so ESM output + external cbor, same as
// check-night-balance's cliConfig (the WASM/import.meta reasoning above).
const deriveMidnightAddressCliConfig = {
	entryPoints: [join(__dirname, "cli/derive-midnight-address.ts")],
	outfile: join(__dirname, "cli/dist/derive-midnight-address.mjs"),
	bundle: true,
	platform: "node",
	external: ["cbor"],
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
	// A transitive dep does a dynamic require('assert'). esbuild's ESM output
	// can't convert that; shim a real require() from import.meta.url so the
	// bundle resolves Node built-ins/CJS deps at runtime.
	banner: {
		js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
	},
};

// Midnight wallet NIGHT balance (+ derived DUST capacity) — address derivation
// + a public-indexer NIGHT-balance query (getUnshieldedNightBalance), same
// WASM/ESM+banner needs as check-night-balance.
// The batch form of midnightWalletBalanceCliConfig below — same dependencies,
// same treatment, several seeds per process instead of one.
const midnightWalletBalancesCliConfig = {
	entryPoints: [join(__dirname, "cli/midnight-wallet-balances.ts")],
	outfile: join(__dirname, "cli/dist/midnight-wallet-balances.mjs"),
	bundle: true,
	platform: "node",
	external: ["cbor"],
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
	banner: {
		js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
	},
};

const midnightWalletBalanceCliConfig = {
	entryPoints: [join(__dirname, "cli/midnight-wallet-balance.ts")],
	outfile: join(__dirname, "cli/dist/midnight-wallet-balance.mjs"),
	bundle: true,
	platform: "node",
	external: ["cbor"],
	format: "esm",
	target: "node20",
	sourcemap,
	logLevel: "info",
	banner: {
		js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
	},
};

// Several packages load a WASM binary via a readFileSync relative to their
// own module location at runtime — esbuild bundles the *reference* to that
// read, not the binary itself, so each has to be copied next to every CLI
// bundle's output by hand. Found the hard way, three times now: ledger-v8's
// midnight_ledger_wasm_bg.wasm (nativeToken(), used by check-night-balance.ts),
// onchain-runtime-v3's midnight_onchain_runtime_wasm_bg.wasm
// (persistentHash(), used by build-allowlist-tree.ts via packages/zk-proofs),
// and @anastasia-labs/cardano-multiplatform-lib-nodejs's own
// cardano_multiplatform_lib_bg.wasm (a Lucid Evolution transitive dep, used
// by read-tier-a-launch-state.ts). Every one of the three bundles built
// clean each time; only a real run surfaced the missing file.
//
// Resolved via import.meta.resolve() rather than a path hardcoded relative
// to this file's own directory (2026-07-30, npm workspace conversion):
// these packages now live in the workspace ROOT node_modules once hoisted,
// not necessarily integration/node_modules, so a fixed `join(__dirname,
// "node_modules/...")` silently pointed at a location that no longer
// existed. import.meta.resolve() walks module resolution the same way
// Node itself does, so it finds the real file regardless of hoisting.
const WASM_FILES = [
	{ pkg: "@midnight-ntwrk/ledger-v8", file: "midnight_ledger_wasm_bg.wasm" },
	{ pkg: "@midnight-ntwrk/onchain-runtime-v3", file: "midnight_onchain_runtime_wasm_bg.wasm" },
	{ pkg: "@anastasia-labs/cardano-multiplatform-lib-nodejs", file: "cardano_multiplatform_lib_bg.wasm" },
	{ pkg: "@lucid-evolution/uplc", file: "dist/node/uplc_tx_bg.wasm" },
	{ pkg: "@emurgo/cardano-message-signing-nodejs", file: "cardano_message_signing_bg.wasm" },
];

// Some packages (e.g. @midnight-ntwrk/ledger-v8) define a restrictive
// "exports" map with no "./package.json" entry, so resolving that subpath
// directly is rejected by Node's ESM resolver. Resolving the bare package
// specifier instead (which IS in the exports map, via "node"/"browser"
// conditions) and walking up from there to the nearest package.json works
// for every package regardless of how narrow its exports map is.
function resolvePackageRoot(pkg) {
	const entryPath = fileURLToPath(import.meta.resolve(pkg));
	let dir = dirname(entryPath);
	while (true) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`Could not find package.json above ${entryPath}`);
		dir = parent;
	}
}

async function copyWasmFiles() {
	const { copyFileSync, mkdirSync } = await import("node:fs");
	const destDirs = new Set([
		dirname(cliConfig.outfile),
		dirname(allowlistTreeCliConfig.outfile),
		dirname(readTierALaunchStateCliConfig.outfile),
		dirname(buildGenesisDatumsCliConfig.outfile),
		dirname(usdToAdaCliConfig.outfile),
		dirname(mintLaunchCliConfig.outfile),
		dirname(activateCurveCliConfig.outfile),
		dirname(buyCurveCliConfig.outfile),
		dirname(sellCurveCliConfig.outfile),
		dirname(graduateLaunchCliConfig.outfile),
		dirname(graduateTierBLaunchCliConfig.outfile),
		dirname(startVestingCliConfig.outfile),
		dirname(proposeDexChangeCliConfig.outfile),
		dirname(executeDexChangeCliConfig.outfile),
		dirname(migrateLpToMinswapCliConfig.outfile),
		dirname(claimVestedCliConfig.outfile),
		dirname(claimCreatorFeesCliConfig.outfile),
		dirname(expireCurveCliConfig.outfile),
		dirname(claimBuybackCliConfig.outfile),
		dirname(readTradeHistoryCliConfig.outfile),
		dirname(checkCtoCreatorActivityCliConfig.outfile),
		dirname(checkCtoBadgeStatusCliConfig.outfile),
		dirname(verifyCtoVoterRegistrationCliConfig.outfile),
		dirname(buildDvAllocationTreeCliConfig.outfile),
		dirname(getDvAllocationProofCliConfig.outfile),
		dirname(anchorDvAllocationRootCliConfig.outfile),
		dirname(readDvPurchasesCliConfig.outfile),
		dirname(publishAllowlistRootCliConfig.outfile),
		dirname(tierBCurveActionCliConfig.outfile),
		dirname(resolveAddressVkhCliConfig.outfile),
		dirname(stakeActionCliConfig.outfile),
		dirname(tokenMetadataActionCliConfig.outfile),
		dirname(executeCtoProposalCliConfig.outfile),
		dirname(voidCtoProposalCliConfig.outfile),
		dirname(reclaimCtoRelayerBondCliConfig.outfile),
	]);
	for (const destDir of destDirs) {
		mkdirSync(destDir, { recursive: true });
		for (const { pkg, file } of WASM_FILES) {
			let src;
			try {
				src = join(resolvePackageRoot(pkg), file);
			} catch {
				console.warn(`WARNING: could not resolve package ${pkg} — a CLI bundle depending on it will fail at runtime.`);
				continue;
			}
			if (existsSync(src)) {
				copyFileSync(src, join(destDir, file.split("/").pop()));
			} else {
				console.warn(`WARNING: ${src} not found — a CLI bundle depending on it will fail at runtime.`);
			}
		}
	}
}

/**
 * A stable identifier for the set of scripts contracts/cardano/plutus.json
 * describes, injected into every bundle so a CLI can refuse a blueprint it was
 * not built for.
 *
 * THE TWIN: blueprint-fingerprint.ts computes this same value at runtime and
 * compares. Both are deliberately tiny, and blueprint-fingerprint.test.ts pins
 * the algorithm against a fixture so neither can drift silently. Change one and
 * you must change the other.
 *
 * Built from the compiler's own per-validator `hash` field, sorted by title —
 * not from the file's bytes, which differ harmlessly between a Windows checkout
 * and a Linux server by line endings alone.
 */
function blueprintFingerprint() {
	const path = join(__dirname, "..", "contracts", "cardano", "plutus.json");
	const blueprint = JSON.parse(readFileSync(path, "utf8"));
	const lines = blueprint.validators
		.map((v) => `${v.title}:${v.hash ?? ""}`)
		.sort()
		.join("\n");
	return createHash("sha256").update(lines, "utf8").digest("hex");
}

/**
 * A stable identifier for the compiled Compact ZK artifacts a governor
 * operation proves against, injected into every bundle so a CLI can refuse an
 * artifact set it was not built for.
 *
 * THE TWIN: zk-config-fingerprint.ts computes this same value at runtime and
 * compares, and zk-config-fingerprint.test.ts pins the algorithm. Change one
 * and you must change the other.
 *
 * Returns undefined when the tree is absent. That tree is gitignored (79 MB of
 * prover keys), so a fresh checkout or a CI runner legitimately has no copy,
 * and refusing to build there would be wrong. It is announced loudly rather
 * than silently, because a bundle built without it carries no guard.
 */
function zkConfigFingerprint() {
	const base = join(__dirname, "..", "contracts", "midnight", "compiled_realzk", "eligibility_gate");
	let info;
	try {
		info = JSON.parse(readFileSync(join(base, "compiler", "contract-info.json"), "utf8"));
	} catch {
		return undefined;
	}

	const canonicalise = (v) => {
		if (Array.isArray(v)) return v.map(canonicalise);
		if (v !== null && typeof v === "object") {
			const out = {};
			for (const k of Object.keys(v).sort()) out[k] = canonicalise(v[k]);
			return out;
		}
		return v;
	};

	const lines = [
		`contract-info:${createHash("sha256").update(JSON.stringify(canonicalise(info)), "utf8").digest("hex")}`,
	];
	const keysDir = join(base, "keys");
	for (const name of readdirSync(keysDir).sort()) {
		const full = join(keysDir, name);
		if (!statSync(full).isFile()) continue;
		if (name.endsWith(".verifier")) {
			lines.push(`keys/${name}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
		} else if (name.endsWith(".prover")) {
			lines.push(`keys/${name}:len=${statSync(full).size}`);
		}
	}
	return createHash("sha256").update(lines.sort().join("\n"), "utf8").digest("hex");
}

async function run() {
	const fingerprint = blueprintFingerprint();
	console.log(`blueprint fingerprint: ${fingerprint}`);
	const zkFingerprint = zkConfigFingerprint();
	if (zkFingerprint) {
		console.log(`zk config fingerprint: ${zkFingerprint}`);
	} else {
		console.warn(
			"zk config fingerprint: NOT COMPUTED — contracts/midnight/compiled_realzk/eligibility_gate " +
				"is absent, so bundles from this build carry no ZK artifact guard. Fine for a checkout " +
				"without the artifacts; not fine for a build you intend to deploy.",
		);
	}
	const configs = [
		cliConfig,
		allowlistTreeCliConfig,
		readTierALaunchStateCliConfig,
		buildGenesisDatumsCliConfig,
		usdToAdaCliConfig,
		mintLaunchCliConfig,
		activateCurveCliConfig,
		buyCurveCliConfig,
		sellCurveCliConfig,
		graduateLaunchCliConfig,
		graduateTierBLaunchCliConfig,
		startVestingCliConfig,
		proposeDexChangeCliConfig,
		executeDexChangeCliConfig,
		migrateLpToMinswapCliConfig,
		claimVestedCliConfig,
		claimCreatorFeesCliConfig,
		expireCurveCliConfig,
		claimBuybackCliConfig,
		readTradeHistoryCliConfig,
		checkCtoCreatorActivityCliConfig,
		checkCtoBadgeStatusCliConfig,
		verifyCtoVoterRegistrationCliConfig,
		buildDvAllocationTreeCliConfig,
		getDvAllocationProofCliConfig,
		anchorDvAllocationRootCliConfig,
		readDvPurchasesCliConfig,
		publishAllowlistRootCliConfig,
		deployEligibilityGateCliConfig,
		deliverDeferredCircuitsCliConfig,
		darkVeilActionCliConfig,
		deployCtoGovernanceCliConfig,
		ctoGovernanceActionCliConfig,
		buildCtoSnapshotBundleCliConfig,
		midnightRegisterDustCliConfig,
		midnightSyncWalletsCliConfig,
		buildDvAllowlistBundleCliConfig,
		buildDvRegistrantBundleCliConfig,
		tierBCurveActionCliConfig,
		resolveAddressVkhCliConfig,
		stakeActionCliConfig,
		deriveMidnightAddressCliConfig,
		midnightWalletBalanceCliConfig,
		midnightWalletBalancesCliConfig,
		tokenMetadataActionCliConfig,
		executeCtoProposalCliConfig,
		voidCtoProposalCliConfig,
		reclaimCtoRelayerBondCliConfig,
		publishReferenceScriptCliConfig,
		orderActionCliConfig,
		batchActionCliConfig,
		reclaimReferenceScriptsCliConfig,
		rebuildCapStateCliConfig,
	]
		// Stamp every bundle with the blueprint it was built against. Applied
		// here rather than on each config so a new CLI cannot be added without
		// it — the check is only worth having if nothing can opt out by
		// accident.
		.map((c) => ({
			...c,
			define: {
				...c.define,
				__BLUEPRINT_FINGERPRINT__: JSON.stringify(fingerprint),
				// The literal token `undefined` when the artifacts are absent: the
				// runtime side treats a non-string as "no build to disagree with"
				// and stays silent, the same way it does under tsx/vitest.
				//
				// The `??` is load-bearing rather than defensive. Every esbuild
				// define value must be a STRING of JavaScript to substitute, and
				// JSON.stringify(undefined) returns the value `undefined`, not the
				// text "undefined" — so without this the build throws outright on
				// any checkout that does not carry the hand-shipped ZK artifacts,
				// which is every CI run.
				__ZK_CONFIG_FINGERPRINT__: JSON.stringify(zkFingerprint) ?? "undefined",
			},
		}));

	if (watch) {
		const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
		await Promise.all(contexts.map((ctx) => ctx.watch()));
		await copyWasmFiles();
		console.log("Watching for changes...");
	} else {
		await buildAll(configs);
		await copyWasmFiles();
	}
}

/**
 * How many bundles to build at once.
 *
 * Every one of these pulls a large dependency graph — Lucid with its CML
 * WASM, Mesh with the Cardano SDK and libsodium, the Midnight SDK — and emits
 * a few megabytes of code beside a much larger source map. Building all of
 * them at once holds every one of those graphs in memory simultaneously.
 *
 * That is what it used to do, and it worked until it did not: on a GitHub
 * runner the whole job was killed part-way through the bundles, with no error
 * in the log, because the kernel had killed the process rather than Node
 * throwing. The tests had already passed; only the build died. Four at a time
 * costs some wall clock and holds a quarter of the memory.
 */
const BUILD_CONCURRENCY = 4;

/** Builds every config, a few at a time rather than all at once. */
async function buildAll(configs) {
	const queue = [...configs];
	const workers = Array.from({ length: Math.min(BUILD_CONCURRENCY, queue.length) }, async () => {
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			await esbuild.build(next);
		}
	});
	await Promise.all(workers);
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
