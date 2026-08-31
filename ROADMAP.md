# Roadmap — Noctis Zone

Rolling task list. Tracks ordered by build sequence — A must precede B, B precedes C, etc. Items within a track ship independently.

**Status tags:** `Proposed` / `In flight` / `Blocked on <X>` / `Shipped <date>` 
**Scope tags:** S = < 4h / M = < 2d / L = < 1wk / XL = > 1wk

---

## TL;DR

**Updated 2026-07-30 — a full Midnight PSM security audit plus a major test-coverage/tooling pass landed.** DUST measurement and cross-PSM atomicity / SDK availability are closed — see the Resolved table in `local/OPEN_ISSUES.md`. Two full Cardano/Aiken audit passes (an initial pass, then a follow-up full-codebase pass) and a full Midnight/Compact PSM audit (this session, ranging Critical through Low severity) are done, with real fixes and regression tests, not just findings. Contract-level work for a Cardano launch is essentially complete and hardened; what's left before mainnet is mostly external (an independent professional audit, live preprod deployment, a Midnight launch's remaining ecosystem blockers) plus finishing the WordPress front-end.

- **Track A** — WordPress public site (noctis.zone) — *in progress; mobile audit + production deploy remain; a CIP-68 on-chain logo pipeline's CONTRACT half is already built + audited (`token_metadata.ak`, 2026-07-28) with a real Lucid Evolution submitter — the WordPress-side upload/wizard-wiring/Token Profile page work is not yet built*
- **Track B** — Cardano L1 contracts (Aiken) — *built and twice-audited: 549 checks (real re-run this pass), thread-NFT-hardened CTO governance (fixed in the latest full-codebase audit pass), a `SellTokens` redeemer on the quadratic curve + CIP-68 `token_metadata.ak`*
- **Track C** — Midnight PSM contracts (Compact) — *built and audited: 8 PSMs, 280 tests, full ZK proving keys; full internal security audit (Critical through Low severity) closed 2026-07-30*
- **Track D** — Integration + API layer — *built: real Blockfrost/Midnight SDK/wallet/eligibility-checker/price-oracle code, now with real test coverage across the CLI/submitter/oracle layers (560+ tests)*
- **Track E** — Security + audit — *internal adversarial passes done across both Cardano and Midnight; independent professional audit still needed before mainnet*
- **Track F** — Midnight Launch (Midnight-native) — *still blocked on the token standard not yet being ratified, and no confirmed live graduation DEX (NorthStar DEX is a Preprod-live candidate); the trade-fee-conversion and ZK-cert-relayer questions are substantially resolved*
- **Track G** — Future multi-chain expansion (post-Midnight-live) — *proposed, not started; see below*

Suggested order (updated): **A** (finish, incl. CIP-68 pipeline) → **live preprod deployment (proof-server + ZK artifact host infra provisioning)** → **independent audit** → **mainnet** → **F** (once the token-standard and graduation-DEX blockers clear) → **G** (once the platform is stable on Cardano + Midnight).

---

## Track A — WordPress public site (noctis.zone)

The public-facing marketing and launch interface. WordPress PHP + vanilla JS. No build step.

### A1. Home page ✅
**Status:** Shipped 2026-06-09. Mobile-responsive.

Hero section, stat blocks, CTA buttons, nav, footer (Community + Protocol columns only).

---

### A2. Launches index page ✅
**Status:** Shipped 2026-06-09. Mobile-responsive.

Launch card grid, status filter tabs (dropdown on mobile), search, tier filter, sort, ZK badge modal.

---

### A3. DV Registration page ✅
**Status:** Shipped 2026-06-09. Mobile-responsive.

Registration form, eligibility checklist, allocation tracker, NIGHT bond display, countdown timer.

---

### A4. How It Works page
**Status:** Shipped (desktop). Mobile audit pending.

---

### A5. Transparency page
**Status:** Shipped (desktop). Mobile audit pending. 10 collapsible sections — wallet addresses, fee split, treasury, LP positions, rug protection, ZK certs, team, audits, changelog, open issues.

---

