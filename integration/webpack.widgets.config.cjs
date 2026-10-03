// ============================================================================
// Noctis Zone — Webpack config for browser widget bundles ONLY.
// ============================================================================
// (found 2026-07-16, re-confirmed + root-caused 2026-07-17): esbuild's
// `loader: {'.wasm':'file'}` cannot correctly link wasm-bindgen's
// `--target bundler` output (the format @anastasia-labs/cardano-
// multiplatform-lib-browser, @lucid-evolution/uplc, and
// @emurgo/cardano-message-signing-nodejs/-browser all ship). Confirmed by
// direct stack-trace debugging (headless Chrome): esbuild's 'file' loader
// turns a `.wasm` import into an opaque URL STRING rather than an
// instantiated module namespace object, so the glue code's own
// `wasm.__wbindgen_start()` call resolves `wasm` to that string, `.
// __wbindgen_start` to `undefined`, and calling it throws
// "(void 0) is not a function" before the IIFE ever assigns the widget's
// window global. Externally corroborated
// (wasm-bindgen's own docs/GitHub discussions): webpack is the only bundler
// with real, native support for this exact output shape
// (experiments.asyncWebAssembly below) — not a esbuild misconfiguration on
// this project's part, a genuine capability gap.
//
// Scope: ONLY the browser widget bundles build with webpack. Every
// Node-platform CLI bundle (integration/build.mjs's configs) stays on esbuild — this issue is specific to wasm-bindgen
// bundler-target output consumed by a BROWSER build; the same packages'
// Node/CJS WASM loading (readFileSync-relative-path, copied via build.mjs's
// copyWasmFiles()) was never affected.
// ============================================================================

const os = require("node:os");
const path = require("node:path");
const webpack = require("webpack");

// Same opt-in as integration/build.mjs: `NOCTIS_SOURCEMAPS=1 npm run
// build:widgets` when a stack trace needs to point at a real line, off
// otherwise. These four bundles are the ones that ship inside the theme, so
// their maps are the ones that get deployed to the host and read on backup.
const devtool =
	process.env.NOCTIS_SOURCEMAPS === "1" ? "source-map" : false;

// Active Local site. `Local Sites/noctis` is ARCHIVED as of 2026-08-03 — it
// sits on the theme commit that went live on 2026-07-30, several commits
// behind. Building into it is silent: the bundle is produced successfully and
// simply never reaches the running site.
//
// The site lives under this machine's own LocalWP root, so the path is
// derived from the home directory rather than written out, and
// NOCTIS_THEME_JS_DIR overrides it for a site that lives anywhere else.
const THEME_JS_DIR =
	process.env.NOCTIS_THEME_JS_DIR ||
	path.join(
		os.homedir(),
		"Local Sites",
		"noctis-new-theme-test",
		"app",
		"public",
		"wp-content",
		"themes",
		"noctis",
		"assets",
		"js",
	);

// webpack 5 (unlike webpack 4) does NOT auto-polyfill Node globals for a
// target:'web' build. Found the hard way (real runtime ReferenceError,
// after fixing the isomorphic-ws issue above): some Midnight transitive
// dependency references the bare `process` global (Node-only) somewhere in
// its own module init path. `process/browser` (npm's real, standard
// browser-safe shim — the same one webpack 4 used to auto-inject) covers
// it via ProvidePlugin.
const providePlugin = new webpack.ProvidePlugin({
	// Absolute path, not the bare 'process/browser' specifier — that bare
	// form failed to resolve from inside some transitive deps' own nested
	// module context ("Can't resolve 'process/browser'" from effect's
	// internal/clock.js and others, even though node_modules/process/
	// browser.js genuinely exists at this project's root) — an absolute path
	// sidesteps whatever resolution-context mismatch caused that.
	process: require.resolve("process/browser.js"),
});

