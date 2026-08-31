# NOCTIS ZONE — CLAUDE INSTRUCTION DOCUMENT
**Version 1 · For use with Claude in VS Code**

---

## HOW TO USE THIS FILE

Place this file as `CLAUDE.md` in the root of your Noctis project repository. The Claude VS Code plugin reads this file automatically and uses it as persistent context across all conversations in the project. Every session starts with the full platform spec loaded — you do not need to re-explain decisions already made.

When starting a new task, refer Claude to the relevant section. Example prompts:
- *"Using the spec in CLAUDE.md, build the DarkVeil registration page component"*
- *"Referring to the fee split in CLAUDE.md, build the revenue dashboard"*
- *"The treasury PSM spec is in CLAUDE.md — scaffold the contract interface"*

---

## REPOSITORY HYGIENE — HARD RULE (no exceptions)

This repository is **public**. Nothing that could function as a roadmap for an attacker, and nothing that only makes sense as an internal work-tracking artifact, ever gets committed here — not in a doc, not in a code comment, not in a commit message.

**Never commit or push to this repo:**
- Internal issue-tracker IDs of any shape (`T24`, `MN-6`, `T-AUDIT`, `C-1`, or any future numbering/lettering scheme) — these identify entries in a local tracker that itself must never be public.
- Exploit-mechanism detail — step-by-step attacker sequences, cost/benefit calculus for an attack, or named techniques with mechanics spelled out. Public docs get a factual "what was fixed" statement; the reasoning and reproduction detail stay local.
- Chronological/historical development detail beyond what a released version needs (see CHANGELOG.md's own convention below).
- Secrets, credentials, private keys, mnemonics, or anything secret-shaped — even in a test fixture or comment.

**Where that content actually lives instead** (all gitignored under `/local/`, never published, available to auditors/partners on request):
- `local/OPEN_ISSUES.md` / `local/FLAGGED_ISSUES.md` — the real internal issue tracker, T/D/MN numbering and all
- `local/SECURITY_AUDIT.md` — full audit trail: findings, severity, reproduction detail, fixes
- `local/CHANGELOG.md` — full chronological development history (the public `CHANGELOG.md` only gets release-level entries going forward, no internal detail)

**Keep the local trackers current.** Every time a real issue is opened, fixed, or a security finding is made, it goes in the relevant `local/` file — that's the actual history; don't let it exist only in conversation. The public repo should never be the only place a decision's reasoning is written down, but it should also never be a place that reasoning leaks to.

**Before every commit or push to this repo:** re-check the diff against the rules above. This isn't a one-time cleanup — it applies to every future commit, not just the historical ones already scrubbed.

### THE COMPOSITION RULE — the one that actually keeps slipping through

Individually-harmless statements become a roadmap when combined. The pattern to watch for, in **both code comments and commit messages**:

> *"Here is how this weakness works"* **+** *"here is where it is still open"* = **an attacker's starting point.**

Each half looks fine in isolation. A security comment explaining what a check defends is normal and good. A note about remaining scope is normal and good. **Together, in the same commit, they say: this specific contract has this specific hole, right now.** That is exactly what must never be public.

**The rule, no exceptions:**

1. **Never state that a weakness is currently unfixed, unmitigated, or partially fixed** — not in a comment, not in a commit message, not in a file header, not in a scope note. No "still not enforced", no "X is not included in this change", no "deliberately not addressed here", no listing which validators/files a fix skipped.
2. **Explaining a mechanism is only acceptable when the same commit closes it.** Describe the *guarantee the code now makes*, not the gap it used to leave. Prefer "this policy can mint exactly once" over "previously the key holder could mint for four hours".
3. **Scope notes go in `local/` only.** A commit may say what it *does*; it must not enumerate what it leaves undone in security terms. "Wiring X is the remaining half" is fine — it names work, not a hole. "X still trusts an unauthenticated datum" is not.
4. **Never name the specific files, contracts, or redeemers a security fix did not cover.** That is a target list.

**Assume every commit is read by someone looking for a way in.** The test is not "is this sentence true" — it is "does this commit tell a stranger where to attack, and confirm nobody is guarding it yet".

Full detail — mechanics, reproduction, which items remain open and where — belongs in `local/SECURITY_AUDIT.md` and the `local/` trackers. That is what they are for. **Do not wait to be asked to apply this.**

---

## PROJECT OVERVIEW

**Platform name:** Noctis 
**Tagline:** They can't front-run what they can't see. 
**Type:** Token launchpad built on Midnight Network — the private buying phase is Midnight on every launch, whichever chain the token settles on 
**Chains:** Midnight Network (private execution, every launch) + the settlement chain the creator picks — Cardano L1 today; Solana and XRP announced 
**Status:** Design complete. Moving to build phase. 
**Version:** Whitepaper v1 / Spec v1 

Noctis is a token launchpad built on **Midnight Network**. DarkVeil — the private registration and buying phase — runs on Midnight for **every** launch, whichever chain the token settles on. That is the product: Midnight is the privacy engine, not one of two chains.

The settlement chain is the creator's choice, and a launch is named for it. A **Cardano Launch** settles the public quadratic curve, escrow and LP on Cardano L1 — the first venue built, and the proof of the concept. A **Midnight Launch** is fully Midnight-native: the token, bonding curve, DarkVeil phase and LP all live on Midnight, with Cardano used only for the ZK anchor certificate. **Solana Launch** and **XRP Launch** are announced, not built.

There is **no platform token**. Revenue flows in ADA and NIGHT only.

---

## TECH STACK

> ⚠️ **OPEN ISSUES:** Two pieces of the stack below are still genuinely unbuilt — see the callouts under Cardano L1. Everything else in this section reflects what's actually running today, not a recommendation.

### Frontend
- **Platform:** WordPress (PHP 8.x), custom theme, vanilla JS — no build step, no Next.js/React/npm, by design
- **Wallet connection:** Weld Cardano (the `weldpress` plugin) — CIP-30 wallet connectivity and transaction signing
- **Theme:** Dark background (`#121212`), blue accent (`#2D3FFF`, Midnight/DarkVeil/buttons/progress), violet accent for Midnight Launch (`#8844DD`), green for ZK cert badges (`#5fb51b`); Montserrat (headings) / Inter (body)

### Cardano L1 (Smart Contracts)
- **Language:** Aiken
- **Indexer:** Blockfrost API (primary, real and live). Failover is **partial**, not absent (corrected 2026-08-02 — this line previously claimed "no fallback client exists yet," which was wrong): a real `koios-client.php` exists in the plugin and is used for chain-tip health, `account_assets`, and `account_info` (the Settings page surfaces it as "Not set — Koios fallback active", and there is a `np/v1/health/koios` route). What is genuinely still **open**: that fallback is PHP-side only and covers account reads only — the TypeScript `integration/` layer has no failover of any kind, and **Maestro is unimplemented**. A Blockfrost outage still breaks every TS submitter path.
- **Transaction building:** Anvil API for standard transactions; **`@lucid-evolution/lucid`** (Anastasia Labs) for custom-redeemer Plutus script spends, which Anvil cannot do. ⚠️ **Supply-chain watch item (2026-08-02):** the original Lucid Evolution core developers have left to form No Witness Labs and are building a separate, ground-up successor — **Evolution SDK** (`@evolution-sdk/evolution`, IntersectMBO-incubated, pure TypeScript, no WASM/CML). Our package remains actively maintained by Anastasia Labs — 0.6.0 (2026-07-16), 0.6.1 (2026-08-09), 0.6.2 (2026-08-13), no deprecation notice — so **no migration now**. Both re-evaluation triggers were re-checked against the registry on 2026-08-21 and **neither has fired**: Evolution SDK is still 0.5.12, and three releases in four weeks is not a stalled cadence. Institutional momentum still sits with the successor, and migration would be a near-total call-site rewrite across **83 files** — 33 in `integration/`, 34 tests, 11 CLI entry points, 5 in the widget. Re-evaluate when Evolution SDK 2.0 ships or if Anastasia's release cadence stalls. **We run `^0.5.5`, resolving 0.5.6**: a caret on a `0.x` version cannot cross a minor, so 0.6.x is a deliberate step rather than something `npm update` will take. It is planned before the security audit — the audited code should be the shipped code — and gated on re-running the Cardano Preprod lifecycle, because 0.6.0 changed wallet UTxO-override semantics and moved slot configuration per-instance, which are the two things our submitters lean on hardest. **Do NOT install `@evolution-sdk/lucid`** — despite the high version number (2.0.1) it has only ever had two releases, both in July 2025, and a No Witness Labs fork README actively instructs people to install it.
- **Price oracle:** Orcfax (ADA/USD only — no NIGHT feed on mainnet, see ORACLE STRATEGY), Minswap (NIGHT/ADA, TWAP computed client-side) — both real and live
- **DEX integration:** CSwap (primary graduation DEX), Minswap, Splash, WingRiders and SundaeSwap are whitelisted by name in `lp_escrow.ak` — real DEX integration (swap execution, pool seeding, fee-harvest client) is still **open**: no real client exists for any of them yet. **Survey done 2026-08-02** — no general-purpose library solves this; it stays per-DEX work against each DEX's own contracts. Real starting points if/when this is built: `@minswap/sdk` (actively maintained, real swap/pool transaction building with a Blockfrost adapter), `SundaeSwap-finance/sundae-contracts` (Aiken source — a readable reference for how a production CPP-AMM models pools and staking rewards), and `@indigo-labs/dexter` (multi-DEX TS SDK — **reference only, do not adopt**: last published 2025-01, and its Lucid provider targets the *original* Lucid, not Lucid Evolution). **CSwap — our own primary graduation DEX — has no public SDK found by any search**, which makes it the hardest of the four and worth confirming directly with the CSwap team before committing to it as the default.

### Midnight Network (PSM Contracts)
- **Language:** Compact
- **Framework:** Midnight SDK
- **ZK proofs:** Generated client-side by wallet software using Midnight proof generation libraries

> ⚠️ **OPEN ISSUE:** Cross-PSM atomicity between DarkVeil PSM and Bonding Curve PSM requires confirmation from Midnight engineering before finalising contract architecture. Specifically: does Midnight guarantee atomic state commitment across two separate PSM instances within the same transaction or block? If YES — settlement window can be minimal. If NO — a 10-minute settlement window must be built in between DarkVeil close and public curve open. Default to 10-minute window in all code until confirmed. **Confirmed 2026-07-09 at the SDK level:** `@midnight-ntwrk/midnight-js-contracts`'s only transaction-batching primitive (`withContractScopedTransaction`) is parameterized by a single contract type and cannot batch calls across two different PSMs — the 10-minute settlement window isn't just a conservative default, it's currently the only implementable option regardless of what Midnight engineering eventually confirms at the protocol level. This is also why Cardano Launch's public bonding curve moved to Cardano/Aiken entirely rather than staying a second Midnight PSM needing this same cross-PSM handoff (see the Bonding Curve PSM scope note under Contract Architecture).

---

## PLATFORM CONSTANTS

These values are confirmed and should be treated as constants throughout the codebase.

```
TOTAL_SUPPLY = 1_000_000_000 // 1B tokens, hard cap
LP_RESERVE_PCT = 20 // % of total supply, platform-fixed (raised from 15 on 2026-08-04 — see LP SEEDING)
CURVE_BASE_PRICE_LOVELACE = 3 // Price of the first token, so this sets the STARTING market cap:
                              // 3 × TOTAL_SUPPLY = 3,000 ADA, a 25× ride to graduation. snek.fun runs
                              // 2,550 → 69,000 = 26×, so the two are aligned. Never 0 — a zero base
                              // makes the first buy free
CURVE_MAX_PRICE_LOVELACE = 75 // Price at full sell-through, so this sets the graduation FDV outright
GRAD_FDV_DEFAULT_ADA = 75_000 // = CURVE_MAX_PRICE_LOVELACE × TOTAL_SUPPLY. Default, not a cap — both
                              // prices are overridable per launch. The linear curve then raises
                              // ~28,500 ADA and the quadratic one ~19,100. snek.fun graduates at 69,000 ADA, so this sits just above
CREATOR_ALLOC_MAX = 10 // % max, platform-enforced
CREATOR_ALLOC_REC = 5..8 // % recommended range
DV_ALLOC_DEFAULT = 15 // % DarkVeil allocation, creator-adjustable
DV_ALLOC_MIN = 10 // % minimum
DV_ALLOC_MAX = 20 // % maximum
WALLET_CAP_PCT = 5 // % per-wallet cap across DV + public combined
NIGHT_BOND_USD = 50 // USD worth of NIGHT required for DV registration
WALLET_AGE_DAYS = 90 // Minimum wallet age for DV registration
DV_REGISTRATION_HRS = 48 // Registration window duration
DV_FREEZE_HRS = 2 // Hours before DV open that registration freezes
DV_BUYING_HRS = 24 // DarkVeil buying window duration
DV_REVEAL_WINDOW_DAYS = 30 // Days after DarkVeil closes a buyer has to reveal their commitment (security audit finding, 2026-07-30, Cardano Launch only) — after this, revealBuyCommit rejects the commitment; unrevealed bonds/tokens are not separately recoverable by this window alone (see claimBondRefund/claimRatioBondRefund for the existing DarkVeil-failure/partial-purchase refund paths, which are independent of this deadline)
MIN_DV_PARTICIPANTS = 15 // Minimum absolute registrant count before buying opens (2026-07-13) — below this, DarkVeil cancels and the launch falls back to public-only
SETTLEMENT_WINDOW = 10 // Minutes between DV close and public curve open (default — see the Cross-PSM Atomicity open issue)
MAX_CURVE_DURATION_DAYS = 90 // Max days a bonding curve can sit Active without reaching Graduated before anyone can force-cancel it (default — force-cancellation is the permissionless `ExpireCurve` mechanism)
VESTING_MIN_DAYS = 90 // Minimum creator vesting
VESTING_MAX_DAYS = 365 // Maximum creator vesting
STAKING_ALLOC_PCT = 25 // % of total supply, optional per-launch toggle (2026-07-14) — fixed, not a creator-adjustable range
STAKING_DURATION_MIN_DAYS = 1095 // Minimum staking pool runway (3 years) — creator must actively select, no default
STAKING_DURATION_MAX_DAYS = 1825 // Maximum staking pool runway (5 years)
STAKING_BONDING_PERIOD_DAYS = 7 // A newly-staked position earns nothing until seasoned this long — anti-gaming, enforced off-chain via the governor's snapshot formula
STAKING_CLAIM_FEE_USD = 1 // Flat USD fee to claim accrued rewards — ADA (Cardano) or NIGHT (Midnight) at oracle spot price
// The whole claim fee goes to the single platform wallet. Every REVENUE
// stream does: no launch fee, trade fee, forfeited DarkVeil bond or claim
// fee is split (2026-08-06). Slashed CHALLENGE bonds are the exception and
// are still split 60/40 to separate treasury/ops addresses — see the
// Challenge Bond Slashing note under TEAM REVENUE SOURCES.
LP_LOCK_DAYS = 365 // LP escrow lock duration
LP_MIGRATION_COOLDOWN= 90 // Days between LP migrations
CTO_MIN_DAYS_POSTGRD = 90 // Minimum days post-graduation before CTO vote (raised from 30, anti-whale-takeover fix, 2026-07-28 — see CTO GOVERNANCE section)
CTO_MAX_VOTER_CAP_PCT = 1 // % of total supply, absolute per-voter vote-weight cap — UNIFORM across every voter including the creator (was creator-only 2%); anti-whale-takeover fix, 2026-07-28
CTO_MIN_VOTER_COUNT = 15 // Minimum distinct voters required for quorum to count, alongside the 5% weight threshold; anti-whale-takeover fix, 2026-07-28
CTO_MIN_HOLDING_PERIOD_DAYS = 30 // Minimum time a balance-snapshot leaf's held-since timestamp must predate a proposal's start before that balance counts toward a vote; anti-whale-takeover fix, 2026-07-28
CTO_VOTE_WINDOW_HRS = 72 // CTO ballot window
CTO_QUORUM_PCT = 5 // % of total supply required to reach quorum
CTO_COOLDOWN_DAYS = 90 // Cooldown after any CTO vote
SILENCE_LOCK_DAYS = 90 // Creator silence before CTO can claim escrow
SILENCE_REMINDER_1 = 60 // Day of first reminder
SILENCE_REMINDER_2 = 80 // Day of final reminder
EMERGENCY_EXIT_DAYS = 180 // Platform unreachability before emergency exit
ORACLE_DIVERGENCE_MAX= 5 // % max divergence between Orcfax and Minswap TWAP
ORACLE_STALENESS_MIN = 10 // Minutes before Orcfax datum considered stale
NHOP_CHALLENGE_BOND = 25 // ADA bond for N-hop challenge submission
NHOP_MAX_HOPS = 5 // Maximum hops in N-hop challenge path
NHOP_LOOKBACK_DAYS = 180 // N-hop lookback window
NHOP_WINDOW_HRS = 72 // Challenge submission window after registration
NHOP_DEFENCE_HRS = 24 // Registrant defence window after challenge
SOCIAL_MIN_AGE_DAYS = 30 // Minimum age of project social accounts
LAUNCH_FEE_USD = 10 // Flat launch fee, the same on every launch type (USD — paid in
                    // ADA or NIGHT equiv., converted at the LIVE rate; see ORACLE STRATEGY).
                    // Paid whole to the platform wallet. Replaced the per-tier
                    // TIER_{A,B,C}_FEE_USD and the six OPS/TREASURY_PCT constants (2026-08-06)
CREATOR_BPS = 50 // 0.5% creator share of a curve trade, in basis points
PLATFORM_BPS = 100 // 1.0% platform share of a curve trade — ONE wallet, no split
// NOTE: Launch fees are USD-denominated and accepted in ADA or NIGHT at the oracle spot price
// at time of launch creation. A Midnight Launch's trade fees are denominated in NIGHT (not ADA).
// See the Midnight Launch Trade Fee Currency and Conversion open issue.
```

---

## FEE SPLIT (1.5% TOTAL CURVE TRADE FEE)

The fee split percentage is the same across all tiers. The **denomination differs** for Midnight Launch.

| Recipient | % of Trade | Cardano currency | Midnight Launch currency | Notes |
|-----------|-----------|-------------------|-----------------|-------|
| Creator Fee Escrow | 0.5% | ADA | NIGHT | Monthly release via Midnight PSM |
| Platform | 1.0% | ADA | NIGHT | ONE wallet. Funds the reserve, operations, and the NIGHT bought for DUST. Midnight Launch: arrives as NIGHT, which is what ops already needs — see the Midnight Launch Trade Fee Currency and Conversion open issue for the stablecoin leg |
| **TOTAL** | **1.5%** | | | |

**Post-graduation (decided 2026-08-05, venue not built yet):** creator **1.0%**,
platform **0.1%**, and **0.1%** compounded straight back into the pool, plus the batcher
fee. Total **1.2% + batcher**. The creator's share DOUBLES at graduation while the
platform's drops tenfold. Trading continues on Noctis rather than being handed to a DEX,
which is what makes the 0.1% pool share possible — snek.fun burns its LP, so their
equivalent slice deepens a pool nobody can claim.

**Fee split verification:** 0.5 creator + 1.0 platform = 1.5 ✓

**Cardano:** The platform wallet covers team operational costs and funds the periodic NIGHT purchases that keep DUST topped up. Out of that same wallet's income the platform accumulates stablecoins — **confirmed 2026-07-10: USDM** (native Cardano stablecoin, no bridge risk — was already the documented default pending confirmation). No contract change needed: `treasury.compact` treats stablecoin conversion generically (an off-chain swap step), the same "no code change needed" status as a couple of other operational-detail items. Still genuinely open, narrower than the stablecoin choice itself: the exact DEX swap mechanism from ADA → USDM, custody wallet format, and on-chain disclosure format — operational deployment details, not separately tracked as their own issue yet.

**Midnight Launch:** All fees arrive in NIGHT. The Treasury PSM must convert NIGHT → stablecoin on a schedule. The conversion mechanism and minimum batch size are open issues (see the Midnight Launch Trade Fee Currency and Conversion open issue). The platform wallet receives NIGHT directly — the same asset it already needs for DUST, which simplifies the ops cycle.

---

## LAUNCH OPTIONS

A launch is named for the chain its token settles on. The creator chooses one at
creation, and the choice is permanent — a launch cannot change chain once live.

**Never say "Tier A", "Tier B" or "Tier C" in product copy, docs, commits or
comments.** Those letters survive only as code identifiers — validator module
names, CLI entry points and the stored `tier` post meta — where they are
load-bearing and must not be renamed: a deployed validator's hash depends on its
name, and the letter is written into every existing launch record. Read `tier_b`
as a Cardano Launch and `tier_c` as a Midnight Launch.

`tier_a` is the earlier **linear-curve, no-DarkVeil path**. It is still supported
for launches already running on it and is not offered when creating one, so it is
not a launch option and is not listed as one below.

| | Cardano Launch | Midnight Launch |
|---|---|---|
| **Status** | **Available now** | In development |
| **Launch fee** | $10 (ADA or NIGHT equiv.) | $10 (ADA or NIGHT equiv.) |
| **Token lives on** | Cardano L1 | Midnight Network |
| **DarkVeil phase** | Yes | Yes |
| **Bonding curve** | Cardano L1 *(public phase; DarkVeil stays on Midnight)* | Midnight PSM |
| **Curve type** | Quadratic | Quadratic |
| **Trade currency** | ADA | NIGHT |
| **LP graduates to** | CSwap / Cardano DEX | Midnight DEX (TBD) |
| **Whale cap** | 5% per wallet key, cumulative across DarkVeil + public | 5% per wallet key, cumulative across DarkVeil + public |
| **Cardano wallet required** | Yes | Yes (for DV eligibility proof) |
| **Midnight wallet required** | Yes (DV phase only) | Yes (full launch) |
| **Privacy level** | High — DV private; curve state visible, identities hidden | Maximum — all activity on Midnight |

**Solana Launch** and **XRP Launch** are announced, not built — both cards are in
the Create Wizard marked "Coming later" and non-selectable. See ROADMAP.md's
new-chain track, and note its still-open question of whether a DarkVeil-equivalent
private phase is in scope for a non-Midnight chain at all.

### Cardano Launch
- Launch fee: **$10 USD** (paid in ADA or NIGHT equivalent; whole to the platform wallet)
- Chains: Midnight (DarkVeil registration + private buying only) + Cardano L1 (public bonding curve + anchor + escrow + LP + staking + vesting)
- Token: Cardano native asset
- Curve: Quadratic public phase (P = P₀ + k·x²), flat P₀ during DarkVeil; priced in ADA
- **Public bonding curve runs on Cardano L1, not Midnight** (resolved 2026-07-09 — see `contracts/cardano/bonding_curve_tier_b.ak`). The public phase is public information by definition — nothing about price, amounts, or cap status needs Midnight's privacy once DarkVeil closes, and Cardano can already enforce real quadratic-curve payment natively. Only DarkVeil's private registration/buying phase stays on Midnight. Public-phase tokens mint directly to buyers as they buy, no separate distribution step.
- Cap: 5% per wallet key — the cumulative cap carries across DarkVeil and the public phase, enforced by the Merkle accumulator in the Cardano curve datum (`lib/noctis/cap_accumulator.ak`): one 32-byte `cap_root` commits to every wallet's running total, and each trade carries its own total plus a proof of it. A DarkVeil claim and a public buy draw on the same 5%; nothing about a wallet is published unless and until it trades.
- Includes DarkVeil private phase — a buyer's private Midnight purchase is settled for real (paid for in ADA, tokens delivered) via a dedicated Cardano claim after DarkVeil closes; see the DarkVeil claim settlement resolution below.
- LP graduates to CSwap (or whitelisted Cardano DEX)
- All Midnight-side user gas (DarkVeil registration/buying only) paid by platform DUST — the public curve and the DarkVeil claim are both normal Cardano transactions, no DUST involved
- **Resolved (2026-07-11):** ALL creator fees — both the DarkVeil claim and public buys — accrue in one place: the Cardano curve contract's own balance. The original "Stream A1 (Midnight) / Stream A2 (Cardano)" split described an aspirational Stream A1 that never mechanically existed (Compact could never enforce the ADA payment it would have required). See the CREATOR FEE ESCROW section.

### Midnight Launch
- Launch fee: **$10 USD** (paid in ADA or NIGHT equivalent; whole to the platform wallet)
- Chain: Midnight Network only (DV + bonding curve + LP); Cardano L1 used only for ZK anchor
- Token: Midnight-native asset — does NOT exist on Cardano L1 unless creator bridges post-launch
- Curve: Quadratic public phase (P = P₀ + k·x²), flat P₀ during DarkVeil; **priced in NIGHT** (not ADA)
- Cap: 5% per wallet key (same checks as a Cardano Launch — a Cardano wallet age proof is still required for DV eligibility)
- Includes DarkVeil private phase (NIGHT bonds, same 48h/24h sequence)
- Graduation: to a Midnight DEX — **BLOCKER: no established Midnight DEX yet, see the Midnight Launch Graduation and DEX open issue below**
- LP: Midnight LP Escrow PSM (365-day lock equivalent; no Cardano LP Escrow contract)
- ZK Fair Launch Certificate: still anchored on Cardano L1 via a relayer/oracle for public trust
- Platform pays all user DUST — a higher per-launch DUST budget than a Cardano Launch, since the entire curve is on Midnight
- **Privacy level:** Maximum. Buys, LP position, and token ownership all on Midnight private execution.

### The linear curve (legacy path, `tier_a`)
- Chain: Cardano L1 only, no Midnight dependency — it has no DarkVeil phase to run there
- Curve: Linear (P = P₀ + k·x)
- Cap: 5% cumulative per wallet key, the same Merkle accumulator the quadratic curve uses — weaker in practice, because nothing here raises the cost of using a second wallet: there is no DarkVeil eligibility check or N-hop challenge behind it
- Shares `lp_escrow.ak`, `vesting.ak`, `staking_pool.ak`, `cto_governance.ak` and `token_metadata.ak` with a Cardano Launch — only the curve validator differs

> ⚠️ **Midnight Launch is design-complete but build-blocked pending resolution of the Midnight Fungible Token Standard, Midnight Launch Graduation and DEX, Midnight Launch Trade Fee Currency and Conversion, and Midnight LP Escrow PSM Design open issues (see MIDNIGHT LAUNCH — OPEN ISSUES below).** Do not scaffold Midnight Launch contracts until those issues are resolved. both Cardano curves are unaffected.

---

## DARKVEIL FULL SPECIFICATION

DarkVeil is used by both Cardano Launch and Midnight Launch. The sequence and eligibility rules are identical. The only differences are noted inline.

### Sequence (fixed, unalterable by creator)
1. `T - 48h` — Registration opens
2. `T - 2h` — Registration freezes; base_slot = dv_supply / registered_count; cap applied
3. `T + 0` — DarkVeil 24h buying window opens at flat P₀
 - Cardano Launch: P₀ denominated in ADA/token
 - Midnight Launch: P₀ denominated in NIGHT/token
4. `T + 24h` — DarkVeil closes; settlement phase begins
5. `T + 24h + settlement` — NIGHT returns processed; ZK cert anchored on Cardano L1; curve opens
 - Cardano Launch: Cardano public bonding curve opens
 - Midnight Launch: Midnight bonding curve opens (priced in NIGHT)

> **Resolution (2026-07-13):** step 2's registration freeze now enforces a real minimum — `registered_count` must reach `MIN_DV_PARTICIPANTS` (15) before buying can open, or the governor must cancel DarkVeil instead (existing failure path, fully refundable). This closes two griefing vectors a percentage-only check couldn't — full exploit detail in `local/SECURITY_AUDIT.md`, not published here by policy. Enforced on-chain — `startBuying` in both `eligibility_gate.compact` (Cardano Launch) and `bonding_curve.compact` (Midnight Launch) rejects the Registration → Buying transition below the floor, a deploy-time `minDvParticipants` ledger field set from this constant. 6 new tests (3 per contract) pass; 193/193 total Compact tests pass (was 187).

### Registration Eligibility (all three required)
1. Wallet age ≥ 90 days on Cardano
2. NIGHT balance ≥ $50 USD at registration block (Minswap NIGHT/ADA TWAP × Orcfax ADA/USD — see ORACLE STRATEGY) — built 2026-07-13, blocked only on a confirmed mainnet Orcfax address, see the DarkVeil Eligibility Checks off-chain enforcement open issue below
3. Registrant ≠ creator fee-paying wallet address
4. Registrant stake key ≠ creator stake key
5. No direct ADA flow from creator wallet in 90-day lookback

> **Architecture correction (2026-07-12):** checks #1 and #2 were previously described as verified via "a ZK proof against UTxO history" generated client-side. This isn't achievable with real Midnight capabilities — Compact has no cross-contract call mechanism (see the Cross-PSM Atomicity open issue) and no bridge exists that lets a Midnight circuit read Cardano chain state (see the Midnight Launch Trade Fee Currency and Conversion open issue); a Midnight circuit cannot independently verify a claim about Cardano transaction history in zero-knowledge. Building check #1 for real confirmed this: it's implemented as an off-chain check (`integration/eligibility-checker.ts`'s `checkWalletAge`, querying Blockfrost directly), the same off-chain-computed-then-allowlist-gated pattern checks #1/#4/#5 all actually use. The real privacy mechanism is: the platform computes checks #1/#3/#4/#5 off-chain for every applicant (check #2 is the one remaining piece — see the DarkVeil Eligibility Checks off-chain enforcement open issue below), only eligible wallets get a leaf in a Merkle tree, and the governor publishes just the tree's root. `verifyAllowlist`'s ZK proof genuinely proves *membership* in that published tree without revealing which leaf — but it does not, and cannot, independently re-verify wallet age, stake key, or NIGHT balance itself. This is the same trust model already used for `cto_governance.compact`'s balance-snapshot tree (a governor-published root, ZK-proven membership) — trust the governor's off-chain computation, not a false claim of trustless cross-chain verification. `eligibility_gate.compact`'s own PRIVACY ANALYSIS section already described this correctly; only this section's language was wrong.

> **Implementation status (2026-07-10):** check #3 is now implemented everywhere it applies — `eligibility_gate.compact`'s `registerForDarkVeil` (Cardano Launch), `darkveil.compact`'s `revealBuyCommit` (Cardano Launch), and `bonding_curve.compact`'s `registerForDarkVeil`/`revealBuyCommit`/`buyTokens` (Midnight Launch, merged contract). Each contract now takes a `creatorPubKey` at deploy time and rejects a caller whose derived identity matches it. The same fix also closed a related, previously-undiscovered gap in Cardano's public curve `buyTokens` (Cardano/Aiken) — full detail in `local/SECURITY_AUDIT.md` — fixed in the same pass.

> **Resolution (2026-07-13):** check #4 (stake key match) is now implemented — `integration/eligibility-checker.ts`'s `checkStakeKeyMatch`, comparing the `stake_address` Blockfrost decodes directly from the registrant's and creator's addresses (no signature needed; a Cardano base address encodes its stake credential in its own bytes). No contract change was needed — like checks #1/#5, this runs off-chain before the allowlist Merkle tree is built, so a registrant who fails it simply never gets a leaf. See the Eligibility Check 04/05 resolution entry below for why this was previously (incorrectly) thought to need real cross-chain proof machinery. Check #5 resolved the same way in the same file (`checkNoDirectAdaFlow`).

### NIGHT Bond Return Formula
```
NIGHT_returned = NIGHT_bonded × (tokens_purchased / tokens_allocated)
```
- Bought 100% of allocation → 100% NIGHT returned
- Bought 50% of allocation → 50% returned, 50% forfeited — paid whole to the platform wallet
- Bought 0% (ghost) → 100% forfeited — paid whole to the platform wallet
- Phase failed (<50% participation) → 100% returned to all (no forfeiture — nothing to split)

> **Implementation status (2026-07-10):** implemented for Midnight Launch. `tokens_allocated` is `baseSlot` (the flat `dv_supply / registered_count` per-registrant allocation, set once by `closeDarkVeil`) and `tokens_purchased` is `dvTokensPurchased[buyer]` (DarkVeil-only, tracked separately from the buyer's combined balance). `claimRatioBondRefund` verifies a caller-supplied `claimedRefund` is the floor of the true value (same cross-multiplication pattern as `verifyPrice`/`verifyFeeSlice`, since Compact can't divide in-circuit) and pays out via `sendUnshielded`. The "phase failed → 100% returned to all" case is the pre-existing `claimBondRefund` circuit (also pays out for real, not just clears the ledger). **Forfeited-portion routing (resolved 2026-07-10):** the same `claimRatioBondRefund` call now also pays the forfeited remainder (`bondAmount - claimedRefund`) directly to the one platform address set at deploy — no cross-contract call into `treasury.compact` needed, since `sendUnshielded` can target a real unshielded address directly regardless of which contract holds the funds. This is a different, simpler mechanism than the "relayer/governor-sweep" pattern used elsewhere for cross-contract-call limitations (see the Cross-PSM Atomicity and Midnight Launch contract merge notes elsewhere in this document) — it works here specifically because the payout destination is a known, fixed real address, not another contract's circuit that needs to be invoked. Cardano Launch unaffected — its DarkVeil bond mechanics don't route through this contract.

### ZK Fair Launch Certificate (anchored on Cardano L1)
Public after close:
- Creator wallet purchased 0 tokens during DarkVeil ✓
- No single wallet exceeded 5% cap ✓
- Total raised (ADA for Cardano Launch; NIGHT for Midnight Launch)
- Total tokens distributed
- Total NIGHT returned / forfeited
- Correct open/close timestamps
- Tier indicator (B or C)

Private forever:
- Individual wallet addresses
- Individual buy amounts

> **Midnight Launch note:** The ZK cert is still anchored on Cardano L1 even though the launch is Midnight-native. A Midnight-to-Cardano relayer/oracle pushes the proof bundle after DarkVeil close. This preserves the public trust and marketing value of the certificate. See the ZK Cert Relayer open issue below.
>
> **Cardano Launch "individual buy amounts" note (2026-07-11):** before this fix, `bonding_curve_tier_b.ak`'s cap-tracking list was pre-seeded at deploy with every DarkVeil registrant's `(wallet, amount)` pair in plaintext, on Cardano — a direct violation of "Private forever: Individual buy amounts" above, even though the certificate itself never displayed it. The fix (Merkle-root allocation + private per-wallet `ClaimDarkVeilTokens`) closes the CARDANO side of this: no wallet's DarkVeil amount is published there unless and until that specific wallet claims, and even then only their own amount is revealed — never the full roster. Keep this invariant in mind before touching `bonding_curve_tier_b.ak`'s cap mechanism again: any redesign that publishes the full registrant list up front reopens this exact gap. **Scope note:** this does not change what's already true on the Midnight side — `revealBuyCommit` necessarily writes the buyer's amount into `eligibility_gate.compact`'s own on-chain ledger state at reveal time (inherent to any commit/reveal scheme; the contract can't enforce the cap or process the purchase otherwise), same as it did before this fix, for both tiers. This fix only stops that amount from being redundantly re-published, up front, for every registrant, on a second chain.