### A6. Create Launch wizard
**Status:** Shipped (desktop). Mobile audit pending. 6-step wizard — project info, token config, chain selection, DarkVeil settings, vesting + DEX, review + pay. **The Midnight Launch option is fully wired:** its own card, a `#cw-tier-c-config` panel, DEX field hidden (a Midnight launch has no Cardano DEX to pick), NIGHT-denominated review, pay summary showing the current launch fee. **Staking opt-in added (2026-07-14):** Step 5 gets a toggle (25% fixed allocation) + forced 3/4/5-year runway selection, live supply bar updates, review line item — same "no default" forced-choice pattern as vesting.

---

### A7. Mobile audit — How It Works, Transparency, Create Launch
**Status:** Proposed · **Scope:** M · **Touches:** `assets/css/main.css`, page templates

Complete the mobile pass on the three remaining pages. Same pattern as A1-A3.

---

### A8. Production deployment to noctis.zone
**Status:** Proposed · **Blocked on:** domain DNS setup, hosting environment · **Scope:** S

Point noctis.zone DNS to hosting. Deploy theme. Smoke test all pages on live URL. Add SSL.

---

### A9. Dynamic launch data (Blockfrost integration)
**Status:** Proposed, partially addressed for new launches · **Blocked on:** D1 (for existing/backfilled launches) · **Scope:** L

Replace mock launch data (phantom, nightshade, eclipse, void) with live data from Blockfrost + chain indexer. Launch cards populate from on-chain state, not PHP arrays. **Note (2026-07-22):** a NEW launch minted through the wizard already self-registers a real `np_launch` record via `POST /np/v1/launches/register-from-mint` — this item's remaining scope is replacing the still-mock sample launches and backfilling any launch that existed before that endpoint shipped, not the whole page.

---

### A10. CIP-68 on-chain logo pipeline + Token Profile page
**Status:** In progress — contract half built and audited, WordPress half not yet built · **Scope:** L