/** @type {import('webpack').Configuration[]} */
module.exports = [
	{
		name: "darkveil-widget",
		entry: path.resolve(__dirname, "widget/darkveil-widget-entry.ts"),
		output: {
			path: THEME_JS_DIR,
			filename: "darkveil-widget.bundle.js",
			// Real-file WASM assets emitted alongside the bundle need a real,
			// fetchable relative URL at runtime — same requirement esbuild's
			// 'file' loader satisfied for the CBOR-encoding side of things
			// (only the wasm-bindgen *linking* was ever broken, not asset
			// serving), so keep asset output next to the JS the same way.
			webassemblyModuleFilename: "[hash].wasm",
			clean: false, // don't wipe THEME_JS_DIR — other unrelated built assets already live there.
		},
		mode: "production",
		target: "web",
		// The real fix: webpack's native async WASM module support correctly
		// instantiates a wasm-bindgen bundler-target module and provides its
		// real exports object, which the glue JS's own top-level
		// `wasm.__wbindgen_start()`-style calls then resolve correctly.
		experiments: { asyncWebAssembly: true },
		resolve: {
			// This codebase's own .ts sources use explicit `.js` import
			// extensions (real ESM/Node convention, already used everywhere in
			// integration/) — ts-loader alone doesn't resolve those back to the
			// real .ts files; extensionAlias (webpack 5) does.
			extensionAlias: { ".js": [".ts", ".js"] },
			extensions: [".ts", ".js"],
			alias: {
				// Real upstream/bundler-interop mismatch found while getting this
				// bundle to compile under webpack — see isomorphic-ws-shim.js's own
				// header for the full story (@midnight-ntwrk/midnight-js-indexer-
				// public-data-provider imports a named `WebSocket` export
				// isomorphic-ws's real browser.js never provides).
				"isomorphic-ws$": path.resolve(
					__dirname,
					"widget/isomorphic-ws-shim.js",
				),
			},
			// No Mesh here. The DarkVeil claim, the one thing this widget once
			// reached Mesh through, is its own bundle now (darkveil-claim-widget
			// below), and neither of the two bundles built from this
			// configuration reaches it. An import that does will fail the build
			// on Mesh's node:crypto, which is the point: give it the claim
			// widget's stand-ins and load it on demand, as that one does.
		},
		plugins: [providePlugin],
		module: {
			rules: [
				{
					test: /\.ts$/,
					use: {
						loader: "ts-loader",
						options: {
							transpileOnly: true, // type-checking already happens separately via `npm run typecheck`
							compilerOptions: {
								module: "esnext",
								target: "es2020",
								moduleResolution: "bundler",
							},
						},
					},
					exclude: /node_modules/,
				},
			],
		},
		devtool,
	},
	{
		// Cardano Launch order widget (2026-08-27) — placing an order is an
		// ordinary payment, so unlike the three spend widgets this needs no
		// Mesh alias block: its whole import graph is Lucid Evolution plus
		// pure local modules. Same webpack requirement as the others (Lucid's
		// CML/WASM dependency).
		name: "curve-order-widget",
		entry: path.resolve(__dirname, "widget/curve-order-widget-entry.ts"),
		output: {
			path: THEME_JS_DIR,
			filename: "curve-order-widget.bundle.js",
			webassemblyModuleFilename: "[hash].wasm",
			clean: false,
		},
		mode: "production",
		target: "web",
		experiments: { asyncWebAssembly: true },
		resolve: {
			extensionAlias: { ".js": [".ts", ".js"] },
			extensions: [".ts", ".js"],
		},
		plugins: [providePlugin],
		module: {
			rules: [
				{
					test: /\.ts$/,
					use: {
						loader: "ts-loader",
						options: {
							transpileOnly: true,
							compilerOptions: {
								module: "esnext",
								target: "es2020",
								moduleResolution: "bundler",
							},
						},
					},
					exclude: /node_modules/,
				},
			],
		},
		devtool,
	},
	{
		// Staking UI (2026-07-22) — same webpack requirement as the other
		// three (Lucid Evolution's CML/WASM dependency).
		name: "staking-widget",
		entry: path.resolve(__dirname, "widget/staking-widget-entry.ts"),
		output: {
			path: THEME_JS_DIR,
			filename: "staking-widget.bundle.js",
			webassemblyModuleFilename: "[hash].wasm",
			clean: false,
		},
		mode: "production",
		target: "web",
		experiments: { asyncWebAssembly: true },
		resolve: {
			extensionAlias: { ".js": [".ts", ".js"] },
			extensions: [".ts", ".js"],
		},
		plugins: [providePlugin],
		module: {
			rules: [
				{
					test: /\.ts$/,
					use: {
						loader: "ts-loader",
						options: {
							transpileOnly: true,
							compilerOptions: {
								module: "esnext",
								target: "es2020",
								moduleResolution: "bundler",
							},
						},
					},
					exclude: /node_modules/,
				},
			],
		},
		devtool,
	},
];

