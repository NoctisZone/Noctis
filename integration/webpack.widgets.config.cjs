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
// "(void 0) is not a function" before the IIFE ever assigns
// window.NoctisDarkVeil / window.NoctisTierABuy. Externally corroborated
// (wasm-bindgen's own docs/GitHub discussions): webpack is the only bundler
// with real, native support for this exact output shape
// (experiments.asyncWebAssembly below) — not a esbuild misconfiguration on
// this project's part, a genuine capability gap.
//
// Scope: ONLY the 2 browser widget bundles (DarkVeil, the linear curve buy) move to
// Webpack. Every Node-platform CLI bundle (integration/build.mjs's other
// configs) stays on esbuild — this issue is specific to wasm-bindgen
// bundler-target output consumed by a BROWSER build; the same packages'
// Node/CJS WASM loading (readFileSync-relative-path, copied via build.mjs's
// copyWasmFiles()) was never affected.
// ============================================================================

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
const THEME_JS_DIR =
	"C:/Users/kruge/Local Sites/noctis-new-theme-test/app/public/wp-content/themes/noctis/assets/js";

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
				// Mesh signs with a mnemonic or a stored private key, which is a
				// server-side path by definition — the curve submitter refuses a
				// browser wallet for it explicitly, and only ever loads these
				// behind a `referenceScript` pointer no browser caller sets.
				//
				// Saying so here as well is what keeps it out of the bundle. A
				// dynamic import defers WHEN a module loads; it does not remove
				// it from the build, so webpack still had to resolve Mesh's own
				// node:crypto and node:stream dependencies for the async chunk,
				// and for a `target: "web"` build it cannot.
				//
				// `false` resolves to an empty module. If this path were ever
				// reached from the browser it would throw on the first
				// constructor rather than misbehave quietly.
				"@meshsdk/core": false,
				[path.resolve(__dirname, "key-curve-spend-wallet.ts")]: false,
				[path.resolve(__dirname, "mesh-curve-spend.ts")]: false,
			},
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
		name: "tier-a-buy-widget",
		entry: path.resolve(__dirname, "widget/tier-a-buy-widget-entry.ts"),
		output: {
			path: THEME_JS_DIR,
			filename: "tier-a-buy-widget.bundle.js",
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
		name: "tier-a-dashboard-widget",
		entry: path.resolve(__dirname, "widget/tier-a-dashboard-widget-entry.ts"),
		output: {
			path: THEME_JS_DIR,
			filename: "tier-a-dashboard-widget.bundle.js",
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