---

## CONTRACT ARCHITECTURE

### Midnight PSMs (Private Execution) — both launch types

> **Bonding Curve PSM scope note (2026-07-09):** this PSM is **Midnight Launch only** now. Cardano Launch's public bonding curve moved to Cardano/Aiken (`contracts/cardano/bonding_curve_tier_b.ak`) — see the Cardano L1 table below and Cardano Launch's description above. Cardano Launch's DarkVeil phase (registration + private buying) still uses the other Midnight PSMs in this table exactly as before; only the public post-DarkVeil buying phase moved.
>
> **Eligibility Gate and DarkVeil PSMs have two shapes now (2026-07-10):** Compact has no working cross-contract call mechanism (verified against the real compiler — every call form tested fails with "contract types are not yet implemented"), so the 5% cumulative cap couldn't be enforced by having separate DarkVeil / Eligibility Gate / Bonding Curve PSMs call each other. For **Midnight Launch**, all three are now MERGED into one deployed contract (`contracts/midnight/bonding_curve.compact`, despite the filename) with one shared `cumulativePurchases` ledger — `buyTokens` (public phase) AND `revealBuyCommit` (DarkVeil phase) both check and update the cap atomically against the same map. This also closed a previously-undiscovered gap: `revealBuyCommit` had ZERO payment enforcement for the actual token purchase, now fixed for Midnight Launch via `receiveUnshielded` applied at reveal time (deliberately not submit time — see the contract's file header for the privacy reasoning). For **Cardano Launch**, Eligibility Gate and DarkVeil are merged into one standalone contract (`eligibility_gate.compact`, Phase 2 2026-07-11 — the old standalone `darkveil.compact` was deleted, superseded) — Cardano Launch has no Midnight-side bonding curve to merge with. Do not assume "Eligibility Gate PSM" or "DarkVeil PSM" always means the same deployed contract across tiers.
>
> **Resolution (2026-07-11):** Cardano Launch's DarkVeil buy settlement — payment AND token delivery — moved to Cardano entirely, via a new `ClaimDarkVeilTokens` redeemer on `contracts/cardano/bonding_curve_tier_b.ak`. Investigation while designing this fix found the gap was bigger than originally scoped: `revealBuyCommit`'s missing payment check was never going to be fixable in Compact (ADA isn't a Midnight-native token — no bridge exists to move it inside a PSM, confirmed via the Midnight Launch Trade Fee Currency and Conversion research), but more importantly, **no mechanism anywhere delivered tokens or charged ADA for a Cardano Launch DarkVeil purchase at all** — the original `identity_purchases` pre-seed only ever fed the 5% cap check, never a real settlement. Fixing this also surfaced and fixed a real privacy violation in the same mechanism: that pre-seed published every registrant's `(wallet, DV-amount)` pair in plaintext on Cardano, directly contradicting the Fair Launch Certificate's "Private forever: Individual wallet addresses, Individual buy amounts" promise. Both are fixed together — see `bonding_curve_tier_b.ak`'s file header for the full mechanism (Merkle-root allocation + private per-wallet claim, nobody's amount visible unless and until that wallet claims). `revealBuyCommit` itself needed no change — it was already correct as a private commit/reveal of intent; it was never going to be the place real ADA changes hands.

| Contract | Used by | Purpose |
|----------|---------|---------|
| DarkVeil PSM | B + C | Registration, NIGHT bonds, private buying, ZK cert generation. Merged into `eligibility_gate.compact` for Cardano Launch (Phase 2, 2026-07-11) and into the Bonding Curve PSM for Midnight Launch — see notes above. Cardano Launch's actual ADA payment/token delivery for a DV purchase happens on Cardano via `ClaimDarkVeilTokens`, not in this PSM — see the resolution above. |
| Bonding Curve PSM | **C only** | Price discovery, fee routing, graduation, cumulative 5% cap enforcement (both DarkVeil and public phases), NIGHT-denominated. Merged with Eligibility Gate + DarkVeil for Midnight Launch — see note above. Cardano Launch's version of the curve itself is a Cardano contract — see below. |
| Eligibility Gate PSM | B + C | ZK proof verification for all 5 registration checks. Merged with DarkVeil into one Cardano Launch contract (Phase 2, 2026-07-11); merged into the Bonding Curve PSM for Midnight Launch — see notes above. |
| Creator Fee Escrow PSM | B + C | 1.0% fee accumulation, monthly release, silence lock, CTO redirect. For **Cardano Launch**, this PSM never actually accrued a real ADA fee for the DarkVeil phase — Compact could never enforce that ADA payment, so "Stream A1" as originally described was aspirational, not implemented. With the resolution above, **all** Cardano Launch creator fees (DarkVeil claim + public buy) now accrue in one place: the Cardano curve contract's own balance (formerly "Stream A2") — see the CREATOR FEE ESCROW section's updated note. Midnight Launch is unaffected — its whole curve stays on Midnight, so this PSM's fee accrual there is real. |
| Vesting PSM | B + C | Creator token cliff, linear release, CTO freeze |
| Treasury PSM | B + C | Fee routing, stablecoin accumulation, DUST delegation |
| Midnight LP Escrow PSM | **C only** | 365-day LP lock on Midnight DEX; equivalent of Cardano LP Escrow but on Midnight — **TBD: depends on Midnight DEX availability, see the Midnight Launch Graduation and DEX open issue** |
| Midnight Token PSM | **C only** | Manages Midnight-native fungible token issuance and transfers — **TBD: depends on Midnight token standard confirmation, see the Midnight Fungible Token Standard open issue** |
| Staking Rewards Pool PSM | **C only** | Optional per-launch staking pool (confirmed 2026-07-14). `contracts/midnight/staking_pool.compact` — reward minting/claiming is real (`mintUnshieldedToken`, confirmed real and executable, 2026-07-14), but "staked amount" is governor-attested off-chain rather than custodied on-chain (Compact has no cross-contract calls to reach `bonding_curve.compact`'s own token ledger); see STAKING REWARDS section |

### Cardano L1 Contracts (Public Record)

| Contract | Used by | Purpose |
|----------|---------|---------|
| ZK Anchor Contract | B + C | Receives and stores ZK proof bundles from Midnight PSMs. For Cardano Launch, the relayer now also anchors a `dv_allocation_root` (a Merkle root over each registrant's private allocation, not a plaintext list — 2026-07-11) so the Cardano bonding curve can verify DarkVeil claims without ever publishing the full registrant roster — see Bonding Curve Contract (Cardano Launch) below. |
| Bonding Curve Contract (linear) | legacy path only | Linear pricing, cumulative per-wallet-key cap via the same Merkle accumulator the quadratic curve uses (`lib/noctis/cap_accumulator.ak`); weaker only in that nothing here raises the cost of a second wallet. `contracts/cardano/bonding_curve.ak` |
| Bonding Curve Contract (Cardano Launch) | **B only** | Quadratic pricing, cumulative per-wallet-key cap enforced by the Merkle accumulator in the datum (one 32-byte `cap_root`, a proof per trade). `contracts/cardano/bonding_curve_tier_b.ak` — see the Cardano Launch curve migration and DarkVeil claim settlement resolutions above |
| LP Escrow Contract | **A + B** | 1-year LP lock, migration logic, fee routing, no withdraw |
| CTO Governance Contract | **A + B + C** | Vote proposals, private ballot anchoring, pass/fail enforcement |
| Staking Rewards Pool Contract | **A + B** | Optional per-launch staking pool (confirmed 2026-07-14). `contracts/cardano/staking_pool.ak` — seeded at graduation alongside LP, governor-published Merkle root for reward claims, no on-chain division; see STAKING REWARDS section |

> **Midnight Launch LP note:** Midnight Launch does not use the Cardano LP Escrow contract. LP permanence is enforced by the Midnight LP Escrow PSM instead. The 365-day lock and no-withdraw invariant apply equally — it is the same policy, different execution environment.

> **Legacy-path note:** the linear curve gets the same LP Escrow and CTO Governance contracts a Cardano Launch uses — the same invariants, just without the Midnight/DarkVeil components. This was a gap in an earlier version of this table (previously read "B only" / "B + C"); the How It Works page has always promised "1-year LP lock at graduation" and "CTO governance protection" as core features on all three tiers, so the table was corrected to match, not the other way around.

### Data Flow — Cardano Launch
```
DarkVeil eligibility (off-chain — corrected 2026-07-12, see the
Registration Eligibility section above for why):
Platform
 → Blockfrost API (checks #1/#5: wallet age, no direct ADA flow from creator)
 → Off-chain eligibility computation for every applicant — NOT a client-side
 ZK proof; no mechanism exists for a Midnight circuit to verify Cardano
 chain history
 → Governor publishes an allowlist Merkle root on Midnight
 (eligibility_gate.compact) — only eligible wallets get a leaf

DarkVeil phase (Midnight):
User Wallet (Cardano + Midnight)
 → Midnight PSM: registerForDarkVeil — a real ZK proof of MEMBERSHIP in
 the published allowlist tree (not a proof of the underlying eligibility
 facts), execute private DarkVeil registration/buying
 → ZK Proof Bundle + cumulative DarkVeil allocation → Relayer
 → Cardano L1 ZK Anchor Contract (Fair Launch Cert + dv_allocation_root, see
 the ZK Cert Relayer open issue and the DarkVeil claim settlement resolution)
 — the root replaces a plaintext per-registrant list; nobody's amount
 is published unless and until they claim (below)

DarkVeil claim (Cardano — resolved 2026-07-11):
User Wallet (Cardano)
 → Cardano L1 Bonding Curve Contract: ClaimDarkVeilTokens
 — buyer presents their own (dv_amount, salt, merkle_proof), pays the
 flat DarkVeil price in real ADA, receives their tokens; nobody
 else's allocation is ever revealed by this transaction

Public bonding curve phase (Cardano — resolved 2026-07-09):
User Wallet (Cardano)
 → Cardano L1 Bonding Curve Contract (contracts/cardano/bonding_curve_tier_b.ak)
 — one 32-byte cap_root in the datum carries every wallet's running
 total; each trade (claim above, or a public buy here) proves its own
 total against it and writes the updated root back; tokens mint
 directly to the buyer on every purchase, no separate distribution step
 → Graduation (100% sell-through) → LP deposited to Cardano DEX
```

### Data Flow — Midnight Launch
```
DarkVeil eligibility (off-chain — same correction as the Cardano Launch above):
Platform
 → Blockfrost API (checks #1/#5 against the registrant's Cardano wallet)
 → Off-chain eligibility computation — not a client-side ZK proof of
 Cardano history, no such mechanism exists
 → Governor publishes an allowlist Merkle root on Midnight

User Wallet (Midnight primary; Cardano for DV eligibility only)
 → Midnight PSM (ZK proof of allowlist MEMBERSHIP, execute private logic;
 token minted on Midnight)
 → Midnight LP Escrow PSM (LP locked on Midnight DEX at graduation)
 → ZK Proof Bundle → Relayer → Cardano L1 ZK Anchor Contract (see the ZK Cert Relayer open issue)
```

---

## CREATOR FEE ESCROW — IMPORTANT DISTINCTION

> ⚠️ This is a common source of confusion. Clarify in all code and UI.

**Stream A — Bonding Curve Escrow (pre-graduation only)**
- Accrues: 1.0% of bonding curve trades ONLY
- Closes: When bonding curve graduates (curve closes permanently)
- Amount: Fixed at graduation. Does NOT continue post-graduation.
- Payment: Monthly manual claim, ADA
- Gas: ~0.17 ADA deducted from escrow balance automatically

**Stream B — LP Trading Fees (post-graduation, ongoing)**
- Accrues: CSwap pool trading fees (~0.3% of DEX volume)
- Paid: Directly to fee_recipient, not via escrow
- Continues: Indefinitely while pool has volume
- Redirected to CTO wallet if governance vote passes

These are **two entirely different income mechanisms**. Do not conflate them in the UI.

> **Cardano Launch fee-stream resolution superseded (2026-07-11):** an earlier resolution (2026-07-10) originally described Stream A splitting into two independently-claimable balances for Cardano Launch — "Stream A1" accruing in the Midnight Creator Fee Escrow PSM for DarkVeil-phase fees, "Stream A2" accruing in the Cardano curve contract for public-phase fees. Investigating the DarkVeil ADA-payment gap found that Stream A1 as described was never actually mechanically real for Cardano Launch: Compact cannot receive or send ADA (no bridge exists — confirmed via the Midnight Launch Trade Fee Currency and Conversion research), so there was never a working circuit that could have deposited a real ADA fee into that Midnight PSM for a Cardano Launch DarkVeil buy. `eligibility_gate.compact`'s `revealBuyCommit` only ever updated private ledger counters, with zero payment enforcement of any kind.
>
> The fix settles Cardano Launch DarkVeil purchases entirely on Cardano instead (a new `ClaimDarkVeilTokens` redeemer on `bonding_curve_tier_b.ak` — see the CONTRACT ARCHITECTURE section's resolution note), which means the creator fee on a DarkVeil buy is charged and accrued there too, in the same `creator_fees_accrued` field public buys already use via `BuyTokens`. **There is no longer a Stream A1/A2 split for Cardano Launch — there was never a real Stream A1 to split from.** All Cardano Launch creator fees (DarkVeil claim + public buy) accrue as ONE balance, in `contracts/cardano/bonding_curve_tier_b.ak`, claimed via that contract's single `ClaimCreatorFees` redeemer — the same self-contained "curve contract accrues and gates its own claim" pattern the linear curve already uses.
>
> Midnight Launch is unaffected — its whole curve stays on Midnight, so its Stream A fee accrual there is real (Compact can enforce NIGHT payment natively) and stays a single balance. The linear path never had a Stream A1/A2 split to begin with — it has no DarkVeil phase. Do not build a two-balance fee UI for Cardano Launch going forward — show one Bonding Curve Escrow balance, the same as the linear curve.

---

## LP ESCROW CONTRACT

### Key Invariants
- `withdraw` does not exist anywhere in the contract. Zero code paths return LP tokens to any wallet.
- `migrate` is only callable after `lock_expiry` (graduation + 365 days)
- Minimum 90 days between migrations
- Migration is atomic: remove from old DEX + deposit to new DEX in one transaction
- During migration, underlying ADA + tokens never appear in any wallet UTxO
- New LP tokens go directly back into escrow after migration

> **What `Migrate` enforces (2026-08-11).** A migration names the replacement
> position in the redeemer, and the validator holds it to that: the escrow's
> own continuing output must really carry that token in that amount, the amount
> must be positive, and the continuing datum must record it — so the escrow's
> record always names the position it actually holds. Together with the
> existing checks (sealed lock, real expiry, the 90-day cooldown, a narrow
> validity range, whitelist membership, and governor-or-CTO authorisation),
> a migration moves the position between whitelisted DEXes and cannot end with
> the escrow holding nothing.
>
> The identity is declared rather than derived because a new pool's LP token is
> minted by that DEX and cannot be known when the datum is authored. Verifying
> that the returned token is genuinely the target DEX's LP token for that pool
> needs per-DEX knowledge, and arrives with the DEX integration work.

> **Resolution (2026-07-10):** a new `HarvestFees` redeemer lets Stream B trading fees reach `fee_recipient` (the creator, or the community wallet once CTO is triggered — same redirect rule as everywhere else) WITHOUT touching the locked LP position, closing the gap between this file's "no `withdraw`, ever" invariant and Stream B's "paid directly to fee_recipient" description — the fee payout has to route through this contract since the LP itself lives here, a script address, not a wallet. **Deliberately DEX-agnostic and narrow:** the redeemer only verifies its OWN two invariants (the locked `lp_token_amount` is byte-for-byte unchanged; the correct recipient actually receives the harvested lovelace in the same transaction) and does not model or verify any specific DEX's real harvest call — that remains genuinely unconfirmed per-DEX (CSwap/Minswap/Splash/WingRiders/SundaeSwap), an open sub-question this always had. Permissionless, same "the invariant is the authorization" idiom as `ExpireCurve`/`ExecuteDexChange`/`Graduate` — nobody can gain anything by calling it incorrectly since the LP position literally cannot move.

### Migration Whitelist (updatable — team multisig + 72h public notice)
- CSwap *(default graduation DEX)*
- Minswap
- Splash
- WingRiders
- SundaeSwap

> **Resolution (2026-07-10):** the whitelist was previously described as "hardcoded, immutable" while `lp_escrow.ak`'s own file header already claimed "Option B — multisig + 72h notice" — the header described the intended design, but the actual `AddDex`/`RemoveDex` redeemers only ever required one governor signature with immediate effect. Fixed for real: a new `ProposeDexChange` redeemer requires `multisig_threshold`-of-`multisig_signers` real signatures (the M/N split is a deployment-time choice, not hardcoded) and starts a 72-hour public notice clock; `ExecuteDexChange` applies the change once the notice period has elapsed — permissionless, since the proposal was already public for the full window (same "the deadline is the authorization" pattern as the curve's `ExpireCurve`); `CancelPendingDexChange` lets the multisig withdraw a proposal before it takes effect. This is Option B from internal tracking, matching the user's confirmed choice — not yet Option C (on-chain protocol governance vote), which stays the eventual target once platform governance ships (see the Platform Governance open issue).

### States
```
LOCKED → UNLOCKED (after 365 days)
UNLOCKED → MIGRATING (migrate called)
MIGRATING → UNLOCKED (migration confirmed)
```

---

## CTO GOVERNANCE

### Requirements for a CTO Vote
- Minimum 90 days post-graduation before any proposal (raised from 30, anti-whale-takeover fix — see below)
- 72-hour private ballot window via Midnight
- Minimum 5% of total token supply must participate (quorum)
- Minimum 15 distinct voters must have participated, alongside the 5% weight threshold (anti-whale-takeover fix — see below)
- Yes votes must outnumber no votes
- 90-day cooldown after any vote (pass or fail)

### Anti-whale-takeover safeguards (2026-07-28)
A real, unmitigated whale-takeover vulnerability was flagged and fixed (exploit mechanics not published here by policy — see `local/SECURITY_AUDIT.md` for the full technical detail). Three safeguards close it together (a 4th and 5th option — quadratic voting, and raising quorum itself — were considered and rejected: quadratic voting is largely redundant with the per-voter cap below, and raising quorum fights the platform's own "community rescue" value proposition rather than the actual takeover mechanic):

1. **Unified per-voter vote-weight cap (1% of total supply).** Previously only the creator's vote was capped (2%) — every OTHER voter's weight was unbounded. Now every voter, creator included, is held to the same absolute cap (`CTO_MAX_VOTER_CAP_PCT`).
2. **Minimum distinct voter count (15).** Checked alongside the 5% weight threshold (`CTO_MIN_VOTER_COUNT`) — closes the residual gap where a small handful of wallets (fewer than 5, before the cap made that impossible; a few more than 5 after) could still combine to clear quorum without anything resembling real community participation.
3. **Minimum holding period (30 days) before a snapshot leaf counts.** A voter's balance only counts toward a vote if the governor's balance-snapshot first observed them holding it at least `CTO_MIN_HOLDING_PERIOD_DAYS` before the proposal's start — closes a buy-right-before-the-snapshot-then-vote-then-sell timing gap, mirroring `STAKING_BONDING_PERIOD_DAYS`'s existing anti-gaming pattern (a newly-staked position earns nothing until seasoned).
4. **Post-graduation delay raised to 90 days** (`CTO_MIN_DAYS_POSTGRD`, was 30) — gives a genuinely healthy launch more runway before it can be challenged at all, on top of (not instead of) the three safeguards above.

Implemented in both `contracts/midnight/cto_governance.compact` (real enforcement — `maxVoterCap`/`minVoterCount`/`minHoldingPeriod` sealed ledger fields, checked in `castVote`/`finalizeProposal`) and `contracts/cardano/validators/cto_governance.ak` (defense-in-depth re-verification of the same quorum+voter-count math on anchor, via a new `min_voter_count` datum field). The whale cap does not, on its own, survive a launch's graduation to open DEX trading — a wallet can always re-accumulate post-graduation — but the combination above means doing so cheaply/quickly no longer bypasses real community participation the way a single-wallet quorum-satisfying vote did.

### What a Passed Vote Does (automatically)
1. Creator fee escrow future payments → CTO wallet
2. LP trading fees → CTO wallet
3. Unvested creator tokens → frozen, redirected to community treasury (NOT burned)
4. Already-claimed fees and already-vested tokens: **unaffected**

> **CTO fee-redirect fix (2026-07-12):** item 1 above was previously unenforced everywhere — none of the three bonding curve contracts (`bonding_curve.ak` linear, `bonding_curve_tier_b.ak` Cardano Launch, `bonding_curve.compact` Midnight Launch) had any CTO concept at all, so a passed SilenceLockTrigger vote never actually redirected the bonding-curve trade fee, regardless of what `creator_escrow.compact`'s own CTO logic did (it holds no real fees for either tier — see the DarkVeil claim settlement finding above). Fixed by adding the same `cto_triggered`/community-wallet pattern `lp_escrow.ak` already used for Stream B (the `HarvestFees` resolution above) to all three curve contracts: a governor-only `TriggerCTO`/`DissolveCTO` redeemer (or `triggerCTO`/`dissolveCTO` circuit for Midnight Launch), and the creator-fee claim (`ClaimCreatorFees`/`withdrawFees`) now pays out to the community wallet once triggered, the creator otherwise. `integration/midnight-client.ts`'s `executeCtoProposal` now also calls `bondingCurve.triggerCTO` (Midnight Launch only — Cardano Launch's Cardano curve trigger is a separate, off-chain-orchestrated call, not wired into that helper). Item 2 (LP trading fees) was already correctly enforced via `lp_escrow.ak`'s `HarvestFees`.

### Creator Vote Participation
The creator's own token allocation CAN vote in a CTO ballot — it is not excluded — but its weight is capped at `maxVoterCap` (an absolute token amount, 1% of total supply, set at deploy — see anti-whale-takeover safeguards above). A creator holding more than the cap has any excess weight silently truncated to the cap for that vote; a creator holding less than the cap votes their real weight. Capped creator votes count toward both quorum and the yes/no tally like any other vote, but `creatorYesVotes`/`creatorNoVotes` are tracked as a SEPARATE public field on the proposal, so the community can always see how much of a "pass" or "fail" outcome came from the creator's own vote versus everyone else's.

> **Doc-sync note (2026-07-10):** `cto_governance.compact`'s `castVote` circuit has implemented exactly this — capped participation plus separate audit tracking — since a same-day fix earlier in the project (both changes shipped together, the `creatorVoteCap` field and its cap-then-track logic are explicitly commented in the source). This matches internal tracking's own "Proposed approach" word for word ("creator tokens are not excluded from voting, but the ZK ballot proof reveals the creator-held token count separately"). internal tracking just never got updated to mark this resolved, and this section of CLAUDE.md never documented the decision at all — same pattern as the anchor mechanism doc-sync below. Documentation-sync fix only, no code change.
>
> **Anti-whale-takeover fix (2026-07-28):** the cap described above is no longer creator-only. `creatorVoteCap` was renamed `maxVoterCap` and lowered from 2% to 1% of total supply, and now applies uniformly to EVERY voter, not just a creator-flagged one — see the anti-whale-takeover safeguards note above for why. `creatorYesVotes`/`creatorNoVotes` still track only the creator's own (now-unified-cap) weight separately, for the same audit-transparency reason added above.

### Anchor Mechanism (who submits the Cardano L1 result)
**Resolved: Option C — open relay.** After the 72-hour Midnight ballot closes, ANY token holder can submit the anchor transaction to `cto_governance.ak` using the signed proof bundle — no special authorization required for that specific redeemer, by design. The contract only checks the proof bundle hash is present and the business rules (quorum, minimum distinct voter count, per-voter cap) hold. This avoids Option B's centralization risk (a platform-only relay could suppress or delay a legitimate community takeover by simply not anchoring).
> **Doc-sync note (2026-07-10):** `cto_governance.ak`'s own file header already stated "Resolution: Open relay (Option C)" and the contract has fully implemented this since it was written — internal tracking just never got updated to match, and this section of CLAUDE.md never documented the decision at all. This is a documentation-sync fix, not a fresh design decision — the code was already correct.

---

## TEAM REVENUE SOURCES

| Source | Mechanism | Notes |
|--------|-----------|-------|
| Platform Wallet | The whole flat $10 launch fee (all tiers) + 1.0% of curve trade volume + every forfeited DarkVeil bond + staking claim fees | ONE address, public, quarterly disclosure. Replaced the treasury/ops pair on 2026-08-06: no fee splits anywhere. Also funds the NIGHT purchases that generate DUST |
| NIGHT Holdings | Market appreciation as ops buys NIGHT for DUST | Sellable under exceptional circumstances only |
| Stablecoin Reserve | USDM accumulated out of the platform wallet's income | Protocol liquidity reserve, not a salary account. A holding policy now, not a separate wallet |

> **Challenge bond slashing is the one real exception to "one wallet, no splits" (verified in code 2026-08-31).**
> Revenue is unsplit — launch fee, the platform's 1.0%, forfeited DarkVeil bonds and staking claim
> fees all land in the single platform wallet. But a *slashed challenge bond* is not revenue, and
> three shipped validators still divide one 60/40 between two distinct addresses:
> `nhop_challenge.ak`, `cto_sybil_challenge.ak` and `cto_governance.ak` each declare
> `treasury_bps = 60` / `ops_bps = 40` and carry a `treasury_pub_key_hash` / `ops_pub_key_hash` pair
> in their datum, with tests asserting the payout. **Both addresses must therefore still be
> provisioned and disclosed** — retiring the pair for revenue did not retire it here, and the
> deployment checklist needs both. Whether these should also collapse to one address is a real open
> question, not a documentation slip; it needs a contract change and a re-audit, so it is not assumed
> either way here.

### NIGHT Sell Policy (Team-held NIGHT only)
- Protocol treasury NIGHT: **never sold, ever**
- Team-held NIGHT: may be sold under exceptional circumstances only
- Requirements: Full team multi-sig, 72h public notice, max 20% of holdings per event, post-sale on-chain disclosure

### Budget Ceiling: Option C (confirmed)
No hard cap on the platform wallet or the team wallet. Both grow naturally. Accountability via public addresses + quarterly spending disclosure.

### Founding NIGHT Reserve (resolved 2026-07-13)
Before the first both launch types launch, the platform wallet has no trade-volume income yet (the 1.0% platform slice only exists once launches are trading) but still needs NIGHT on hand to cover DUST for the very first DarkVeil phase. **Source (decided 2026-07-10):** a founder-provided bootstrap reserve, with an external funding route pursued as the eventual replacement. Funding specifics (exact amount, source, and replenishment plan) are deliberately kept in the local-only ops notes rather than this public spec. Funding the bootstrap from the first launch's own fee revenue was rejected outright, not just deprioritized — it's causally circular: the fees that would fund the NIGHT purchase don't exist until after the DV phase they'd need to fund has already happened.

**Sizing (2026-07-13):** the real per-transaction DUST cost (`v_fee`) remains genuinely unmeasured — the devnet needed to measure it is a documented environment-level blocker with no ETA (see the DUST Generation Rate open issue below). Rather than leave the funding decision stalled indefinitely on that, sized this with published constants and reasoned transaction counts instead of waiting for an exact figure:
- One DV phase's Midnight-side transaction count ≈ `4 × registrants + 4` (registration + buy-commit + reveal + bond-refund-claim per registrant, plus a handful of governor admin calls — the ZK cert anchor itself is a Cardano transaction, not DUST-consuming). At the minimum-participant floor (15 registrants) that's ~64 transactions; a more realistic small launch (~75 registrants) is ~304.
- No real per-transaction DUST cost is published anywhere (checked directly against `docs.midnight.network/concepts/dust-architecture` — confirms the rate/decay/grace-period constants already in this document, nothing more). Bracketed rather than guessed a point value: even under a pessimistic cost assumption (Compact PSM calls costing meaningfully more than a comparable Cardano Plutus script call, itself just a rough order-of-magnitude anchor, not a Midnight-specific fact), a single DV phase is very unlikely to need more than a few hundred NIGHT.
- **Conclusion: the committed bootstrap reserve has substantial margin (likely 10-50x) over any plausible single-DV-phase cost under every scenario considered.** Treating this as confirmed-sufficient now rather than waiting on the DUST Generation Rate open issue — revisit only if its eventual real measurement produces a number that actually challenges this margin, which the scenario analysis above suggests is unlikely.

**Action:** the founding reserve is live as of this decision. Ongoing replenishment remains a separate, not-yet-executed pursuit — this resolution only covers "is the bootstrap amount enough," not the longer-term funding structure. See the local-only ops notes for amounts and source.

---

## SOCIAL CHANNEL REGISTRATION

### Project Channels (required for silence detection)
| Channel | Status | Min Age | Verified |
|---------|--------|---------|---------|
| Twitter/X | Required (at least one primary) | 30 days | On-chain tx with launch_id hash |
| Discord | Required (at least one primary) | 30 days | On-chain tx with launch_id hash |
| Telegram | Optional | None | Light verification |

### Personal Links (optional, trust signals only)
Twitter/X, Discord, LinkedIn, Telegram, Instagram, TikTok — displayed on launch card, no verification required, not monitored for silence.

### Silence Lock Conditions (BOTH required simultaneously)
1. No monthly fee claim for 90+ consecutive days (on-chain verifiable)
2. No public post on any verified primary project channel for 90+ days (off-chain, community-reported)

### Suspension Grace Period
- Twitter/X account suspended: **30 days** to register alternative or get reinstated

---

## ORACLE STRATEGY

| Oracle | Role | Used for |
|--------|------|---------|
| Orcfax | Primary price oracle | ADA/USD on-chain datum only — no NIGHT feed on mainnet, see correction below |
| Minswap | NIGHT/ADA price source | Real, live NIGHT-ADA pool (~$3.1M liquidity, confirmed 2026-07-13) — no native TWAP endpoint, computed client-side from `pools/:id/price/candlestick` |
| Blockfrost | Chain data API (not oracle) | UTxO history, token balances, delegation records |

> **Correction (2026-07-13, found while building the DarkVeil NIGHT-balance eligibility check):** this section previously described Orcfax as publishing a direct NIGHT/USD feed, with the price computed as `median(Orcfax_NIGHT_USD, Minswap_TWAP_NIGHT_ADA × Orcfax_ADA_USD)`. Checked against the real, live `orcfax/cer-feeds` GitHub repo's published feed lists: **no NIGHT/USD feed exists anywhere** — not on mainnet, not on ITN. Orcfax does publish a `NIGHT-ADA` feed, but only on the **preview** (testnet) network, not mainnet. `ADA-USD` is real and live on mainnet.
>
> **Real, achievable formula:** `NIGHT_USD = NIGHT_ADA_price × Orcfax_ADA_USD`, where `NIGHT_ADA_price` comes from Minswap's real NIGHT-ADA pool (30-min TWAP, computed client-side — Minswap's API has no native TWAP endpoint, only candlestick/timeseries data to average over). On mainnet today there is only ONE real NIGHT-denominated price source (Minswap) — Orcfax's NIGHT-ADA feed would provide a genuine second, independent source for the divergence check below, but only once it ships to mainnet. Until then, the "Divergence >5%" and "Minswap low liquidity" fallback rules below are aspirational for the NIGHT leg specifically — there's nothing to diverge against yet. The ADA/USD leg is unaffected; Orcfax's real mainnet feed covers it.
>
> This affects every place NIGHT/USD conversion was assumed to already work this way: the DarkVeil NIGHT-balance eligibility check (≥ $50 USD), the treasury NIGHT mark-to-market calculation, and the Midnight Launch NIGHT fee → stablecoin conversion rate.

**Price calculation:** `NIGHT_USD = Minswap_TWAP_NIGHT_ADA × Orcfax_ADA_USD` (median against Orcfax's own NIGHT-ADA feed once it reaches mainnet — not yet possible)

**Fallback rules:**
- Orcfax ADA/USD stale (>10 min): no current substitute defined — open question, not yet a blocker since Orcfax's ADA/USD feed has been reliably live since Q1 2024
- Minswap low liquidity (<5,000 ADA pool depth): no fallback NIGHT source exists today — would block any NIGHT-USD-dependent check entirely
- Divergence >5%: not yet enforceable for the NIGHT leg (only one real source); still applies once Orcfax's NIGHT-ADA feed reaches mainnet
- Both unavailable >30 min: extend registration window by outage duration

**Blockfrost fallback order:** Blockfrost → Maestro → Koios → self-hosted node

> **ADA/USD now comes from `integration/ada-usd-price.ts` (2026-08-04). Orcfax is removed.**
> Its preprod address had been dormant since June 2024 — publishing `pf:dex:ADA-DJED` rather than
> ADA-USD, in a `[numerator, denominator]` encoding the decoder never expected — and no mainnet
> address was ever confirmed. The decoder had been verified against example bytes from Orcfax's own
> docstring; the address never had been.
>
> **The replacement:** the median of three independent public APIs (CoinGecko, Kraken, Coinbase)
> with the existing `ORACLE_DIVERGENCE_MAX` 5% guard, falling back to Minswap's real on-chain
> **ADA/USDM** pool if fewer than two answer. It throws rather than guessing. Live agreement between
> the three runs around 0.1%.
>
> **Why off-chain is the right shape:** no contract on either chain reads a price — the validators
> say so themselves (*"Aiken has no in-circuit oracle"*). All three consumers are off-chain platform
> code. For the launch fee specifically the platform only *quotes* an amount; the creator signs the
> transaction, so a wrong price is visible and refusable rather than silently extracted.
>
> **Verified end to end on Preprod:** a real mint paid **51.388782 ADA**, split 60/40 treasury/ops,
> which was exactly $10 at the prevailing rate.
>
> A real bug was fixed on the way: `BlockfrostClient.getAddressUtxos` requested page 1 in ascending
> order, so on any long-lived address it returned the oldest hundred UTXOs and never current state.

---

## TOKENOMICS REFERENCE

### Graduation
- Requirement: 100% sell-through of bonding curve (no partial graduation)
- Default graduation DEX: CSwap
- Creator can override to any whitelisted DEX at launch configuration

### LP Seeding (at graduation)
- Tokens: 20% of total supply (200M for a 1B token launch)
- ADA: all net-of-fee ADA the curve raised (see the Option A resolution below)
- **The pool opens ABOVE the graduation price, deliberately.** A bonding curve's
  average price is below its final price, so the raise paired against a fixed token
  count prices the pool higher than the last curve trade — roughly 1.8× on the
  linear curve and 1.2× on the quadratic one, whose shape does more of the work.
- **Why 20% rather than a figure that hits parity.** Parity would need ~31% on the
  linear curve, but allocations are creator-adjustable (creator 5-10%, DarkVeil 10-20%, staking
  on/off), so curve supply varies while LP is fixed — a constant tuned for parity in
  one configuration drives others BELOW 1.0×, which would put late curve buyers
  underwater the moment DEX trading opens. 20% keeps every permitted configuration
  on the safe side of that line while roughly halving the step-up from the previous
  15%. It is also the same LP share pump.fun uses.
- Opening above the last curve price means every curve buyer is in profit at open.
  This is the FDV distinction the UI already renders as two separate panels — see the
  Graduation FDV vs DEX FDV entry under OPEN ISSUES.
- Immediately enters 1-year LP escrow lock

> **Resolution (2026-07-10):** LP ADA source — **Option A confirmed**: all net-of-fee ADA remaining in the bonding curve contract at graduation flows into the LP (`LP ADA = total raised × 0.985`, after the 1.5% running fee). Simplest option, matches the whitepaper's worked examples, and avoids needing a separate routing decision for "surplus" ADA the way Option B would have.
>
> **Resolution (2026-07-10):** the gap found while resolving the LP ADA source question above — no redeemer anywhere actually moved ADA/tokens from a graduated curve into the LP Escrow contract — is now closed. Both `bonding_curve.ak` and `bonding_curve_tier_b.ak` gained a permissionless `Graduate` redeemer (same "the condition is the authorization" idiom as `ExpireCurve`) that moves `total_raised` ADA and a new `lp_reserve_tokens` balance (15% of supply, held in the curve's own UTXO from deploy alongside the sellable `curve_supply`) to the launch's `lp_escrow_credential`, verified by real value movement, not a claim. `lp_escrow.ak`'s `SealLock` was reworked to match — governor signature replaced with a real value check (`lp_value_received`) — so a graduation transaction validates on evidence from both sides, not trust. Bonus fix found in the process: `BuyTokens` never verified the curve's own token reserve actually shrank on delivery (only that "some output" received tokens) — fixed via a new `curve_token_balance_decreased` check on both curve contracts, since a falsely-inflated `tokens_sold` could otherwise have triggered Graduated without real depletion. 101/101 Cardano contract tests pass. See internal tracking for full detail.

### Vesting
- No tokens release before graduation regardless of elapsed time
- Creator selects 90–365 days at launch creation (no default — forced active selection)
- Release: Linear daily (`total_allocation / vest_days` per day)
- ZK proof published: creator held 0 tokens at DarkVeil open

---

## STAKING REWARDS (OPTIONAL) — confirmed 2026-07-14

An optional, per-launch feature available on every launch type. At launch creation, a creator may opt to allocate a **fixed 25% of total supply** (`STAKING_ALLOC_PCT`) into a Staking Rewards Pool — in addition to the existing 20% LP reserve, up-to-10% creator allocation, and 10-20% DarkVeil allocation. Supply math is safe at every allocation's maximum simultaneously: 20 + 10 + 20 + 25 = 75%, leaving ≥25% for the public bonding curve — no overflow risk. If declined, the 25% simply isn't carved out and the public curve absorbs it instead, same as any other unused allocation headroom.

This is a narrower, different thing from the platform-wide Community Yield Mechanism (still deferred) — see that open issue's entry above for the distinction.

### Mechanism
1. **Manual staking, not automatic.** Holding the token alone earns nothing. A holder must actively stake through the Noctis platform to participate.
2. **Fixed linear daily emission.** `daily_emission = pool_balance / duration_days`. The creator selects a duration between `STAKING_DURATION_MIN_DAYS` (1095, 3 years) and `STAKING_DURATION_MAX_DAYS` (1825, 5 years) at launch creation — no default, forced active selection, same pattern as vesting.
3. **Pro-rata daily split.** Each day's emission splits among currently-staked holders in proportion to their staked balance.
4. **Bonding period.** A newly-staked position earns nothing for `STAKING_BONDING_PERIOD_DAYS` (7 days) after staking — anti-gaming, prevents stake-right-before-snapshot-then-claim-then-unstake. Enforced entirely off-chain (see Reward Accounting below); no separate on-chain check exists for it.
5. **Claiming.** Claimable from the holder's token profile on the Noctis platform. Costs a flat `STAKING_CLAIM_FEE_USD` ($1) fee, paid in ADA (Cardano) or NIGHT (Midnight Launch) at oracle spot price — same USD→ADA/NIGHT conversion machinery as the DarkVeil NIGHT bond (see ORACLE STRATEGY). Paid whole to the platform wallet — no split, matching every other fee on the platform.
6. **Top-ups.** A creator can add more tokens to an existing pool at any time. A top-up adds to `pool_balance` without changing the daily emission rate — it extends the runway further into the future rather than accelerating payouts. There is no stored duration or end-date on-chain at all (see Reward Accounting) — a top-up is just "add to the balance."

### Reward accounting — off-chain computed, on-chain verified (no in-circuit division anywhere)
Compact has no in-circuit division, and no reward-per-share/accumulator primitive exists anywhere in this codebase. Rather than invent new on-chain division workarounds, this reuses the exact trust model already shipped for `cto_governance.compact`'s balance-snapshot Merkle tree and `eligibility_gate.compact`'s DarkVeil allowlist tree:

- **Staking/unstaking itself is fully trustless on-chain custody for Cardano** (Cardano) — a holder deposits/withdraws real tokens into/from their own position; no governor trust needed for custody. **Midnight Launch is different** — see the Midnight Launch tier-specific note below for why real on-chain stake custody isn't currently possible there, and what's governor-attested instead.
- **Reward accounting is governor-computed off-chain**, independently re-derivable by anyone from public, real on-chain stake/unstake events (amounts and timestamps are all public chain data — this is auditable, not a hidden computation). The governor periodically publishes a Merkle root of `(staker_identity, cumulative_accrued_reward_to_date)` leaves.
- **Claims are a ZK-proof-of-membership** against the current published root — the leaf is derived in-circuit from the caller's own identity, not supplied as a free witness (same security-audit discipline already applied to `verifyAllowlist`). The contract pays out `claimed_amount - already_withdrawn[caller]` and updates `already_withdrawn[caller]`, same checks-effects-interactions pattern as `claimBondRefund`.
- **The on-chain contract's only invariant is that cumulative claims never exceed `pool_balance`** — this self-limits depletion without needing any stored duration, end-timestamp, or rate field on-chain. The "3-5 year runway" is entirely an off-chain governor commitment, auditable via the published root sequence over time, not a literal on-chain enforcement.

### Pool seeding
The staking reserve seeds at **graduation**, in the same transaction as LP seeding — extends the existing `Graduate` redeemer (Cardano) rather than an earlier activation point. This avoids the edge case of a pre-graduation cancelled curve having already funded a pool for tokens that were never actually distributed.

### Tier-specific notes
- **Cardano (Aiken):** new `contracts/cardano/staking_pool.ak` — ONE pool-state UTXO per launch (`reward_root`, `claimed_so_far: List<(VerificationKeyHash, Int)>`, real token balance held directly in the UTXO's own value — no separate stored balance field) plus one position UTXO per stake ACTION (`staker_vkh`, `staked_amount`, `stake_timestamp`) — avoids single-UTXO contention for the stake/unstake action specifically. Staking itself needs no validator redeemer at all (creating a script UTXO needs no approval, only spending one does); `Unstake`/`ClaimRewards` are real, permissionless, value-movement-verified redeemers. `bonding_curve.ak`/`bonding_curve_tier_b.ak` gain `staking_enabled: Bool` + `staking_pool_credential: Credential` + `staking_reserve_tokens: Int` datum fields (0/empty if declined) and a `staking_seeding_output_ok` check on `Graduate`, mirroring the existing `lp_seeding_output_ok` check. 6 new tests (3 per curve file), 161/161 Cardano tests total.
- **Midnight Launch (Midnight/Compact):** new `contracts/midnight/staking_pool.compact` — a DIFFERENT design from Cardano's real-custody position model, forced by a real architectural constraint discovered while building it (2026-07-14): `bonding_curve.compact` never mints the Midnight Launch launch token as a real Midnight coin — it tracks ownership purely as an internal ledger `balances: Map<Bytes<32>, Uint<128>>` — and Compact still has no cross-contract call mechanism (see the Cross-PSM Atomicity open issue and the Midnight Launch contract-merge notes above), so a separate `staking_pool.compact` has no way to debit that map. Two independent `midnight-verify` agents (source-investigation against `LFDT-Minokawa/compact@main`, and live compile+execution) confirmed `tokenType`/`mintUnshieldedToken` are real, tested, working stdlib primitives — but that only solves half the problem: minting a *new* coin is real, taking custody of the *existing* launch token balance is not, without merging into `bonding_curve.compact` itself (same fix pattern as the original three-way Midnight Launch contract merge). Presented to Jinx as a 3-way choice (merge into `bonding_curve.compact` / governor-attested stake / defer Midnight Launch staking); **confirmed 2026-07-14: governor-attested stake**, over merging into the already-audited 1801-line/46-test `bonding_curve.compact`. Resulting design: `stakeSnapshotRoot` is a governor-published Merkle root over `(stakerKey, stakedAmount)` leaves, attested off-chain from `bonding_curve.compact`'s real public ledger events (same trust model as every other governor-published root on this platform — allowlist membership, CTO voting weight); reward *claiming* is fully real — `claimRewards` mints the payout directly to the staker via `mintUnshieldedToken`, and collects the NIGHT claim fee via `receiveUnshielded`/`sendUnshielded`. Stated plainly: the minted reward is a SEPARATE Midnight-native coin color from `bonding_curve.compact`'s internal launch-token ledger, not literally the same fungible unit — because that contract never minted a real coin for stakers to deposit in the first place. This is building ahead of Midnight Launch's own token foundation, the same caveat noted in the Midnight Fungible Token Standard open issue that already applies to the rest of Midnight Launch's "design-complete but build-blocked" status. 21 new tests, 214/214 total.

---

## OPEN ISSUES — BUILD BLOCKERS AND KNOWN GAPS

> These are the issues that need resolution before or during the build phase. Items marked 🔴 are blockers. Items marked 🟡 are important but not blockers. Items marked 🟢 are deferred post-MVP.

### 🔴 BLOCKER — Cross-PSM Atomicity
DarkVeil PSM closes and Bonding Curve PSM opens in the same sequence. This assumes Midnight guarantees atomic cross-PSM state commitment. **Must confirm with Midnight engineering before writing contract code.**
- If atomic guaranteed: settlement window can be minimal (ZK proof gen time only)
- If not atomic: 10-minute settlement window is mandatory
- **Default to 10-minute settlement window in all code until confirmed**
- Question to ask: *"Does Midnight's PSM framework guarantee atomic state commitment across two separate PSM instances within the same transaction or block?"*

### 🔴 BLOCKER — Midnight SDK Availability
Midnight mainnet availability and Compact language tooling maturity needs verification before building PSM contracts. Some features (e.g., cross-PSM state sync) may not yet be available.

### 🟡 IMPORTANT — Graduation FDV vs DEX FDV Distinction
The graduation FDV (bonding curve clearing price × total supply) is different from the post-graduation DEX market cap. Ensure all UI clearly distinguishes:
- **Grad FDV** = graduation price × 1B tokens (e.g., 100,000 ADA)
- **Current FDV** = DEX spot price × 1B tokens (can be 10× grad FDV after appreciation)

> **Resolution (2026-07-10):** already implemented on the live site — checked before treating this as still-open, same discipline applied to the other doc-sync-only resolutions in this document. The theme's `lp-chart-buy.php`/`lp-chart-buy-tier-b.php` render both FDV figures as two clearly labeled panels side by side (`GRADUATION FDV` marked "Fixed", `CURRENT FDV` marked "updates live"), and the post-graduation summary correctly shows only the fixed `GRADUATION FDV` while linking out to the DEX for live pricing. No unlabelled FDV figure exists anywhere on the site. Documentation-sync fix only, no code change.

### 🟡 IMPORTANT — DUST Generation Rate (pending preprod test)
The platform wallet purchases NIGHT periodically using ADA from its 1.0% slice of trade volume. DUST is generated from held NIGHT to cover all Midnight user transaction fees.

**Confirmed from midnight-ledger spec (dust.md):**
```
night_dust_ratio = 5 DUST per NIGHT (max capacity)
generation_decay_rate = ~1 week to reach full capacity from zero
dust_grace_period = 3 hours
Sustainable spend rate = 0.714 DUST per NIGHT per day
```

**Unknown — requires preprod test:**
- `v_fee` (DUST cost per transaction) is not published. It has three components: base fee + computation weight + congestion weight (DUST/byte). Must be measured empirically.

**How to measure:** Deploy a minimal PSM on preprod, run a DV registration transaction, inspect the `v_fee` field in the resulting `DustSpend`. Repeat for a bonding curve buy and a NIGHT bond return. Use these three values as cost inputs.

**Sizing formula (apply once cost is known):**
```
NIGHT_sustained = (daily_tx_count × cost_per_tx_DUST) ÷ 0.714
NIGHT_peak = (peak_hour_txs × 24 × cost_per_tx_DUST) ÷ 0.714
```

**Estimated tx count for 100 Cardano Launch launches (~180 days):**
- Average daily: ~3,300 txs → NIGHT_sustained = 3,300 × cost ÷ 0.714
- Peak (10 concurrent DV phases): ~12,000 txs/day → NIGHT_peak = 12,000 × cost ÷ 0.714
- Note: local dev wallets are seeded with 50,000 tNIGHT — scale is meaningful

**Midnight Launch DUST premium:** Every Midnight Launch trade (not just DV registration) is a Midnight transaction and consumes DUST. Midnight Launch DUST cost per launch is significantly higher than Cardano Launch. A separate per-launch DUST budget must be modelled once `v_fee` is known. Measure: DV registration tx, DV buy tx, bonding curve buy tx (Midnight Launch), LP deposit tx, and ZK cert relay tx. Midnight Launch budget = sum of all five × expected volume.

**Action:** Run preprod cost test before sizing the ops wallet NIGHT purchase policy. Implement separate per-launch DUST budget caps for Cardano Launch and Midnight Launch. If NIGHT holdings fall below safe level, Cardano Launch and Midnight Launch launches pause (separately configurable thresholds).

> **Partial resolution (2026-07-20):** after 4 local-devnet measurement attempts (full history in internal tracking), a real, node-confirmed, twice-reproduced `v_fee` was obtained for the single most expensive part of `registerForDarkVeil` (its 20-level Merkle-proof fold) via a minimal reproduction independently verified to match the real contract's own compiled prover-key size (37MB, identical both ways). Real result: `fees.paidFees = "1"` DUST atomic unit, with a full gas breakdown (`computeTime`/`readTime`/`bytesWritten`/`bytesDeleted`) available on every real transaction result going forward via the same `result.public.fees`/`result.public.partitionedTranscript[0].gas` fields. **Honest caveat, not smoothed over:** this measured cost was *lower* than a much simpler stand-in contract's measured cost (a plain Counter `increment`, "92") despite using far more real compute time — reproduced twice, not a fluke, but not independently explained either. Most likely a low-congestion/idle-single-user-devnet artifact in the real DUST fee formula's "congestion weight" term (per this section's own three-component `v_fee` model above), meaning **"1" should be read as a lower bound, not a mainnet-representative figure** — do not plug it directly into the sizing formula below as a confident point estimate. Still unmeasured: the bonding curve buy tx, NIGHT bond return tx, DV buy tx, LP deposit tx, and ZK cert relay tx this section's own "How to measure"/Midnight Launch premium paragraphs ask for — this closes the empirical *methodology* gap (a real, repeatable measurement process now exists and a real devnet is running) more than it closes the full *sizing* question.

### 🟡 IMPORTANT — Treasury Stablecoin Floor
- Hard floor: equivalent of 10,000 ADA in stablecoin (exact USD value TBD)
- Warning threshold: equivalent of 25,000 ADA in stablecoin
- Below warning: operator alerted; stablecoin accumulation continues normally
- Below floor: Cardano Launch and Midnight Launch new launches pause pending treasury review
- Note: Midnight Launch fees arrive in NIGHT and require conversion to stablecoin — conversion lag means the treasury floor calculation must account for NIGHT held but not yet converted (mark-to-market the NIGHT balance)

> **Resolution (2026-07-10):** built for real, on top of a genuine bug found in the process — `treasury.compact`'s `treasuryBalance` previously summed ADA-denominated and NIGHT-denominated deposits into ONE combined number with no unit conversion (e.g. 1000 lovelace + 500 NIGHT atomic units became a meaningless "1500"), which made a floor check impossible to compute correctly. Split into `adaBalance`/`nightBalance` (and their lifetime-counter equivalents); `withdrawFees` now takes a `currency` argument for the same reason, and NIGHT withdrawals now actually pay out via `sendUnshielded` (previously ledger-only — the governor's decrement was never matched by a real payment). New read-only circuits `getAdaEquivalentBalance`/`isBelowFloor`/`isBelowWarning` take an already-converted `nightPriceLovelacePerAtomicUnit` (computed off-chain from the existing Oracle Strategy) and do only multiplication on-chain, never division (Compact can't divide in-circuit). **These are advisory, not an on-chain gate** — this PSM has no "launch creation" circuit to attach a block to (deployment happens off-chain via the SDK/ops flow), and Compact still has no working cross-contract call mechanism (see the Cross-PSM Atomicity open issue and the Midnight Launch contract-merge notes above) regardless. The off-chain launch-creation flow is expected to call `integration/midnight-client.ts`'s new `checkTreasuryHealth` helper before proceeding with a new both launch types launch — wiring that into the actual WordPress launch-creation UI is a separate follow-up, outside this session's tracked file scope.

### ✅ RESOLVED — Domain and Social Handles
- Domain: `noctis.zone` secured ✅ (2026-06-09)
- Twitter/X: secured ✅ — **[@Noctis_Zone](https://x.com/Noctis_Zone)** (not the `@NoctisProtocol`/`@NoctisLaunch` candidates this section previously proposed — confirmed by Jinx 2026-07-10, this CLAUDE.md section had drifted out of sync with internal tracking's already-current domain status)
- Discord: secured ✅ — **[discord.gg/FkFwHFN6Aq](https://discord.gg/FkFwHFN6Aq)** (confirmed 2026-07-10, resolves to a real active server named "Noctis")

All three items required before public announcement are done. One optional, non-blocking item remains: whether to register `noctis.fi`/`noctis.io` as defensive backup domains against squatting — a standalone decision for whenever Jinx wants to revisit it, not part of this requirement.

### ✅ RESOLVED — Eligibility Check 04 (Stake Key Match) + Check 05 (Tx Graph)
Originally filed post-MVP for both checks. **Check 05 resolved 2026-07-12:** implemented in `integration/eligibility-checker.ts`'s `checkNoDirectAdaFlow`, scanning each registrant's transactions in the 90-day lookback window for the creator's address on either side, via new `BlockfrostClient.getAddressTransactionsAll`/`getTxUtxos` wrappers.

**Check 04 resolved 2026-07-13** — reverses this entry's own earlier conclusion that it needed real cross-chain proof machinery (a wallet-signed attestation or a ZK proof binding a Midnight registration to a real Cardano stake key). That framing conflated two different things: *proving ownership* of a stake key (which would need a signature) versus *reading* the stake credential a Cardano base address already encodes in its own bytes (no signature needed — Blockfrost's `GET /addresses/{address}` exposes it directly as `stake_address`). The self-report safety already relied on for checks #1/#5 extends to #4 for free: the DarkVeil allocation Merkle leaf (`hash_dv_leaf` in `bonding_curve_tier_b.ak`) binds the registrant's `VerificationKeyHash`, and `ClaimDarkVeilTokens` requires that exact key to sign — so a registrant self-reporting an address they don't control could never actually claim from it. Implemented as `checkStakeKeyMatch` in the same `integration/eligibility-checker.ts` module, wired into `checkDarkVeilEligibility` alongside checks #1/#5. New `BlockfrostClient.getAddress` wrapper for the `/addresses/{address}` endpoint. Fails closed if the registrant's address has no stake credential (enterprise/Byron address — unusual enough for a real DV registrant to treat as ineligible rather than silently pass). Catches a specific, cheap evasion of check #3 (a creator registering from a second payment address sharing their known wallet's stake key) — not full sybil detection, which remains checks #5 and the N-Hop Challenge Window's job. 6 runtime sanity checks pass (temporary probe, deleted after use, same convention as the rest of this module). No contract changes needed — like checks #1/#5, this runs entirely off-chain before the allowlist Merkle tree is built.

### 🟡 IMPORTANT — DarkVeil Eligibility Checks #1/#2 Off-Chain Enforcement — one config gap remaining
**Found 2026-07-12 while investigating the stake-key-match check above.** Checks #1 (wallet age ≥ 90 days) and #2 (NIGHT balance ≥ $50 USD) were treated as already-MVP by this document, but had **zero off-chain implementation anywhere in the codebase** — only the on-chain `verifyAllowlist` Merkle-membership circuit existed; nothing computed who should get a leaf in that tree in the first place. **Check #1 resolved 2026-07-12:** `checkWalletAge` in `integration/eligibility-checker.ts` (same new module as the check 05 fix above) walks the registrant's full transaction history via `BlockfrostClient.getAddressTransactionsAll` and compares the earliest transaction's block time against current time; zero-transaction addresses are correctly never eligible.

**Check #2 — built 2026-07-13, one real config gap remains.** Four new modules, each independently verified against real sources before being wired together (not assumed from training data, per this session's own discipline given Midnight/Compact SDK unreliability):
- `integration/indexer-client.ts` — `getUnshieldedNightBalance` via `@midnightntwrk/wallet-sdk-indexer-client`'s `UnshieldedTransactions` subscription (note: unhyphenated `@midnightntwrk` scope — the current `midnightntwrk/midnight-wallet` monorepo; the older hyphenated `@midnight-ntwrk/wallet-sdk-indexer-client` traces to a legacy `artifacts` mirror). Checked the indexer's actual resolver source (`indexer-api/src/infra/api/v4/subscription/unshielded.rs`): opening with `transactionId: 0` genuinely replays an address's full history before live-tailing — confirmed real, not assumed, since GraphQL subscriptions don't replay by default. The pull-and-terminate-at-watermark consumption pattern (`Stream.toPull`, `Effect.scoped`) was verified against the real `effect` package with 4 mocked-stream test cases before use. Native NIGHT token type comes from `@midnight-ntwrk/ledger-v8`'s real `nativeToken` export.
- `integration/minswap-client.ts` — `getNightAdaTwap`, a real 30-min TWAP computed client-side from Minswap's live `price/timeseries` endpoint (confirmed real, live data fetched 2026-07-13 from the real NIGHT-ADA pool).
- `integration/orcfax-client.ts` — `getOrcfaxAdaUsdPrice`, a real CBOR datum reader verified against the exact example bytes in `orcfax/datum-demo`'s own docstring (not just the Python source) — including a critical, easy-to-miss detail: Orcfax encodes rational-number exponents as raw unsigned 64-bit magnitudes even when semantically negative (e.g. -5 encoded as 2⁶⁴-5), needing `BigInt.asIntN(64, ...)` to recover — confirmed by cross-checking the decoded ADA-USD and USD-ADA values are true reciprocals only once that fix was applied.
- `integration/night-price-oracle.ts` — combines the two into `usdToMinNightAtomic`, all-BigInt arithmetic verified against hand-calculated expected values (matched to within 1 atomic unit, a rounding-direction difference not a bug). NIGHT decimals (1 NIGHT = 1,000,000 STAR) sourced from Midnight's public tokenomics whitepaper/FAQ via web research, **not verified against SDK source** — flagged honestly, worth confirming before mainnet use.

**The one remaining gap:** no confirmed MAINNET Orcfax ADA-USD oracle address/auth-policy exists. `orcfax-client.ts` ships a verified, working **preprod** config (`ORCFAX_ADA_USD_PREPROD_CONFIG`) — real and tested against real example data — but Orcfax's own docs describe a different discovery mechanism for finding a feed's address (a FactStatementPointer registry) than what the working reference implementation (`datum-demo`) actually uses (a fixed address + auth-policy check), and no public source gives the mainnet equivalent of that simpler pattern. `checkDarkVeilEligibility` requires callers to supply a real `OrcfaxFeedConfig` explicitly (no silent preprod default) for exactly this reason. See internal tracking for full detail.

### 🟡 IMPORTANT — Witness-Secret Persistence Across Sessions
**Found 2026-07-14** (external finding via a GitHub issue report, JAlbertCode) **— answered against real Midnight source, general fix not yet built.** DarkVeil's commit→reveal buy flow generates the commitment's "opening" (amount + nonce) client-side, needed again in a *separate* later transaction (reveal) that may happen in a different browser session entirely. Verified via `midnight-verify` against the real `midnight-dapp-connector-api`/`midnight-js` source (not assumed): witnesses execute locally in the dApp's own JS, never inside the wallet — the wallet is invoked only afterward, to turn an already-built proof preimage into a ZK proof, and its real API (checked at v4.0.1 through 4.1.0-beta.1) never exposes secret/private key material at all. The correct, first-party mechanism for persisting a witness secret across sessions is Midnight's own `PrivateStateProvider` interface (a real, encrypted, dApp-local store — AES-256-GCM, password-protected, `packages/level-private-state-provider`'s real implementation, IndexedDB in-browser), which also ships `exportPrivateStates`/`importPrivateStates` as a user-controlled backup/restore mechanism.

**The general gap:** this isn't unique to the buy nonce — `contracts/midnight/witnesses.ts`/`integration/midnight-client.ts` currently model *every* Compact witness secret in this codebase (base user identity, DarkVeil registration nonce, buy nonce, governor/creator/community secrets) as a raw value passed straight into a constructor, correct for the local test simulator but with no real wiring anywhere showing how a production, wallet-connected session sources or persists any of it. Recommended fix: wire a real `PrivateStateProvider`-backed store as the actual source for every witness secret, plus surface `exportPrivateStates`/`importPrivateStates` as a user-facing backup flow — both non-custodial by construction and consistent with Midnight's own privacy design, not a platform-invented workaround. Explicitly do NOT derive nonces from a wallet-signed message (no such primitive exists) and do NOT cache any witness secret server-side. Not yet implemented — no live frontend exists yet to retrofit (confirmed: the WordPress theme has no DarkVeil private-buy widget or commitment-handling JS at all today). Full investigation trail in internal tracking's witness-secret-persistence entry.

### ✅ RESOLVED — N-Hop Challenge Window
72-hour challenge window after DarkVeil registration, max 5 hops, 25 ADA reporter bond, NIGHT bounty.

**Resolved 2026-07-12 (Cardano Launch):** no fuller spec than the CLAUDE.md constants existed anywhere — designed this session, confirming each real fork against the existing architecture. Lives on Cardano (new `contracts/cardano/nhop_challenge.ak`, same cross-chain reasoning as the Cardano Launch curve migration and DarkVeil claim settlement resolutions above — the ADA bond can't be Midnight-native). Triggers post-CLAIM, not post-registration — the only privacy-preserving option, since a registrant's real wallet isn't publicly linked to their DarkVeil allocation until they claim (see the DarkVeil claim settlement resolution above). NIGHT bounty payout is off-chain-orchestrated, since a Cardano script can't send NIGHT. Resolution is governor-adjudicated (same trust boundary as the vesting/silence-lock governor attestation pattern used elsewhere) — the contract only enforces the bond, the 24h defence window via real chain time, and the payout itself. 6 new tests, 137/137 total Cardano tests pass. **Midnight Launch is unaffected** — already build-blocked independent of this feature (see the Midnight Fungible Token Standard and Midnight Launch Graduation and DEX open issues below).

### 🟢 POST-MVP — Blockfrost Compliance Hook
Eligibility gate is designed to be hookable for additional check modules (sanctions screening, wallet risk scoring). Architecture supports this from day one; modules themselves are post-MVP.

### 🟢 POST-MVP — Dynamic Treasury Floor
MVP: static 10,000 ADA floor. Post-MVP: dynamic floor proportional to number of active concurrent Cardano Launch launches.

### 🟢 POST-MVP — Platform Governance
NIGHT holders voting on protocol parameter changes is not Version 1. Team controls parameters at launch with public disclosure.

### 🟢 POST-MVP — Community Yield Mechanism
A community yield mechanism is deferred to post-MVP. Candidates: NIGHT lockup for protocol fee share, launch participation rewards, points-based reward system. Architecture must support activation without redeploying core contracts. ~~**Do not build staking infrastructure in V1 — design contracts to be yield-module-pluggable.**~~

> **Partially superseded (2026-07-14):** the "no staking infrastructure in V1" line above was written against a *platform-wide* yield mechanism — a single protocol-level pool NIGHT holders lock into for a share of overall fee revenue. That's still deferred, unchanged. What's now built is a narrower, different thing: an optional, **per-launch** Staking Rewards Pool a creator opts into at launch creation for their own token specifically, funded from that launch's own supply allocation, not a protocol-wide mechanism. See the new `## STAKING REWARDS (OPTIONAL)` section below. This open issue itself remains open for the platform-wide version.

---

## MIDNIGHT LAUNCH — OPEN ISSUES (BUILD BLOCKERS)

> All four issues below must be resolved before any Midnight Launch contract work begins. both Cardano curves are entirely unaffected.

### 🔴 BLOCKER — Midnight Fungible Token Standard
**Question:** Does Midnight have a published fungible token standard, or is token state managed entirely inside PSM contract logic?

On Cardano, native tokens are a first-class ledger primitive (multi-asset UTxO). On Midnight, it is not yet confirmed whether there is an equivalent — or whether a "token" for Midnight Launch is simply a balance map inside a Compact PSM's private state.

**Implications:**
- If Midnight has a native token layer: token transfers, wallet display, and indexing all work automatically
- If tokens are PSM-only state: wallets and explorers won't display balances natively; a token display adapter layer is needed
- Either way, minting, burning, and transfer logic must be confirmed before Midnight Launch contracts are designed

**Action:** Review Midnight SDK docs and Compact stdlib for any token/asset primitives. Ask Midnight engineering if a native fungible token standard is planned or exists.

### 🔴 BLOCKER — Midnight Launch Graduation and DEX
**Question:** Where does a Midnight-native token graduate to, and when will a Midnight DEX exist?

Current Cardano Launch graduates to CSwap (Cardano DEX). Midnight Launch has no equivalent — there is no established Midnight DEX at time of writing.

**Options:**
- **Option A — Wait for Midnight DEX:** Midnight Launch launches are held in a pre-graduation state until a whitelisted Midnight DEX is live. Creator and platform agree on a graduation target DEX when one is available. High delay risk.
- **Option B — Bridge at graduation:** Token is bridged from Midnight to Cardano at graduation. LP is seeded on a Cardano DEX as a wrapped/bridged version. This reintroduces bridge risk and partially defeats the Midnight-native purpose, but gives immediate liquidity.
- **Option C — Redefine graduation:** Graduation for Midnight Launch means "bonding curve fully sold through and LP seeded in a Midnight LP Escrow PSM." The DEX component is deferred — LP is held in escrow until a Midnight DEX is designated. Platform lists the token on an internal discovery page in the interim.

**Default:** Option C until a Midnight DEX is confirmed. Architect Midnight Launch LP Escrow PSM to be DEX-agnostic — it holds the assets and can be pointed at a DEX address when one is available.

**Action:** Confirm with Midnight ecosystem team whether any DEX is in development or planned. Do not implement Midnight Launch graduation logic until this is resolved.

### 🟡 IMPORTANT — Midnight Launch Trade Fee Currency and Conversion
**Question:** How does the platform convert NIGHT-denominated Midnight Launch fees to stablecoin?

For Cardano: fees arrive in ADA, swapped on Cardano DEXes to stablecoin. For Midnight Launch: fees arrive in NIGHT on Midnight. The conversion path is unclear.

**Sub-questions:**
1. Is there a NIGHT → stablecoin swap available on Midnight natively?
2. If not, does NIGHT need to be bridged to Cardano first, then swapped?
3. What is the minimum viable conversion batch size?
4. Does the Treasury PSM on Midnight hold NIGHT until a conversion threshold is reached, then bridge and convert?

**Default until confirmed:** Treasury PSM accumulates NIGHT fees. A manual conversion process (bridge → Cardano DEX swap → stablecoin) is performed by ops on a monthly schedule matching the Cardano batch cycle.

> **Research finding (2026-07-10):** the "bridge → Cardano DEX swap" default above has no bridge to actually use yet. The only protocol-level Cardano↔Midnight bridge found ([midnight-improvement-proposals#20](https://github.com/midnightntwrk/midnight-improvement-proposals/issues/20)) is unidirectional (Cardano → Midnight only, cNIGHT → mNIGHT) and NIGHT-only — there is no confirmed path for NIGHT fees to leave Midnight at all right now, in either direction back or onward to a stablecoin. Practically, this means treasury.compact's NIGHT balance (see the treasury ADA/NIGHT balance fix above) should be expected to sit unconverted indefinitely until either a reverse-direction bridge ships or a Midnight-native NIGHT/stablecoin swap appears (watch the Midnight Launch Graduation and DEX open issue's NorthStar DEX candidate).
>
> **Timeline update (2026-07-10, per Jinx):** a bidirectional version of the bridge is in development and expected live within a few months. Once it ships, this resolves the "no route off Midnight" half of this open issue directly — Midnight Launch's NIGHT fees could bridge to Cardano and swap through the existing Cardano stablecoin path, no new mechanism needed. Not yet independently confirmed against a public proposal/timeline as of this session, but this is Jinx's own expectation, not Claude speculation. Revisit this open issue once the bridge is live rather than designing around it as an indefinite blocker.

### 🟡 IMPORTANT — Midnight LP Escrow PSM Design
**Question:** What does the Midnight equivalent of the Cardano LP Escrow contract look like?

The Cardano LP Escrow contract has: 365-day lock, no withdraw, migrate after expiry, whitelist of DEXes, migration atomicity. The same policy must apply to Midnight Launch LP, but implemented as a Compact PSM.

**Complications:**
- DEX whitelist cannot be hardcoded against Midnight DEX addresses that don't yet exist
- Migration atomicity requires a Midnight DEX to support atomic remove/add operations
- LP token standard on Midnight TBD (see the Midnight Fungible Token Standard and Midnight Launch Graduation and DEX open issues)

**Approach:** Design the Midnight LP Escrow PSM with the same invariants as the Cardano version. Use a governor-updatable DEX whitelist until the Midnight DEX landscape is stable, then freeze it. The `withdraw` does not exist. The `migrate` function requires lock expiry + governor signature + whitelist membership.

### 🟡 IMPORTANT — ZK Cert Relayer (Midnight Launch → Cardano L1)
**Question:** How does a Midnight-native launch's ZK Fair Launch Certificate get anchored on Cardano L1?

For Cardano Launch, the Midnight PSM directly interacts with the Cardano ZK Anchor Contract (cross-chain call or bridge). For Midnight Launch, same mechanism is needed — but the launch has no direct Cardano component beyond this one anchor.

**Options:**
- **Option A — Same as Cardano Launch:** If Midnight SDK already supports posting proof bundles to Cardano L1, reuse the same ZK anchor mechanism. No extra infrastructure.
- **Option B — Platform-operated relayer:** After DarkVeil close, the platform's backend reads the proof bundle from the Midnight PSM and posts it to the Cardano ZK Anchor Contract. Trusted but centralised for this one step. Relayer address is public and disclosed.
- **Option C — Omit Cardano anchor for Midnight Launch:** ZK cert stored on Midnight only. Less trust-verifiable externally. Not recommended — the certificate is a core marketing asset.

**Default:** Option A if supported, fall back to Option B. Do not use Option C.

> **Implementation status (2026-07-10):** Option A confirmed not available — every real Midnight SDK surface inspected this session (`@midnight-ntwrk/midnight-js-contracts`, per the cross-contract-call and SDK-integration findings elsewhere in this document; `@midnight-ntwrk/dapp-connector-api`, per the wallet-connection fix elsewhere in this document) is entirely Midnight-side with no Cardano-aware primitive. Option B built in `integration/zk-cert-relayer.ts`: real, working cert fetching (`NoctisLaunchManager.getFairLaunchCert`) and real Blake2b-256 proof-bundle hashing (verified against `@noble/hashes/blake2.js`, runtime-tested). **Cardano transaction submission — resolved 2026-07-10:** `integration/cardano-anchor-submitter.ts`'s `LucidAnchorSubmitter` implements `CardanoTxSubmitter` for real using `@lucid-evolution/lucid` (Anvil's real docs site was checked and shows no generic arbitrary-validator-plus-custom-redeemer spend endpoint, so Lucid Evolution was used instead — confirmed real, published, actively maintained). Data schemas are hand-mirrored from `contracts/cardano/plutus.json`'s actual compiled CIP-57 blueprint for `zk_anchor`, not guessed from the `.ak` source. Full integration workspace typechecks clean. The one thing still not done: an actual submission against a live Cardano node, which needs a funded relayer key that doesn't exist in this dev environment — flagged explicitly rather than claimed as tested.

---

## SECURITY AUDIT REQUIREMENTS

Before mainnet deployment, the following must be audited:

### Priority 1 (Critical)
- DarkVeil PSM: double-registration, NIGHT bond re-entrancy, participation rate manipulation
- LP Escrow: migration atomicity failure, whitelist bypass, lock expiry manipulation
- Cross-contract ZK proof forgery: every downstream contract that accepts ZK proofs as authorisation

### Priority 2 (High)
- Bonding Curve PSM: curve math precision loss, fee routing rounding, graduation race condition
- CTO Governance: flash vote attack, quorum gaming, forged CTO_PASSED proof injection
- Vesting PSM: pre-graduation access, vest_days manipulation

### Priority 3 (Medium)
- Treasury PSM: DUST exhaustion under load, oracle manipulation
- Creator Fee Escrow: false emergency exit, epoch boundary double-claim

### Formal Verification Required
- Bonding curve integral formula (total ADA raised = theoretical value)
- LP migration atomicity (addLiquidity failure always reverts removeLiquidity)
- ZK proof soundness (no two distinct inputs produce the same valid proof output)

### Standard eUTxO vulnerability classes — cross-check every Cardano validator against these
Added 2026-08-02. The lists above are Noctis-specific; these are the generic classes any Cardano validator has to survive, and every one of them has already bitten a real project. Cross-check each validator against the full set rather than only the feature-specific items above:

**Critical:** double satisfaction · datum hijacking · unauthorised minting / token forgery · missing signer checks · infinite mint
**High:** UTxO contention / locked value · unbounded value growth · reference-input confusion (a reference input is never spent, so paying to a script address never runs it) · state-thread-token mismanagement · withdraw-zero trick
**Medium:** resource exhaustion (ExUnits DoS) · time-window manipulation via loose validity intervals · datum decode failure · index-assumption errors on inputs/outputs

Structural notes worth keeping in mind while reviewing: Cardano's eUTxO model makes classic *reentrancy* inapplicable, but **double-spend races and MEV-style ordering effects are real** and need explicit thought.

**Tooling now installed for this** (2026-08-02): `cf-review-contract` ships a 26-pattern eUTxO checklist at `~/.claude/skills/cf-review-contract/references/vulnerability-checklist.md` with risk rating, detection guidance, and mitigation per pattern. `aiken-validator-redteam` is the executable companion — it fans out one attacker per exploit class writing PoC Aiken tests where **a passing test proves a vulnerability**, judged by the compiler rather than by opinion. Use these alongside the existing `aiken-dex-security-audit` playbook, not instead of it.

**Reference standards:** **CIP-52** (audit best practice, three assurance levels) and **CIP-96** (draft — on-chain audit certification metadata) are worth reading before commissioning any external audit.

---

## FILE STRUCTURE (SUGGESTED)

```
noctis/
├── CLAUDE.md ← this file
├── README.md
├── apps/
│ ├── web/ ← Next.js frontend
│ │ ├── app/
│ │ │ ├── (public)/
│ │ │ │ ├── page.tsx ← Landing page
│ │ │ │ └── [launch]/ ← Individual launch page
│ │ │ ├── launch/
│ │ │ │ ├── create/ ← Launch wizard (all launch types)
│ │ │ │ └── [id]/ ← Live launch view
│ │ │ ├── dashboard/ ← Creator dashboard
│ │ │ └── admin/ ← Internal ops (treasury, launches)
│ │ ├── components/
│ │ │ ├── darkveil/ ← DV registration, countdown, allocation
│ │ │ ├── bonding/ ← Curve chart, buy interface
│ │ │ ├── escrow/ ← Creator fee claims
│ │ │ ├── governance/ ← CTO vote UI
│ │ │ ├── lp/ ← LP position, migration
│ │ │ └── shared/ ← Wallet connect, layout, nav
│ │ └── lib/
│ │ ├── blockfrost.ts ← Blockfrost API client
│ │ ├── orcfax.ts ← Oracle price fetching
│ │ ├── midnight.ts ← Midnight SDK wrapper
│ │ ├── cardano.ts ← Cardano tx building
│ │ └── constants.ts ← All platform constants from this doc
├── contracts/
│ ├── midnight/ ← Compact PSM contracts
│ │ ├── darkveil.compact
│ │ ├── bonding_curve.compact
│ │ ├── eligibility_gate.compact
│ │ ├── creator_escrow.compact
│ │ ├── vesting.compact
│ │ └── treasury.compact
│ ├── cardano/ ← Aiken contracts
│ │ ├── bonding_curve.ak ← legacy path only, linear
│ │ ├── bonding_curve_tier_b.ak ← Cardano Launch, quadratic (moved from Midnight to Cardano/Aiken, 2026-07-09)
│ │ ├── lp_escrow.ak
│ │ ├── cto_governance.ak
│ │ └── zk_anchor.ak
│ └── tests/
├── docs/
│ ├── noctis_whitepaper_v1.html
│ ├── noctis_whitepaper_v1.docx
│ └── noctis_presentation_v1.html
└── packages/
 ├── zk-proofs/ ← Client-side ZK proof generation
 └── types/ ← Shared TypeScript types
```

---

## KEY DESIGN PRINCIPLES FOR THE BUILD

1. **Midnight is invisible to the end user.** Users should never see "Midnight" language in the UI unless they are specifically interested. DUST fees are handled in the background. The privacy layer is a feature, not a complexity. Exception: Midnight Launch users must be told they need a Midnight wallet — this is unavoidable, but frame it as "for maximum privacy."

2. **Two income streams for creators are distinct.** Never show them as one number. Always label: "Bonding Curve Escrow" (pre-graduation, fixed amount) vs "LP Trading Fees" (post-graduation, ongoing).

3. **The 5% cap is cumulative across DV + public, per wallet key.** Enforced on-chain by a Merkle accumulator in the curve datum (`contracts/cardano/lib/noctis/cap_accumulator.ak`): one 32-byte root commits to every wallet's running total, and each trade carries its own total plus a proof of it, so the datum stays one fixed size however many wallets trade. A DarkVeil claim and a public buy draw on the same 5%, and a sell returns headroom. UI should show "X% used" across the whole launch, not per-phase.

   **Say "per wallet key", not "per identity".** The cap binds one payment key hash. Nothing on-chain can tell two keys apart from two people, on any tier — what differs between tiers is the *cost* of a second identity, which is what DarkVeil's eligibility checks and the N-hop challenge exist to raise. Product copy must not imply otherwise.

4. **Graduation is 100% sell-through only.** No partial graduation. No progress bar that looks like it could graduate early.

5. **No withdraw button for LP exists.** Do not build one. Do not show it as greyed out. It does not exist — in either the Cardano LP Escrow or the Midnight LP Escrow PSM. **Distinct from the pre-graduation buyback mechanism:** `ClaimBuyback` (Cardano `bonding_curve.ak`/`bonding_curve_tier_b.ak`) only exists pre-graduation, on a curve that stalled and was force-cancelled before ever seeding an LP — it lets holders reclaim a pro-rata share of principal that was never going to become an LP in the first place. It does not touch LP tokens, does not exist on `lp_escrow.ak`, and does not apply to a launch that actually graduated. Do not generalize it into anything resembling LP withdrawal.

6. **Creator vesting has no default.** The launch wizard must force an active selection between 90 and 365 days. No pre-filled value.

7. **The ZK Fair Launch Certificate is a badge.** After every Cardano Launch or Midnight Launch DarkVeil close, generate and display it prominently. It is a marketing asset. Make it shareable. For Midnight Launch, the certificate still appears on Cardano (via relayer) — display it the same way.

8. **Public wallet addresses day one.** Treasury, ops wallet, and team wallet addresses should be visible in the UI footer or a dedicated transparency page.

9. **Ops buys NIGHT; treasury holds stablecoins.** The ops wallet purchases NIGHT to maintain DUST for Midnight transaction fees. For Midnight Launch, the ops wallet receives NIGHT directly from trade fees — it may need less open-market purchasing. The treasury accumulates USDM.

10. **Midnight Launch is the premium, high-privacy option.** Position it clearly: a Cardano Launch keeps its public curve public, while a Midnight Launch is private from start to finish. The trade-off (Midnight wallet required, NIGHT-denominated, less DEX liquidity initially) must be clearly communicated during launch wizard Midnight Launch selection — never hidden.

11. **Tier choice is permanent.** A launch cannot be upgraded or downgraded between tiers after it goes live. Make this irreversibility explicit in the launch wizard confirmation screen.

---

## WHITEPAPER REFERENCE

The complete Noctis whitepaper (Version 1) is the authoritative reference for all protocol decisions. It has been audited for mathematical correctness. Key verified figures:

- Curve fee split: 0.5 creator + 1.0 platform = **1.5% total** ✓
- Supply: 5 creator + 20 LP + 15 DarkVeil + 60 curve = **100%** ✓ *(LP raised from 15 to 20 on 2026-08-04)*
- Launch fee, every launch type: **$10 USD** (ADA or NIGHT equiv.) — whole to the platform wallet ✓
- Vesting: 50M ÷ 180 days = **277,778/day** = **~8,333,333/month** ✓
- LP seeding: the pool receives **200M tokens + the whole net-of-fee raise**, so it opens
  above the graduation price rather than balanced at it — see LP SEEDING. The whitepaper's
  `15,000 ADA = 150M × 0.0001` line states what a *balanced* pool would need, which is not
  what the curve produces; the arithmetic is right, the reading was wrong.
- Curve raise, discrete-sum pricing, verified against the whitepaper's own figures:
  a quadratic curve over 65% of supply at 0.0001 ADA/token raises **21,666 ADA**, matching
  its "~22K ADA raised", and 0.5% of that is **108 ADA**, matching its "~110 ADA creator
  escrow" under the pre-2026-07-06 fee split. Two independent confirmations that the
  discrete-sum model is the intended economics.
- Creator curve escrow at ~22K ADA raised: **~110 ADA** ✓

---

## COMPETITIVE CONTEXT

Primary competitor: **snek.fun** (Cardano) 
Noctis wins on: front-run protection, whale cap, anti-rug mechanics, ZK fair launch proof, community rescue mechanism, LP permanence, creator economics that improve at graduation rather than ending, and uniquely — a fully private Midnight-native launch option (Midnight Launch) with no comparable product anywhere in the ecosystem 
snek.fun wins on: instant launch, brand recognition, lower trade fee (~1%)

**Competitor figures, from snek.fun's own documentation (docs.snek.fun), 2026-08-04.** An earlier
edit the same day put their launch fee at 25 ADA from secondary coverage; that was wrong, and so was
the 42,069 ADA graduation figure. First-party values:

| | snek.fun | Noctis |
|---|---|---|
| Launch cost | **~6 ADA** flat (~15 ADA working balance to cover minting + contract deposit) | $10, flat across all tiers |
| Starting market cap | 2,550 ADA | 3,000 ADA at `CURVE_BASE_PRICE_LOVELACE` |
| Graduation | **69,000 ADA** market cap (26x) | 75,000 ADA (25x) |
| Trade fee, curve phase | **1.3% + 0.5 ADA flat** — creator 0.3%, platform 1% | 1.5% + batcher (&le;1 ADA) — creator 0.5%, platform 1.0% |
| Trade fee, post-graduation | 1.3% — creator 1%, LP 0.15%, platform 0.15% | creator takes LP trading fees |
| Graduation bonus to creator | **200 ADA** | none |
| Creator/team allocation | **none — "no hidden team allocation"** | 5-10%, vested 90-365 days |
| LP at graduation | burned | 365-day escrow, migratable after |

**What this actually says about positioning:**
- **Launch cost is a real disadvantage, as originally recorded.** ~6 ADA against $10 is not close —
  roughly 5x theirs. **Flattened to $10 across every launch type on 2026-08-04** (was $10/$30/$50): the
  premium tiers were charging for DarkVeil while the surrounding product — CTO automation, vesting,
  the staking platform, LP escrow — is bundled at every tier, so tiering the entry price
  undersold the whole offer rather than positioning it. One price, more included, is the clearer
  story against a competitor whose product is the curve alone.
- **Creator economics start ahead and stay ahead.** During the curve: 0.5% against their 0.3%.
  After graduation Noctis pays the creator **1.0%**, matching their 1% — but the shape differs.
  Their 200 ADA graduation bonus is a one-off; ours is a permanent 0.1% compounding into an LP the
  creator ultimately controls, where theirs is burned. The old "double competitors" line is retired:
  it was true at 1.0% during the curve and is not true at 0.5%.
- **Their flat 0.5 ADA per curve trade is regressive** and bites small buyers hard. Noctis's batcher
  fee has a **ceiling, not a floor** — the order names a maximum and the batcher takes actual cost or
  less, typically ~0.25 ADA. On a 20 ADA trade their real cost is ~3.8% against our ~2.75%, and
  post-graduation we are cheaper than them at every size.
- **Graduation thresholds are now close** — 75,000 ADA against their 69,000, so a Noctis launch
  asks for slightly more buy-side than a snek.fun one rather than materially less.
- **Zero team allocation is their strongest fairness claim.** Noctis answers it with vesting and the
  ZK Fair Launch Certificate rather than by matching it; that is a deliberate difference and worth
  stating plainly rather than glossing.
- **Curve range now matches theirs**: 3,000 → 75,000 ADA is 25×, against snek.fun's 2,550 → 69,000
  at 26×. `CURVE_BASE_PRICE_LOVELACE` was raised from 1 to 3 on 2026-08-04 to get there; at 1 it was
  a 1,000 ADA start and a 75× ride, better for early buyers but an opening valuation that read as
  trivial beside theirs.

**Fee comparison is no longer the attack surface it was.** At 2.0% it was the weakest line in the
pitch; at 1.5% + a capped batcher, Noctis is cheaper than snek.fun on small trades (their flat
0.5 ADA dominates there) and cheaper at every size after graduation. The platform's 1.0% funds a
stablecoin reserve, operations, and the NIGHT that pays users' Midnight gas for them. Community
yield distribution remains a post-MVP upgrade.

**Midnight Launch is a unique market position.** No launchpad currently offers a fully Midnight-native token launch. This is not just a feature — it is a different product category: privacy-first token creation for projects that want zero on-chain Cardano footprint. The target creator is one who values privacy and is building within the Midnight ecosystem, not one who wants maximum Cardano liquidity from day one.

---

*NOCTIS ZONE · CLAUDE INSTRUCTION DOCUMENT · VERSION 1* 
*They can't front-run what they can't see.*