// The NoctisSwap trading panel (2026-09-08) — the venue's placer side. Like
// the curve's order widget it needs no Mesh alias block: placing an order is
// an ordinary payment and cancelling carries a 3.4 KB validator, so its whole
// import graph is Lucid Evolution plus pure local modules. The venue's fill,
// batcher and collection modules ARE built on Mesh, and none of them is
// reachable from this entry — which is what keeps a browser structurally
// unable to touch a pool.
module.exports.push({
	...module.exports[1],
	name: "venue-swap-widget",
	entry: path.resolve(__dirname, "widget/venue-swap-widget-entry.ts"),
	output: {
		...module.exports[1].output,
		filename: "venue-swap-widget.bundle.js",
	},
});

// The creator-fee widget (2026-09-30) claims a Cardano Launch's curve fees
// from the creator's own wallet. A curve spend references its validator, and
// that path builds with Mesh, so unlike every bundle above this one carries
// Mesh in the browser. The dashboard loads it only when a claim is made.
//
// Mesh expects three things from Node that a web build does not have, and
// each is supplied here rather than for every widget:
//   - `Buffer`, as a global, from the `buffer` package;
//   - `crypto`, for random bytes (and pbkdf2Sync, which refuses: a browser
//     claim never derives a key) — widget/node-crypto-shim.js;
//   - `stream`, which only the `cbor` package asks for, inside a provider the
//     claim never builds. It still has to load — widget/node-stream-shim.js.
module.exports.push({
	...module.exports[1],
	name: "creator-fee-widget",
	entry: path.resolve(__dirname, "widget/creator-fee-widget-entry.ts"),
	output: {
		...module.exports[1].output,
		filename: "creator-fee-widget.bundle.js",
	},
	resolve: {
		...module.exports[1].resolve,
		fallback: {
			crypto: path.resolve(__dirname, "widget/node-crypto-shim.js"),
			stream: path.resolve(__dirname, "widget/node-stream-shim.js"),
		},
	},
	plugins: [
		...module.exports[1].plugins,
		new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
	],
});

// The DarkVeil claim widget (2026-10-04) settles a buyer's DarkVeil allocation
// on the Cardano curve, from their own wallet. A curve spend references its
// validator, and that path builds with Mesh, so it is the creator-fee widget's
// configuration with a different entry and filename. The claim page loads it
// only when a buyer presses Claim; the DarkVeil widget itself stays free of
// Mesh, which would otherwise ride on every DarkVeil page.
module.exports.push({
	...module.exports.find((c) => c.name === "creator-fee-widget"),
	name: "darkveil-claim-widget",
	entry: path.resolve(__dirname, "widget/darkveil-claim-widget-entry.ts"),
	output: {
		...module.exports[1].output,
		filename: "darkveil-claim-widget.bundle.js",
	},
});

// The CTO governance widget shares every build concern the DarkVeil widget
// has (same SDK, same wasm, same shims) and differs only in its entry, so it
// is that configuration with a different entry and filename.
module.exports.push({
	...module.exports[0],
	name: "cto-widget",
	entry: path.resolve(__dirname, "widget/cto-widget-entry.ts"),
	output: { ...module.exports[0].output, filename: "cto-widget.bundle.js" },
});

// The creator-identity widget (2026-09-22) runs on the create page, after a
// mint. It shares the DarkVeil widget's whole build story — the same private
// state store, the same Midnight SDK, the same wasm — because it derives the
// same identity under the same domain, which is the only reason the value it
// collects means anything to the gate. So it is that configuration with a
// different entry and filename.
module.exports.push({
	...module.exports[0],
	name: "creator-identity-widget",
	entry: path.resolve(__dirname, "widget/creator-identity-widget-entry.ts"),
	output: {
		...module.exports[0].output,
		filename: "creator-identity-widget.bundle.js",
	},
});

// The takeover vote's Cardano steps (2026-09-30): recording a finished vote,
// executing it, applying it to the launch's contracts and reclaiming the bond,
// each signed by the holder's own wallet. They build with Mesh, like the
// creator-fee widget, so this is that configuration with a different entry and
// filename. The takeover-vote panel loads it only when those steps are opened;
// voting on Midnight stays in cto-widget.
module.exports.push({
	...module.exports.find((c) => c.name === "creator-fee-widget"),
	name: "cto-cardano-widget",
	entry: path.resolve(__dirname, "widget/cto-cardano-widget-entry.ts"),
	output: {
		...module.exports[1].output,
		filename: "cto-cardano-widget.bundle.js",
	},
});