A mutable, creator/CTO-controlled on-chain logo (via CIP-68 reference NFT, decoupled from the platform's own time-locked minting policy — which can never re-sign, so mint-time-only metadata was never viable for a mutable logo) plus a Token Profile dashboard page for updating it and requesting Cardano Token Registry changes. **Built (2026-07-28):** `contracts/cardano/validators/token_metadata.ak` (new one-shot minting policy + spend validator, audited on its own, 5 findings fixed) and `integration/token-metadata-submitter.ts` (Lucid Evolution, builds unsigned mint/update transactions for the creator's own wallet to sign — one real bug found and fixed, a hand-rolled `Credential` schema mismatched Aiken's real encoding). **Not yet built:** image upload endpoint + Pinata IPFS pinning, banner-image storage/display (a separate, DB-stored field — not on-chain), wiring the CIP-68 mint into the Create Wizard's existing mint flow, and the Token Profile page itself (creator/CTO dashboard + Cardano Token Registry change-request queue). See local planning notes for the full phased breakdown.

---

## Track B — Cardano L1 contracts (Aiken)

**Built and audited.** 12 validators (bonding curve × 2 tiers, curve order, launch token policy, LP escrow, CTO governance + sybil challenge, vesting, staking pool, N-hop challenge, ZK anchor, token metadata), 394 checks (real re-run 2026-08-06), all compile clean (`aiken check`), `plutus.json` blueprint current. See Track E1 for audit history.

### B1. LP Escrow Contract ✅
**Status:** Shipped. 365-day LP lock, no `withdraw` ever. DEX whitelist is no longer hardcoded (resolved 2026-07-10) — a multisig-gated `ProposeDexChange` requires a 72h public notice window before `ExecuteDexChange` can apply it, replacing the original single-governor-signature design. `HarvestFees` lets ongoing trading fees reach the fee recipient without touching the locked position. `SealLock`/`Graduate` move real value, verified, not trusted. `TriggerCTO`/`DissolveCTO` redirect fee-harvest authority post-CTO-vote.

---

### B2. ZK Anchor Contract ✅
**Status:** Shipped. Receives ZK proof bundles + (for a Cardano launch) a `dv_allocation_root` Merkle root so the Cardano curve can verify DarkVeil claims without publishing the full registrant roster.

---

### B3. CTO Governance Contract ✅
**Status:** Shipped. Anchor mechanism is an open relay — any token holder can submit the anchor transaction, no platform-only relay bottleneck.

---

### B4. Bonding Curve — quadratic (Cardano Launch) and linear (legacy) ✅
**Status:** Shipped. A Cardano launch's entire public bonding curve — plus its real DarkVeil settlement via `ClaimDarkVeilTokens` — moved here from Midnight entirely, since the public phase needs no privacy and Cardano can enforce quadratic-curve payment + ADA settlement natively. `Graduate`/`ClaimBuyback`/`ExpireCurve` give every stalled or graduated curve a real resolution path. Both curves enforce the 5% wallet cap cumulatively across a whole launch — a single `cap_root` in the datum plus a Merkle proof per trade, so the datum stays a fixed size and no allowlist is needed (see the cumulative-wallet-cap note in ARCHITECTURE.md). Each curve also fits in a single published reference script, which is what makes a proof-carrying trade fit inside the transaction size limit.

---

### B5. Vesting Contract ✅
**Status:** Shipped. `vesting.ak` is shared by both Cardano curves; there was no Cardano vesting mechanism at all until it was added.

---

### B6. N-Hop Challenge Contract ✅
**Status:** Shipped. A Cardano launch only — a Sybil-registration challenge window, designed from CLAUDE.md's 5 constants (no fuller spec existed anywhere). Lives on Cardano since the ADA reporter bond can't be Midnight-native; triggers post-claim, not post-registration, for privacy reasons.

---

### B7. Staking Rewards Pool Contract (Cardano) ✅
**Status:** Shipped, then **rebuilt to run unattended.** The pool now computes what every position is owed from elapsed time using a reward-per-token accumulator, so no key, signature or published snapshot decides a payout — see the Staking Rewards Pool section in `ARCHITECTURE.md` for the mechanism and its consequences. `Graduate` on both curve contracts seeds the pool alongside LP and pins its opening datum, so a permissionless graduation cannot open a pool that credits its own submitter.

Positions moved from separate UTXOs to entries under a Merkle root in the pool datum. That is forced rather than stylistic: paying a UTXO to a script address runs no validator, so a position in its own UTXO would let its holder author the very field that decides their payout.

**Not yet exercised on a real chain** — a Preprod run of stake → claim → unstake → top-up → close is the next step, and pools created before the rebuild sit at the previous validator's address.

---

## Track C — Midnight PSM contracts (Compact)

**Built and audited.** 8 PSMs, 280 tests, full ZK proving-key generation (`compact compile`, not just `--skip-zk`). Cross-PSM atomicity and SDK availability don't gate this anymore — see the TL;DR note above. Two full internal security audits closed (an initial pass, then this session's deeper pass) — see Track E1b.

### C1. Eligibility Gate PSM (Cardano Launch — merged with DarkVeil, Phase 2) ✅
**Status:** Shipped. ZK proof verification for allowlist membership; the former standalone DarkVeil PSM (registration, NIGHT bonds, commitment/reveal buying, ratio-based bond refunds) is merged into this same file — Compact has no cross-contract call mechanism, so two contracts could never have shared one cumulative cap. Real settlement happens on Cardano instead (see B4).

---

### C2. Bonding Curve PSM (Midnight Launch — merged with Eligibility Gate + DarkVeil) ✅
**Status:** Shipped. NIGHT-denominated quadratic price discovery, 5% cap, fee routing, graduation, DarkVeil registration/buying — all one contract for the same cross-contract-call reason as C1.

---

### C3. Creator Fee Escrow PSM ✅
**Status:** Shipped, with a real architectural finding: this contract never actually holds a real fee for either launch type — a Cardano launch's accrues on the Cardano curve contract, a Midnight launch's accrues inline in C2. `depositFees` is real and tested, just never invoked in the shipped design.

---

### C4. Vesting PSM ✅
**Status:** Shipped, split out of Creator Escrow (2026-07-09) — mixing day-based vesting math with a growing fee accumulator was a real bug, not just mislabeling. Timestamps bound to real chain time (2026-07-12).

---

### C5. Treasury PSM ✅
**Status:** Shipped. ADA/NIGHT balances split (was a real bug — summed into one meaningless combined number before) with real mark-to-market floor/warning checks.

---

### C6. CTO Governance PSM ✅
**Status:** Shipped. Vote weight verified via a governor-published balance-snapshot Merkle tree ( caller-supplied weight). `hasClaimableBalance` (added 2026-07-12) gates `SilenceLockTrigger` so a zero-volume launch can't trigger a CTO vote over nothing.

---

### C7. Staking Rewards Pool PSM (Midnight Launch) ✅
**Status:** Shipped 2026-07-14, with a real architectural finding along the way: `bonding_curve.compact` never mints a Midnight launch's token as a real coin (tracked only in an internal ledger map), and Compact still has no cross-contract call mechanism — so this PSM can't take real on-chain custody of a stake the way B7 does on Cardano. Two independent verification passes confirmed `mintUnshieldedToken`/`tokenType` ARE real, executable stdlib primitives, which solves reward *minting* — the payout mints live to the staker, real NIGHT claim fee via `receiveUnshielded`/`sendUnshielded` — but not stake custody. Governor-attested stake (same trust model as the allowlist/balance-snapshot trees elsewhere) chosen over merging into the already-audited C2.

---

## Track D — Integration + API layer

**Built.** Real code against verified SDK versions, not scaffolding.

### D1. Blockfrost API client + eligibility checks ✅
**Status:** Shipped. `integration/blockfrost-client.ts` + new `integration/eligibility-checker.ts` (2026-07-12) — real off-chain wallet-age and no-direct-ADA-flow checks feeding the allowlist Merkle tree. NIGHT balance check (#2) confirmed achievable via `midnight-indexer` but not yet built; stake-key check (#4) genuinely blocked on missing cross-chain proof infrastructure.

---

### D2. Oracle price integration ✅
**Status:** Shipped. `integration/orcfax-client.ts` + `minswap-client.ts` + `night-price-oracle.ts` (2026-07-13) — real ADA/USD datum reads and NIGHT/ADA TWAP, combined into a NIGHT/USD conversion. `integration/ada-price-oracle.ts` (2026-07-14) adds the ADA-side equivalent for the staking claim fee, reusing the Orcfax client directly (no Minswap triangulation needed). None of these are wired into the live WordPress UI yet — `treasury.compact`'s floor checks and the staking claim fee both still take a pre-converted rate as an argument.

---

### D3. Wallet connection layer ✅
**Status:** Shipped, rewritten against the real `@midnight-ntwrk/dapp-connector-api@4.0.1` (2026-07-10) — `window.midnight` is a UUID-keyed dictionary, not one object; `.connect(networkId)` replaced `.enable`.

---

### D4. Midnight SDK wrapper ✅
**Status:** Shipped, `integration/midnight-client.ts` rewritten against real `@midnight-ntwrk/midnight-js-contracts@4.1.1`.

---

## Track E — Security + audit

### E1. Cardano/Aiken contract security audit ✅ (internal) / pending (independent)
**Status:** Multiple full internal adversarial passes complete, most recently a full-codebase pass (2026-07-23) — a Critical forgeable CTO-governance reference-input bug (any Cardano validator trusting `cto_governance.ak` by address alone, letting an attacker plant a fake "vote passed" datum and drain the vesting reserve) fixed via a per-launch governance thread NFT, plus a datum-schema sync fix across all four Cardano contracts. Earlier passes: a full Cardano suite pass (2026-07-19 — shared-address double-satisfaction across 5 contracts, `lp_escrow.ak` unsealed-lock/harvest drain paths, `vesting.ak`'s 100%-instant-claim exploit, `cto_governance.ak`'s fabricated-vote-anchor exploit fixed via a bonded challenge window), a cross-chain + double-satisfaction pass, and several further passes catching bare-enterprise-address payout bugs across 5 redeemers/contracts, plus a standalone audit of the new `token_metadata.ak` CIP-68 validator (2026-07-28, 5 findings fixed — most seriously a forgeable one-shot mint / unchecked reference-NFT spend). 549 Cardano checks passing (real re-run this pass). **An independent, professional audit still hasn't happened and remains required before mainnet** — internal review, however thorough, isn't a substitute.

---

### E1b. Midnight/Compact PSM security audit ✅ (internal) / pending (independent)
**Status:** Two full internal passes. An initial pass (2026-07-21, all 8 PSMs) resolved a full round of Critical/High/Medium findings across all 8 PSMs. A second, deeper adversarial pass (this session, 2026-07-30) found and fixed 1 further Critical, 4 High, and 5 Medium/Low findings, all with regression tests — see `local/SECURITY_AUDIT.md` for the full technical detail (not published here by policy). 280/280 Compact tests passing (was 214 in July). **Same session:** every `.compact`/`integration/` file gained real test coverage where it had none (`midnight-client.ts`, `indexer-client.ts`, all 4 oracle clients, all 12 highest-risk Cardano submitters, 30 of ~32 `integration/cli/*.ts` wrapper scripts), and a real win32 compile-pipeline bug was found and fixed (`bash` on Windows silently resolved to Git Bash instead of WSL, meaning the Compact recompilation step in `npm test`/CI had never actually worked end-to-end on this machine). 7 of 8 Midnight test files' bare `.toThrow()` assertions have been tightened to exact messages, catching 4 more real test-description/behavior mismatches along the way (`bonding_curve.test.ts` remains). **An independent, professional audit still hasn't happened and remains required before mainnet.**

---

### E2. Formal verification
**Status:** Not formally done as a separate mathematical proof exercise, but the properties CLAUDE.md calls out are covered by real, adversarial test coverage instead: bonding curve pricing (floor-rounding double-inequality tests), LP migration/graduation atomicity (real value-movement checks), Merkle proof soundness (tampered-proof rejection tests).

---

### E3. Preprod deployment + DUST cost measurement ✅
**Status:** Resolved (2026-07-20) after 4 real devnet attempts. A real, node-confirmed, twice-reproduced DUST cost was obtained for `registerForDarkVeil`'s most expensive path (`fees.paidFees = "1"` atomic unit) — flagged as a lower bound, not a mainnet-congestion-representative figure, since it came in lower than a much simpler contract's measured cost. **What's still open:** the proof-server and the ZK artifact static host both have deployment configs/runbooks ready but nothing actually provisioned yet — the remaining work is pure ops (stand up a VM, DNS, R2 bucket), not code.

---

### E4. Code-quality / tooling hardening (in progress)
**Status:** Started 2026-07-29 after a `midnight-cq` audit found 0 Critical / 10 Warnings / 4 Suggestions across `contracts/midnight/` and `integration/`. Done so far: `vitest.config.ts`/`tsconfig.json` added to `contracts/midnight` (its test suite had never actually run end-to-end before — see E1b's win32 compile-bug note), the full CLI-wrapper test-coverage push described in E1b, and 7 of 8 contract test files' assertions tightened. Still open: Biome config for both packages, CI workflows (`checks.yml`/`test.yml`), the remaining `bonding_curve.test.ts` tightening pass, parameterized (`it.each`) test cleanup, coverage reporting, and a root-level workspace `package.json`.

---

## Track F — Midnight Launch — partially blocked

**Updated 2026-07-12.** Two of five original blockers have real progress; two remain genuinely open.

| Topic | Question | Status |
|---|---|---|
| Token standard | Midnight fungible token standard — native layer or PSM-only? | De-risked, not resolved — `tokenType`/`mintUnshieldedToken`/`mintShieldedToken` are real, compiler-verified primitives, but the MIPs behind them (MIP-0004, MIP-0011) aren't ratified yet |
| Graduation DEX | A Midnight launch's graduation target — no confirmed live Midnight DEX | Still open — NorthStar DEX is a preprod-live candidate, mainnet timing unconfirmed |
| Fee conversion | Trade fee currency conversion (NIGHT → stablecoin) | Substantially clearer — the only bridge found is one-way (Cardano→Midnight, NIGHT-only); a bidirectional version is reportedly in development, ETA a few months |
| LP Escrow design | Midnight LP Escrow PSM design | Still blocked on the token-standard and graduation-DEX items above |
| ZK cert relayer | ZK cert relayer (Midnight → Cardano L1) | Resolved — Option B (platform relayer) built for real, including real Cardano-side transaction submission via Lucid Evolution |

Do not scaffold Midnight Launch contract work until the token-standard and graduation-DEX blockers clear. When they do, the build order is: token standard confirmation → Midnight Token PSM → Midnight LP Escrow PSM → integrate into the existing C2 merge.

---

## Track G — Future multi-chain expansion (post-Midnight-live)

**Status:** Proposed, not started. Explicitly sequenced AFTER the Midnight Launch ships and the platform has proven stable on Cardano + Midnight — not a parallel workstream, and not something to scaffold prematurely (the same discipline already applied to the Midnight Launch itself: no contract work starts until the chain in question is a confirmed, real target).

Noctis's core privacy value proposition ("they can't front-run what they can't see") depends specifically on Midnight's ZK execution layer — a launch on a different chain is only worth building if that chain offers something genuinely additive (new liquidity, new user base, a different privacy/settlement tradeoff), not privacy-launchpad parity for its own sake. Candidate chains, in no particular priority order yet:

- **XRP Ledger (XRPL)** — fast, low-fee settlement; native DEX and (via hooks/sidechains) increasingly programmable. Would need its own bonding-curve/escrow contract design — no direct code reuse from the Aiken (Cardano) or Compact (Midnight) contracts, which are chain-specific by construction.
- **Solana (SOL)** — high-throughput, large existing launchpad ecosystem (the platform's most direct multi-chain competitive comparison). Would need a full Anchor/Rust contract suite; no privacy layer equivalent to Midnight exists natively, so any DarkVeil-style private phase would need a different mechanism (e.g., a commit-reveal scheme without a real ZK layer) or would simply be omitted.

**Open questions to resolve before this track can move past "proposed":**
1. ~~How a new chain is named and presented.~~ **Answered:** a launch is named for the chain its token settles on, so these ship as a **Solana Launch** and an **XRP Launch** alongside the Cardano and Midnight ones. Both cards are already in the Create Wizard, marked "Coming later" and non-selectable. What the naming does not settle is question 3 below.
2. Fee/revenue model per new chain (native gas token launch fee + trade fee split, mirroring the ADA/NIGHT split documented in CLAUDE.md).
3. Whether DarkVeil-equivalent privacy is in scope at all for a non-Midnight chain, or whether these become public-only launches. The wizard's own copy currently promises "the same private buying phase on Midnight" on both cards, which presumes it is — that copy and this question need to be settled together before either ships.
4. Wallet integration story per chain (XRPL wallets / Solana wallet adapter) — a different integration surface from the existing Cardano (Mesh/CIP-30) + Midnight (DApp Connector) pairing.

No contract, integration, or WordPress work should start on this track until these are resolved and the Midnight Launch has shipped.

---

## Post-MVP backlog (closed as GitHub issues, tracked here instead)

Matches CLAUDE.md's own "Post-MVP: architect now, implement after launch" classification — never meant to be active pre-launch work, so these were closed as GitHub issues (2026-07-22) rather than left open indefinitely. Revisit after mainnet, not before.

- **Blockfrost compliance hook** — sanctions screening, wallet risk scoring. Architecture already supports this as a hookable module; the modules themselves are the deferred part.
- **Platform governance** — NIGHT holder voting on protocol parameters. Team controls parameters at launch with public disclosure until this ships.
- **Community-wide yield mechanism** — a single protocol-level pool NIGHT holders lock into for overall fee revenue share. Distinct from the per-launch Staking Rewards Pool (shipped — see B7/C7 above), which is narrower and already live.

---

## What we are NOT doing (anti-patterns)

- **No Next.js / React on the public site.** WordPress PHP + vanilla JS only.
- **No platform token.** Revenue in ADA and NIGHT only.
- **No partial graduation.** 100% bonding curve sell-through only — no partial.
- **No withdraw on LP.** It does not exist. Do not build a disabled version either.
- ~~**No staking infrastructure in V1.**~~ Partially superseded (2026-07-14) — this was scoped against a *platform-wide* yield mechanism (a single protocol pool NIGHT holders lock into for overall fee revenue share), which stays deferred. A narrower, *per-launch* opt-in staking rewards pool (creator-funded from that launch's own supply, not a protocol-wide mechanism) shipped instead — see B7/C7 above.
- **No Midnight Launch contract work until the token standard and graduation DEX are resolved.** The fee-conversion and ZK-cert-relayer questions have real progress (see Track F); premature scaffolding against the remaining two still creates tech debt against an unstable spec.

---

## Shipped

*(Move items here as they land with date. Keeps the active list lean.)*

### Staking Rewards Pool, every launch type (2026-07-14)
New optional per-launch feature: 25% of supply, manual staking, daily pro-rata rewards over a 3-5 year runway, $1 flat claim fee. Full spec → WordPress (every launch type, home card, How It Works, Create Wizard) → contracts (B7/C7 above) rollout in one session. The Midnight build surfaced a real architecture split from the Cardano one (governor-attested stake vs. real on-chain custody) — see C7's status note. `integration/ada-price-oracle.ts` new. 45 new tests (24 Cardano, 21 Midnight), zero regressions. Full detail in internal tracking.

### Tracks B/C/D/E — all contract, integration, and internal-audit work (2026-07-09 → 2026-07-12)
7 Cardano/Aiken validators (137 tests) + 7 Midnight/Compact PSMs (187 tests, full ZK proving keys) + real integration layer (Blockfrost, Midnight SDK, wallet connection, off-chain eligibility checks, ZK cert relayer + Cardano anchor submitter) + two internal security audit passes (11 Critical/High findings fixed) + four hardening passes. Full detail in internal tracking's issue entries and `docs/SECURITY_MODEL.md`. See the rewritten Track B/C/D/E sections above for the per-item breakdown — moved here as one consolidated entry rather than one row per issue, since that level of detail already lives in the tracking docs.

### A1 — Home page (2026-06-09)
Full desktop + mobile implementation. Nav (logo, links, wallet connect, hamburger on mobile), hero (Noctis logo above heading on mobile, stat blocks, CTA buttons), features section, footer (Community + Protocol columns). Mobile-responsive.

### A2 — Launches index page (2026-06-09)
Launch card grid with status indicators, tier badges, progress bars, ZK certificate modal. Filter bar: status filter (tabs on desktop, dropdown on mobile), search, tier filter, sort. Mobile-responsive.

### A3 — DV Registration page (2026-06-09)
Full layout: registration form, eligibility checklist, allocation tracker, NIGHT bond display, timer. Mobile layout stacked vertically with doubled placeholder logo. Mobile-responsive.

### A5 — Transparency page — Midnight Launch added (2026-06-09)
Midnight Launch section added: DUST/NIGHT stats, active Midnight launches table, PSM status. Stats grid updated to 9 launches. ZK cert description updated for the Midnight relayer. Ops wallet text updated for launch fee split percentage + NIGHT receipt.

### A6 — Create Launch wizard — Midnight Launch (2026-06-09)
Midnight Launch card (violet) added. Config panel for Midnight-native launches. DEX selection hidden — a Midnight launch has no Cardano DEX to pick. Pay summary shows current launch fee split (40% ops / 60% treasury). JS fully wired.

### A — Midnight Launch sample launches × 4 (2026-06-09)
Four Midnight Launch mock launches live: Abyss ($ABYS, DV Active), Spectre ($SPCT, DV Active), Cipher ($CPHR, DV Registration), Nocturne ($NTRN, DV Registration). Full detail pages with NIGHT-denominated UI. Appear on Launches page and in DarkVeil nav dropdown.

### A — DarkVeil page sample shortcuts (2026-06-09)
Bottom CTA section redesigned to show 3 sample cards per state group (Registration + Active). Cardano and Midnight samples side by side.

### A — Nav dropdown — DarkVeil grouped shortcuts (2026-06-09)
DarkVeil nav item expanded to 6 items in two labelled groups (REGISTRATION OPEN / DARKVEIL ACTIVE). Midnight Launch items violet-tinted. Mobile menu updated to match.

### Offline preview builder — updated (2026-06-09)
`build-offline.py` now covers 12 pages (added 4 Midnight Launch pages). Output `noctis-preview.html` is 3,573 KB. Originally shipped as 8-page builder on 2026-06-09; `build-offline.py` — Python script that fetches pages from local dev server, inlines all local CSS/JS/images as base64 data URIs, outputs single self-contained HTML file using site nav for page switching via postMessage.
