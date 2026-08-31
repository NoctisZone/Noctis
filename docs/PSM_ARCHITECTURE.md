# Noctis Zone — System Architecture

> **Version:** 1.0 (original) + 2026-07-10 accuracy pass 
> **Last Updated:** July 8, 2026 (original) — sections 2, 3, 4, 5, 10, 12, 17, 18, 19 corrected 2026-07-10 
> **Author:** John M.P. Santi (original) + corrections noted inline 
> **Status:** Active development
>
> **2026-07-10 note:** this document was written before Cardano Launch's bonding curve moved off Midnight entirely, onto Cardano/Aiken; before Midnight Launch's Eligibility Gate, DarkVeil, and Bonding Curve were merged into one Compact contract (Compact has no cross-contract call mechanism, confirmed by compiling real probe contracts); and before a wave of failure-path and graduation work. The sections below have been corrected to match the real, current, compiled contracts — not just re-described from memory. **[ARCHITECTURE.md](../ARCHITECTURE.md)** is the more actively maintained visual reference; this document goes deeper on rationale and math that hasn't changed (privacy model, identity system, DarkVeil commitment scheme, bonding curve formulas) and has been corrected everywhere it previously described a mechanism that turned out not to exist or has since been replaced.
>
> **2026-07-22 note:** not deeply re-audited this pass — `ARCHITECTURE.md`, `README.md`, and `architecture.html` were the ones brought current (the linear curve's real Preprod proof, a wave of security-audit passes, the new `cto_sybil_challenge.ak` validator, Staking's real UI). The rationale/math sections here (privacy model, identity system, DarkVeil commitment scheme, bonding curve formulas) are believed still accurate since that content genuinely hasn't changed, but this file — like the other three — needs a real update pass whenever a major architectural fact changes, not just when someone notices it's stale.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Topology](#2-system-topology)
3. [Launch Types](#3-launch-types)
4. [Midnight PSM Architecture](#4-midnight-psm-architecture)
5. [Cross-PSM Communication](#5-cross-psm-communication)
6. [Privacy Model](#6-privacy-model)
7. [Identity System](#7-identity-system)
8. [Tokenomics](#8-tokenomics)
9. [DarkVeil Protocol](#9-darkveil-protocol)
10. [Bonding Curve Mathematics](#10-bonding-curve-mathematics)
11. [Fee Routing](#11-fee-routing)
12. [LP Lock and DEX Migration](#12-lp-lock-and-dex-migration)
13. [ZK Fair Launch Certificate](#13-zk-fair-launch-certificate)
14. [Cardano Integration](#14-cardano-integration)
15. [DIDz Ecosystem Integration](#15-didz-ecosystem-integration)
16. [SilentLedger Architecture Mapping](#16-silentledger-architecture-mapping)
17. [Data Flow Diagrams](#17-data-flow-diagrams)
18. [Failure Paths](#18-failure-paths)
19. [Glossary](#19-glossary)

---

## 1. Executive Summary

Noctis is a privacy-first token launchpad that operates across two blockchain layers:

- **Cardano L1** — public bonding curves, LP escrow, CTO governance (Aiken smart contracts)
- **Midnight Network** — private pre-sale (DarkVeil), eligibility verification, ZK proof generation (Compact PSM contracts)

The protocol offers three launch tiers (A: Cardano-only, B: Cardano+DarkVeil, C: fully Midnight-native), each addressing different creator needs for privacy, cost, and complexity.

The core innovation is **DarkVeil** — a zero-knowledge private buying phase where participants prove eligibility without revealing identity, wallet balance, or purchase amount. This eliminates front-running, whale advantage, and copy-trading during the most vulnerable phase of a token launch.

---

## 2. System Topology

> **Corrected 2026-07-10.** The original diagram showed one generic "Bond Curve" box shared by both launch types on Midnight. Cardano Launch's bonding curve is now a Cardano/Aiken contract — the public phase never touches Midnight. Midnight Launch's bonding curve is merged with its Eligibility Gate and DarkVeil PSM into a single deployed Compact contract (Compact has no cross-contract call mechanism, so this is the only way the 5% cap can be enforced against one shared ledger across DarkVeil + public phases). The diagram below is per-tier rather than one shared box.

```
 ┌──────────────────────────┐
 │ noctis.zone (WP) │
 │ WordPress Frontend │
 └────────────┬─────────────┘
 │
 ┌────────────▼─────────────┐
 │ Integration Layer │
 │ │
 │ ┌─────────┐ ┌─────────┐ │
 │ │Blockfrost│ │ Orcfax │ │
 │ │ Client │ │ Oracle │ │
 │ └────┬────┘ └────┬────┘ │
 │ │ │ │
 │ ┌────▼───────────▼────┐ │
 │ │ Midnight SDK │ │
 │ │ Wallet Connector │ │
 │ └────────┬───────────┘ │
 └───────────┼─────────────┘
 │
 ┌───────────────┬──────┼──────┬───────────────┐
 │ │ │ │
┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│ CARDANO L1        │ │ MIDNIGHT          │ │ MIDNIGHT          │ │ CARDANO L1        │
│ (Cardano Launch)  │ │ (DarkVeil phase)  │ │ (Midnight Launch) │ │ (shared)          │
├───────────────────┤ ├───────────────────┤ ├───────────────────┤ ├───────────────────┤
│ Aiken:            │ │ Compact:          │ │ Compact:          │ │ Aiken:            │
│ - bonding_curve_  │ │ - eligibility_    │ │ - bonding_curve.  │ │ - zk_anchor       │
│   tier_b.ak       │ │   gate.compact    │ │   compact         │ │ - lp_escrow       │
│   (quadratic,     │ │   (merged with    │ │   (eligibility +  │ │ - cto_governance  │
│   incl. real DV   │ │   DarkVeil; the   │ │   darkveil +      │ │ - cto_sybil_      │
│   settlement)     │ │   old darkveil    │ │   curve, ONE      │ │   challenge       │
│ - staking_pool.ak │ │   file deleted)   │ │   contract)       │ │ - token_metadata  │
│ - vesting.ak      │ │                   │ │ - creator_escrow  │ │                   │
│ - nhop_challenge  │ │ Used by both      │ │ - treasury        │ │ Reached by every  │
│                   │ │ launch types for  │ │ - staking_pool    │ │ launch type; a    │
│ The legacy linear │ │ registration and  │ │ - Midnight LP     │ │ Midnight Launch   │
│ path uses         │ │ private buying.   │ │   Escrow PSM      │ │ anchors by relay. │
│ bonding_curve.ak  │ │                   │ │                   │ │                   │
│ in its place.     │ │                   │ │                   │ │                   │
└───────────────────┘ └───────────────────┘ └───────────────────┘ └───────────────────┘
```

Shared Midnight PSMs used by both Cardano Launch and Midnight Launch, unaffected by the Cardano Launch/Midnight Launch architecture split: **Creator Escrow PSM** (real fee accrual for Midnight Launch only — Cardano Launch's real ADA fee accrues on the Cardano curve contract instead) and **Treasury PSM** (the platform's 1.0% fee accumulation, currency-split ADA/NIGHT ledger — the ADA/NIGHT split is a CURRENCY distinction, not a wallet one).

---

## 3. Launch Types

### The linear curve (legacy)

**Target:** Simple launches that don't need privacy. Community tokens, meme coins, public fundraises.

**Flow:**
1. Creator configures launch on noctis.zone wizard
2. Bonding curve deploys on Cardano (Aiken)
3. Public buys phase — linear curve, 5% soft cap
4. Graduation → LP seeded to Cardano DEX
5. LP locked in Cardano LP Escrow (365 days, no withdraw)

**Privacy:** None. All transactions visible on Cardano L1.

### Cardano Launch — Cardano + DarkVeil

**Target:** Projects that need front-run protection for early supporters but want public price discovery afterward.

**Flow (corrected 2026-07-10; DarkVeil settlement corrected 2026-07-11):**
1. Creator configures launch, selects DarkVeil allocation (10-20%)
2. Eligibility Gate + DarkVeil deploy together as ONE Midnight contract (Phase 2, 2026-07-11 — `eligibility_gate.compact`; the old standalone `darkveil.compact` was deleted, superseded)
3. Participants register on Midnight (lock NIGHT bond, prove allowlist membership)
4. DarkVeil buying phase — commitment-based private purchases (`submitBuyCommit`/`revealBuyCommit`) record the buyer's private intent; NO ADA moves here — Compact can't custody ADA (no bridge exists). Real settlement happens after close, in step 8.
5. DarkVeil closes → ZK Fair Launch Certificate generated; relayer also anchors a `dv_allocation_root` — a Merkle root over each registrant's private `(vkh, amount, salt)` allocation, NOT a plaintext list (the original design published every registrant's amount at deploy time, violating the certificate's own "Private forever: Individual buy amounts" promise)
6. Certificate + allocation root pushed to Cardano (Aiken ZK Anchor contract)
7. Buyers claim their DarkVeil allocation on Cardano via `ClaimDarkVeilTokens` — presenting their own privately-known `(dv_amount, salt, merkle_proof)`, paying the flat DarkVeil price in real ADA, receiving their tokens. Nobody's allocation is visible unless and until that specific wallet claims.
8. **Public bonding curve runs on Cardano L1, not Midnight** — `contracts/cardano/bonding_curve_tier_b.ak` (quadratic, priced in ADA). The cumulative 5% cap is one 32-byte `cap_root` in the curve datum committing to every wallet's running total: each trade carries its own total plus a Merkle proof of it, the validator walks that path twice — once against the current root to prove the total is real, once with the updated leaf to derive the new root — so the datum stays a fixed size however many wallets trade, and a DarkVeil claim (step 7) and a public buy here draw on the same 5%. Tokens mint directly to the buyer on each purchase — no separate cross-chain distribution step, since token and payment are already in the same place.
9. Graduation (100% sell-through) → `Graduate`/`SealLock` (permissionless, verified by real value movement) → LP seeded to Cardano DEX → LP Escrow (365 days, `lp_escrow.ak`, whitelist governed by a multisig + 72h notice process)

**Privacy:** High. DarkVeil registration/commit/reveal is fully private (Midnight); nobody's allocation amount is ever published unless and until they choose to claim it. Public curve phase is a normal, visible Cardano transaction, same as any claim.

**Creator fees are ONE balance for Cardano Launch, not a two-stream split:** an earlier resolution (2026-07-10) originally described "Stream A1" (Midnight, DarkVeil-phase) and "Stream A2" (Cardano, public-phase) as two independently-claimed balances. Further investigation found Stream A1 was never mechanically real — Compact could never enforce the ADA payment it would have required. With DarkVeil purchases now settling on Cardano too, ALL Cardano Launch creator fees accrue in one place: `bonding_curve_tier_b.ak`'s own `creator_fees_accrued`, claimed via that contract's `ClaimCreatorFees` — the same self-contained pattern the legacy linear curve already used. See [ARCHITECTURE.md](../ARCHITECTURE.md)'s Creator Fee Escrow section.

### Midnight Launch — Midnight + DarkVeil

**Target:** Maximum privacy launches. Tokens that live entirely on Midnight.

**Flow (corrected 2026-07-10):**
1. Creator configures launch (priced in NIGHT)
2. Eligibility Gate + DarkVeil + Bonding Curve are compiled and deployed as **one merged Compact contract** (`bonding_curve.compact`, despite the filename) sharing a single `cumulativePurchases` ledger — Compact has no working cross-contract call mechanism (every call form tested against the real compiler fails), so this compile-time merge is the only way the 5% cap can be enforced atomically across both DarkVeil and public-phase purchases. Creator Escrow, Treasury, and Midnight LP Escrow remain separate PSMs.
3. DarkVeil phase (registration, NIGHT bond, commitment-based private buying — `revealBuyCommit` now enforces real payment via `receiveUnshielded` at reveal time)
4. Bonding curve public phase inside the same merged contract (quadratic, priced in NIGHT)
5. Graduation → LP seeded to Midnight LP Escrow PSM (DEX-agnostic pending Midnight DEX availability — Option C, "redefine graduation," is the current default: LP sits in escrow until a Midnight DEX is designated)
6. LP Escrow on Midnight (365 days, no withdraw, DEX migration once a Midnight DEX exists)
7. ZK Fair Launch Certificate relayed to Cardano — Option B (platform relayer), not Option A, since no real Midnight SDK primitive can post directly to Cardano L1 (confirmed 2026-07-10)

**Privacy:** Maximum. Everything except the certificate is private.

**Build status:** Blocked on Midnight DEX availability (see the open issues list).

---

## 4. Midnight PSM Architecture

### PSM Overview

A **Private State Machine (PSM)** is Midnight's equivalent of a smart contract. Each PSM maintains private ledger state that can only be modified through authorized circuits. State changes require zero-knowledge proofs that validate the transition without revealing private inputs.

### The Noctis PSMs — Shape Differs By Tier (corrected 2026-07-10)

There is no longer one fixed set of "six PSMs" shared identically across tiers. What each contract *is* depends on which tier it's serving:

- **Cardano Launch:** Eligibility Gate and DarkVeil are **merged into one deployed contract** (`eligibility_gate.compact`, Phase 2 2026-07-11 — the old standalone `darkveil.compact` was deleted) — it only ever handles the DarkVeil phase. There is no Midnight Bonding Curve PSM for Cardano Launch at all; the public curve, AND the real settlement of a DarkVeil purchase (ADA payment + token delivery via `ClaimDarkVeilTokens`), live in `contracts/cardano/bonding_curve_tier_b.ak` on Cardano.
- **Midnight Launch:** Eligibility Gate, DarkVeil, and Bonding Curve are **merged into one deployed contract** (`bonding_curve.compact`) sharing one cap ledger — described separately below as 4.2.
- **Both tiers:** Creator Escrow PSM (4.4), Treasury PSM (4.5) are standalone in shape — but Cardano Launch's Creator Escrow never actually accrues a real fee: Compact could never enforce Cardano Launch's ADA payment, so all Cardano Launch creator fees accrue on the Cardano curve contract instead.
- **Midnight Launch only:** Midnight LP Escrow PSM (4.6) — both Cardano curves both use the Cardano `lp_escrow.ak` contract instead; there is no Midnight LP Escrow PSM for Cardano Launch.

The subsections below describe each contract's real current circuits. 4.1–4.3 describe Cardano Launch's merged shape; the box afterward describes Midnight Launch's merged shape.

#### 4.1 Eligibility Gate PSM (Cardano Launch — merged with the former DarkVeil PSM, Phase 2 2026-07-11)

**Purpose:** Gate entry to DarkVeil (allowlist + 5% cumulative cap) **and** run the whole DarkVeil private-buying phase (registration, NIGHT bonds, commitment/reveal, bond refunds, ZK Fair Launch Certificate) for Cardano Launch, all in one deployed contract.

**Correction (2026-07-12):** an earlier version of this document described "Eligibility Gate" and "DarkVeil" as two separate contracts (see the old 4.3 below, now removed). They were merged into one file, `eligibility_gate.compact`, during the Phase 2 security pass (2026-07-11) — the old standalone `darkveil.compact` was deleted entirely. This wasn't a renaming; it closed a real gap: Compact has no cross-contract call mechanism, so two separate contracts could never have enforced one shared cumulative cap across both DarkVeil and (for Cardano Launch) the public phase without merging. Real Cardano Launch settlement (ADA payment + token delivery for a DarkVeil purchase) does **not** happen in this contract at all — it happens on Cardano via `bonding_curve_tier_b.ak`'s `ClaimDarkVeilTokens`, since ADA isn't representable as a Midnight-native token.

**State (merged contract):**
- `launchId` (sealed), `allowlistRoot` (sealed), `walletCap` (sealed) — 5% of supply, precomputed
- `bondAmount` (sealed) — NIGHT bond required for registration ($50 USD equivalent, fixed at lockup)
- `phase`/`dvState` — launch phase and DarkVeil sub-phase (Registration, Buying, Closed, Cancelled)
- `registrationNullifiers`, `buyNullifiers` — sets preventing double-registration/double-buying
- `cumulativePurchases` — map of `UserPublicKey` → total purchased (shared across DarkVeil + any Cardano Launch public-phase entry that references this identity)
- `dvTokensPurchased` — DarkVeil-only purchases, tracked separately for the ratio-based bond refund
- `lockedBonds` — map of buyer key → locked NIGHT bond amount
- `baseSlot` — flat per-registrant allocation, set once at DarkVeil close
- `hasClaimableBalance`-style governor-attested facts do **not** live here — that's `cto_governance.compact`, see 4.6
- `creatorKey` (sealed), `platformAddr` (sealed, the single real unshielded payout address)
- `governorKey` (sealed)

**Circuits (current, real):**
1. `registerForDarkVeil(bondCommitment)` — verify allowlist membership (ZK proof of Merkle membership, leaf derived in-circuit from caller identity, not a free witness), lock the NIGHT bond via `receiveUnshielded`, reject the creator's own identity, emit registration nullifier
2. `submitBuyCommit(commitment)` — submit a private buy commitment; **requires proof of prior registration** (recomputes the caller's own registration nullifier and checks membership in `registrationNullifiers` — closed a real gap where any wallet could buy without ever registering)
3. `revealBuyCommit(...)` — reveal after close; enforces the `baseSlot` per-registrant cap, so no single registrant can take more than their allocation
4. `claimBondRefund(recipientAddr)` — full NIGHT bond refund for the "DarkVeil failed, <50% participation" case; pays out for real via `sendUnshielded` (was ledger-only before the Phase 2 fix)
5. `claimRatioBondRefund(recipientAddr, claimedRefund)` — ratio-based partial refund for a normal close (`NIGHT_returned = bonded × purchased/baseSlot`), ported from Midnight Launch's formula during the same merge that added this contract's registration+buying logic — pays the buyer their share and routes the forfeited remainder to the platform wallet via `sendUnshielded`. The forfeited amount is what the bond and the verified refund leave over, so there is no share for a caller to supply.
6. `closeDarkVeil(...)` / phase-advance circuits — governor-gated DarkVeil lifecycle
7. Read circuits: `getFairLaunchCert`, `getDvState`, `getCumulativePurchase`, etc.

**Note:** `checkAndUpdateCap` — a standalone cap-checking circuit described in earlier documentation — no longer exists. Cap enforcement is inline, folded directly into the buy/reveal path, so the cap cannot be manipulated independently of an actual purchase. If you see it referenced elsewhere, that reference is stale.

#### 4.2 Bonding Curve PSM (Midnight Launch only — merged with Eligibility Gate + DarkVeil)

**Purpose:** Quadratic price discovery, NIGHT-denominated, for **Midnight Launch only**. The legacy linear path uses an Aiken contract on Cardano L1 (`contracts/cardano/bonding_curve.ak`); Cardano Launch uses a quadratic Aiken contract on Cardano L1 (`contracts/cardano/bonding_curve_tier_b.ak`). Neither Cardano curve has a Midnight-side counterpart anymore — see Section 10 for the curve-shape rationale.

**Corrected 2026-07-10:** this is not a standalone contract. `contracts/midnight/bonding_curve.compact` is the **merged** deployment for Midnight Launch — it contains the Eligibility Gate's cap-tracking logic, the DarkVeil phase's registration/commitment/reveal logic, and the public-phase buying logic, all sharing one `cumulativePurchases` ledger. This was forced by a real constraint: Compact has no working cross-contract call mechanism (verified against the compiler — every call form tested fails with "contract types are not yet implemented"), so three separate PSMs calling each other to enforce one shared 5% cap was never achievable. The file keeps the name `bonding_curve.compact` for historical reasons, but functionally it is Midnight Launch's entire Midnight-side launch contract.

**State (merged contract, Midnight Launch):**
- `launchId` (sealed), `basePrice` (sealed), `maxPrice` (sealed), `curveSupply` (sealed), `dvAllocation`/`dvPrice`/`bondAmount` (sealed, DarkVeil params), `creatorPubKey` (sealed, wash-trading block)
- `curveState` — Inactive, Active, Graduated, Cancelled, Expired
- `dvState` — Registration, Buying, Closed (DarkVeil sub-phase, tracked in the same contract)
- `cumulativePurchases` — **single shared map**, buyer key → total purchased across DarkVeil + public phases (the cap enforcement this whole merge exists for)
- `dvTokensPurchased` — DarkVeil-only purchases, tracked separately for the ratio-based bond refund
- `tokensSold`, `totalRaised` — Public counters
- `feeConfig` (sealed) — Fee split (50 bps creator, 100 bps platform)
- `creatorFees`, `platformFees` — Fee accumulators (one platform line, no split)
- `governorKey` (sealed)

**Circuits (merged contract, selected):**
1. `registerForDarkVeil(merkleProof, nullifier)` — DarkVeil registration, same eligibility checks as Cardano Launch's standalone gate, now checking/updating the shared cap map
2. `revealBuyCommit(commitment, tokenAmount, pricePerToken)` — DarkVeil reveal; enforces real NIGHT payment via `receiveUnshielded` at reveal time (a fix to a circuit that previously had zero payment enforcement)
3. `buyTokens(tokenAmount, claimedPrice, grossPayment, claimedCreatorFee, claimedTreasuryFee, claimedOpsFee, timestamp)` — public-phase buy; caller supplies price/fee-split values, circuit verifies via cross-multiplication (no division in-circuit); rejects the creator's own `creatorPubKey`
4. `claimRatioBondRefund(recipientAddr, claimedRefund)` — pays out `NIGHT_bonded × (tokens_purchased/tokens_allocated)` to the buyer, plus routes the forfeited remainder to the fixed platform address via `sendUnshielded` — no cross-contract call needed since the destination is a fixed real address
5. `claimBondRefund` — pre-existing full-refund path for the "DarkVeil failed, <50% participation" case
6. `ExpireCurve`-equivalent / `activateCurve` / `cancelCurve` — lifecycle, same permissionless-after-deadline idiom as the Aiken contracts
7. `currentPrice`, `tokensRemaining`, `balanceOf`, `getFairLaunchCert` — read circuits

#### 4.3 Creator Escrow PSM (Stream A bonding-curve fee escrow ONLY — no vesting)

**Purpose:** originally designed to hold the creator's 1.0% bonding-curve fee escrow (Stream A) and pay it out monthly. Vesting was split out into its own contract, `vesting.compact` (2026-07-09) — mixing day-based vesting math with a growing fee accumulator was a real bug (`claimAmount * vestDays == escrowAmount * elapsedDays` breaks once `escrowAmount` keeps changing under an in-progress claim), not just mislabeling.

**Important correction (2026-07-12): this contract never actually holds a real fee for either tier in the current architecture.** Cardano Launch's Stream A fee accrues directly on the Cardano curve contract (`bonding_curve_tier_b.ak`, since real Cardano Launch settlement moved to Cardano entirely). Midnight Launch's accrues inline in `bonding_curve.compact`'s own `creatorFees` ledger field. `depositFees` here is real, tested, and correctly gated — it is simply never invoked by anything in the shipped design (and couldn't be, even if it wanted to — Compact has no cross-contract call mechanism).

**State:**
- `launchId` (sealed), `creatorKey` (sealed), `currency` (sealed — Ada or Night, matches the launch's own curve currency)
- `escrowAmount`, `escrowState` (Active, Closed, FullyClaimed, CTORedirected, Cancelled), `claimedAmount`
- `ctoTriggered`, `communityWallet` — CTO redirect state (mirrors the pattern every curve contract now uses)
- `lastClaimTimestamp` — for silence-lock monitoring (see the important note below)
- `postCtoFees`, `communityClaimedAmount`
- `governorKey` (sealed)

**Circuits:**
1. `closeEscrowAtGraduation(graduationTimestamp)` — fixes the final escrow total, establishes the silence-lock clock baseline (only starts once there's an actual claimable balance, not from deploy — see the note below)
2. `claimFees(claimAmount, currentTimestamp)` — creator's monthly claim; pays out for real via `sendUnshielded` for NIGHT-currency escrows (Phase 1 fix, ) — ADA-currency escrows stay ledger-only (ADA isn't Midnight-native)
3. `triggerCTO`/`dissolveCTO` — redirects future claims to the community wallet after a passed CTO vote
4. `depositFees(amount)` — real, tested, but never actually invoked (see above)
5. `claimByCommunity`/`claimRemainingEscrowByCommunity` — post-CTO claim path
6. `checkCreatorSilence(currentTimestamp)` — checks `lastClaimTimestamp` against a 90-day threshold

**Important note on the silence lock:** this contract's own `checkCreatorSilence`/`lastClaimTimestamp` are vestigial for the same reason as its fee accrual — since no real claims happen here for either tier now that Cardano Launch settlement moved to Cardano, this timestamp never meaningfully updates. The **actual, currently-enforced** silence-lock gate for triggering a CTO vote lives in `cto_governance.compact`'s `createProposal` (`lastCreatorActivity`/`silenceThreshold`, plus the `hasClaimableBalance` gate — see 4.6). Don't assume this contract's silence check is the one that matters.

#### 4.4 Vesting PSM (creator TOKEN allocation only — split from Creator Escrow, 2026-07-09)

**Purpose:** Linear release of the creator's token allocation (90-365 days, no default) — genuinely separate from Creator Escrow's fee income, per CLAUDE.md's explicit "two distinct income streams, never conflate them" principle.

**State:**
- `launchId` (sealed), `creatorKey` (sealed), `vestDays` (sealed), `tokenAllocation` (sealed — fixed at deploy, never touched by fee deposits, unlike the old merged design)
- `vestState`, `claimedAmount`, `vestStartTimestamp`
- `ctoTriggered`, `communityWallet` — same CTO pattern as every other PSM
- `governorKey` (sealed)

**Circuits:**
1. `startVesting(startTimestamp)` — governor triggers vesting start; **timestamp now bound to real chain time** via `blockTimeGte`/`blockTimeLte` (±1 hour tolerance) rather than trusted outright (before this fix, a compromised governor or the creator themself could forge an old start timestamp to unlock vested tokens early)
2. `claimVested(claimAmount, currentTimestamp)` — creator claims vested portion; same real chain-time binding applies (before this fix, the creator could supply a future timestamp and claim 100% on day one)
3. `triggerCTO`/`dissolveCTO` — unvested tokens freeze and redirect to the community wallet after a passed CTO vote (not burned)
4. `cancelLaunch` — pre-graduation cancellation path

**Key constraint:** `vestDays` must be 90-365. No default. Creator must actively choose at launch wizard. No tokens release before graduation regardless of elapsed time.

#### 4.5 Treasury PSM

**Purpose:** Accumulate platform fees (1.0% of each trade), track the ADA-equivalent floor for pausing new both launch types launches.

**Corrected 2026-07-10 — real bug found while building the floor check:** `treasuryBalance` used to sum ADA-denominated and NIGHT-denominated deposits into one meaningless combined number (1000 lovelace + 1000 NIGHT atomic units became "2000," with no real meaning). Split into `adaBalance`/`nightBalance` (and their lifetime-counter equivalents) so a floor check is actually computable.

**State:**
- `launchId` (sealed), `governorKey` (sealed)
- `adaBalance`, `nightBalance` — split into per-currency balances, plus `totalAdaFeesCollected`/`totalNightFeesCollected`
- `floorLovelace`/`warningLovelace` (sealed) — floor/warning thresholds
- `withdrawalCount`

**Circuits:**
1. `depositFees(amount, currency)` — deposit fees; for NIGHT this requires a real matching unshielded input via `receiveUnshielded` (requires a real matching input, so the recorded balance always corresponds to value actually received)
2. `withdrawFees(amount, currency, recipientAddr)` — governor withdraws for stablecoin conversion; NIGHT withdrawals now pay out for real via `sendUnshielded` (was ledger-only before this fix)
3. `getAdaBalance`/`getNightBalance` — read per-currency balances
4. `getAdaEquivalentBalance(nightPriceLovelacePerAtomicUnit)`/`isBelowFloor(...)`/`isBelowWarning(...)` — mark-to-market circuits; multiplication only, no on-chain division (the NIGHT/lovelace rate is computed off-chain from the Oracle Strategy and passed in). These are advisory read-only queries, not an on-chain launch-creation gate — this PSM has no "create launch" circuit to attach a block to; the intended caller is `integration/midnight-client.ts`'s `checkTreasuryHealth`.

**Important note:** like Creator Escrow, `depositFees` here is real, tested, and correctly gated, but **never actually invoked by either tier's curve contract** in the shipped architecture — same reason (no cross-contract call mechanism exists to route the deposit here).

#### 4.6 CTO Governance PSM

**Purpose:** Community TakeOver ballots — proposal creation, private voting, quorum/majority enforcement, and executing the redirect once a vote passes. This PSM exists for every launch type; there is also a Cardano-native equivalent (`cto_governance.ak`, see Section 12) that serves as the anchor target and, on a Cardano launch, as the primary ballot mechanism directly.

**Corrected 2026-07-12 — this contract was previously missing from this document entirely.**

**State:**
- `launchId` (sealed), `creatorKey` (sealed), `totalSupply` (sealed), `maxVoterCap` (sealed — an absolute token amount, 1% of supply, not a percentage computed at vote time; renamed from `creatorVoteCap` and lowered from 2%, anti-whale-takeover fix 2026-07-28 — now a UNIFORM cap applied to every voter, not just the creator)
- `minVoterCount` (sealed — anti-whale-takeover fix, 2026-07-28: minimum number of distinct voters required for quorum to count, alongside the 5% weight threshold)
- `minHoldingPeriod` (sealed — anti-whale-takeover fix, 2026-07-28: minimum time, 30 days, a balance-snapshot leaf's held-since timestamp must predate a proposal's start before that balance counts toward a vote)
- `ctoState` — PreCTO, CTOTriggered, CTODissolved
- `communityWallet`
- `lastCreatorActivity` — governor-attested, updated from off-chain monitoring (claim or social post detected)
- `hasClaimableBalance` — governor-attested (2026-07-12): whether the launch's fee escrow currently holds a real, unclaimed balance. Without this, a zero-volume launch (no trade fees ever accrued) could still have a `SilenceLockTrigger` proposal pass purely on elapsed time — there'd be nothing to actually recover. Refreshed together with `lastCreatorActivity` via the same governor call, since both facts come from the same off-chain observation.
- `balanceSnapshotRoot` — Merkle root of `(voterKey, balance, heldSinceTimestamp)` leaves, published by the governor before any proposal can be created (design requirement — replaced a design where a voter's `voteWeight`/`isCreator` were trusted, caller-supplied values, so vote weight is proven, never asserted; `heldSinceTimestamp` added 2026-07-28 for the holding-period safeguard)
- `proposals` — map of proposal ID → Proposal (type, timestamps, vote tallies, state, `voterCount`)
- `voteNullifiers` — prevents double-voting without revealing which voter voted
- `governorKey` (sealed)

**Circuits:**
1. `updateBalanceSnapshot(newRoot)` — governor-only; publishes the balance tree every `castVote` weight proof is checked against
2. `updateCreatorActivity(timestamp, hasClaimableBalance)` — governor-only; refreshes both silence-lock inputs together
3. `createProposal(proposalType, ...)` — anyone can propose; gates `SilenceLockTrigger` on both `lastCreatorActivity` exceeding the silence threshold **and** `hasClaimableBalance` being true; gates other proposal types on `ctoState`/cooldown/post-graduation-delay (now 90 days, `CTO_MIN_DAYS_POSTGRD`, raised from 30) as appropriate
4. `castVote(proposalId, support, currentTimestamp)` — requires a real Merkle proof of the voter's balance against `balanceSnapshotRoot`; every voter's weight — creator included — is capped at `maxVoterCap` (not excluded, not unlimited) and the creator's own capped weight is tracked separately (`creatorYesVotes`/`creatorNoVotes`) for public audit (unified across all voters 2026-07-28); also rejects a vote whose leaf `heldSinceTimestamp` is less than `minHoldingPeriod` before the proposal's `startTimestamp`
5. `finalizeProposal`/`executeProposal` — enacts a passed `SilenceLockTrigger` (sets `ctoState`/`communityWallet`) or `DissolveCTO` (returns control if the creator re-engages); a proposal only passes if quorum (5%) AND majority AND `voterCount >= minVoterCount` all hold (anti-whale-takeover fix, 2026-07-28 — closes the single-large-wallet quorum-alone gap)
6. Read circuits: `getCtoState`, `getCommunityWallet`, `getLastCreatorActivity`, `getHasClaimableBalance`, `getProposal`, `hasVoted`, `getProposalCount`

**Cross-contract limitation (important):** this contract only ever flips its **own** `ctoState`/`communityWallet` when a proposal executes — it cannot call any other PSM's `triggerCTO` directly (no cross-contract call mechanism exists). Each dependent contract's own `triggerCTO` (Creator Escrow, Vesting, Treasury, both tiers' curve contracts) must be invoked as a separate, off-chain-orchestrated transaction — see `integration/midnight-client.ts`'s `executeCtoProposal`.

#### 4.7 Midnight LP Escrow PSM (Midnight Launch only)

**Purpose:** 365-day LP lock with no withdraw and DEX migration, for **Midnight Launch only**. Both Cardano curves use the Cardano `lp_escrow.ak` contract instead (see Section 12) — there is no Midnight LP Escrow PSM in their flow at all.

**State:**
- `launchId` (sealed), `lockTimestamp` (sealed), `lockDuration` (sealed)
- `lpState` — Locked, Migrated
- `dexWhitelist` — Set of approved DEX addresses (governor-updatable until the Midnight DEX landscape stabilizes)
- `ctoTriggered`, `communityWallet` — same CTO pattern as every other PSM (correction, see below)
- `governorKey` (sealed)

**Circuits:**
1. `sealLock(timestamp)` — Governor seals the lock start time
2. `addDexToWhitelist(dexAddr)` — Governor adds DEX to whitelist
3. `removeDexFromWhitelist(dexAddr)` — Governor removes DEX from whitelist
4. `migrateLp(dexAddr)` — Migrate LP to whitelisted DEX after lock expiry (Phase 3, 2026-07-12: no longer takes a caller-supplied timestamp — gates on real chain time via `blockTimeGte` directly)
5. `isLockExpired` — Check if lock has expired (same Phase 3 fix — no parameter)
6. `triggerCTO`/`dissolveCTO` — redirects LP trading-fee harvest authority to the community wallet after a passed CTO vote (added 2026-07-12, previously missing from this contract entirely — see the note below)
7. `getLpState` — Read LP state

**Key constraint:** `lockDuration` must be >= 31536000 (365 days). **No withdraw function exists.** The only way to move LP is `migrateLp` after lock expiry to a whitelisted DEX.

**Note:** this PSM is currently unreachable in practice — the lack of a Midnight DEX means Midnight Launch is build-blocked before this contract's `migrateLp` circuit would ever be exercised. Graduation for Midnight Launch currently means "LP seeded into this escrow," full stop (the "redefine graduation" option), with the DEX component deferred.

**CTO fee-redirect fix (2026-07-12) — a gap that affected every tier:** until this fix, none of the three bonding curve contracts (`bonding_curve.ak` linear, `bonding_curve_tier_b.ak` Cardano Launch, `bonding_curve.compact` Midnight Launch) had any CTO concept at all — a passed `SilenceLockTrigger` vote never actually redirected the bonding-curve trade fee, regardless of what `cto_governance.compact`'s own logic did, because that contract only flips its own state (see 4.6's cross-contract limitation note). Fixed by adding the same `ctoTriggered`/community-wallet pattern `lp_escrow.ak` already used for its own trading-fee harvest to all three curve contracts, plus Creator Escrow, Vesting, and this Midnight LP Escrow PSM. Each contract's own `triggerCTO`/`dissolveCTO` (or `TriggerCTO`/`DissolveCTO` on Aiken) must still be called as a separate, off-chain-orchestrated transaction after a CTO vote passes — see `integration/midnight-client.ts`'s `executeCtoProposal`.

---

## 5. Cross-PSM Communication

> **Rewritten 2026-07-10.** This section previously claimed Compact supports "transaction merging" as a native mechanism for atomic multi-PSM state transitions. **That claim is false and has been retracted.** This session's investigation compiled real probe contracts against the actual Compact compiler to test every call form between two deployed PSMs — all failed with "contract types are not yet implemented." No mechanism exists in Compact today, at any level (transaction, witness, or ledger), for one deployed PSM to read or write another deployed PSM's state atomically. This is a materially different (and more limiting) situation than the original version of this document described, and it directly shaped how Cardano Launch and Midnight Launch were architected — see below.

### What Actually Works: Compile-Time Contract Merging

The only mechanism that works is folding multiple `.compact` source files into **one deployed contract** at compile time, via `include`/`module` directives, before the Compact compiler ever runs. The result is a single contract with a single shared ledger — not two contracts communicating, but one contract that used to be described as several. There is no cross-PSM call at runtime because there is no longer a PSM boundary at all between the merged pieces.

This is exactly what happened for Midnight Launch: `eligibility_gate.compact`'s cap-tracking logic, `darkveil.compact`'s registration/commitment/reveal logic, and the bonding curve's public-buy logic were merged into one file (`contracts/midnight/bonding_curve.compact`, Section 4.2) sharing one `cumulativePurchases` ledger. That is the *only* reason the 5% cumulative cap can be enforced atomically across DarkVeil and public-phase purchases for Midnight Launch.

### What This Constraint Forced, Tier By Tier

- **Cardano Launch:** rather than try to merge a Midnight bonding curve with the Midnight Eligibility Gate + DarkVeil logic, the public bonding curve was moved off Midnight entirely, onto Cardano/Aiken (`bonding_curve_tier_b.ak`). The public phase is public information by definition, so nothing about it needed Midnight's privacy — and Cardano can enforce quadratic-curve payment natively, the same pattern the linear curve already used. The cumulative cap crosses the Midnight→Cardano boundary via a **relayer anchor**, not a cross-PSM call: at DarkVeil close, the relayer pushes a Merkle root over each registrant's private allocation to the Cardano ZK Anchor Contract (a root, not a plaintext list — fixing a privacy leak the original anchor design had), and buyers later claim their real ADA-settled allocation on Cardano via `ClaimDarkVeilTokens`, which draws on the same cap accumulator a public buy does — one 32-byte root in the curve datum, proved and updated per trade, so DarkVeil and public purchases share one 5% without either chain holding a per-wallet list. Eligibility Gate and DarkVeil are still Midnight-only, but no longer two separate PSMs — Phase 2 (2026-07-11) merged them into one contract (`eligibility_gate.compact`), since there's no cross-contract call mechanism to let a standalone DarkVeil circuit and a standalone Eligibility Gate circuit coordinate the ratio-based NIGHT bond refund either.
- **Midnight Launch:** as described above — three-way compile-time merge into one contract.
- **Cross-contract payout that looks like a cross-PSM call but isn't:** `claimRatioBondRefund` on the merged Midnight Launch contract pays the forfeited portion of a forfeited NIGHT bond directly to a fixed platform **address** via `sendUnshielded` — not to another contract's circuit. This works specifically because the destinations are known, fixed, real unshielded addresses, not another PSM's state that needs a circuit invoked on it. It is not evidence of a working cross-contract call; it's a case where the payout target happens not to need one.
- **Other multi-PSM-sounding flows** (fee deposits into Treasury, escrow deposits into Creator Escrow) are **not** atomic cross-PSM transactions either — each PSM's own circuit sends value directly to a fixed recipient address the same way, or the flow is a separate, individually-submitted transaction relying on the platform's off-chain orchestration layer to sequence them, with no on-chain atomicity guarantee across the two. Where atomicity actually matters (the 5% cap), the answer was always "merge the contracts," never "merge the transaction."

### The Cross-PSM Atomicity Question Is Now Answered, Not Just Defaulted

CLAUDE.md's Cross-PSM Atomicity open issue (DarkVeil PSM close → Bonding Curve PSM open) originally defaulted to a 10-minute settlement window pending confirmation from Midnight engineering on cross-PSM atomicity. That confirmation arrived indirectly, at the SDK level: `@midnight-ntwrk/midnight-js-contracts`'s only transaction-batching primitive (`withContractScopedTransaction`) is parameterized by a single contract type and cannot batch calls across two different PSMs. Combined with the compiler-level finding above, the 10-minute settlement window isn't a conservative default anymore — it is currently the only implementable option, for the same underlying reason the Cardano Launch/Midnight Launch architecture split exists: nothing in Compact or the SDK lets two separate deployed contracts commit state atomically together.

---

## 6. Privacy Model

### What Goes On-Chain (Public Ledger)

| Data | Visibility | Rationale |
|------|-----------|-----------|
| `launchId`, `dvAllocation`, `dvPrice` | Sealed at deploy | Transparency for launch parameters |
| `dvState` | Public | Phase transparency |
| `commitments` (hashes only) | Public | Enables verification without revealing content |
| `buyNullifiers` (hashes only) | Public | Prevents double-buying |
| `totalParticipants`, `totalTokensCommitted` | Public (aggregates) | Launch transparency |
| `fairLaunchCert` | Public | Proves fairness |
| `governorKey` | Public (derived) | Admin accountability |

### What Stays Private

| Data | Where | Why |
|------|-------|-----|
| User's secret key | Witness (never on-chain) | Identity protection |
| Buy nonce | Witness (never on-chain) | Commitment uniqueness |
| Governor's secret key | Witness (never on-chain) | Admin security |
| Individual buy amounts | Hidden in commitments until revealed | Front-run protection |
| UserPublicKey → real identity | Off-chain mapping | Privacy by default |

### Privacy Flow

```
(Cardano Launch: all four steps hit ONE contract, eligibility_gate.compact.
 Midnight Launch: all four steps hit ONE contract, bonding_curve.compact. Shown as separate steps below for clarity, not
 separate deployed contracts.)

1. Registration:
 User ──(ZK proof of allowlist membership)──▶ merged contract
 User ──(NIGHT bond lock)──────────────────▶ merged contract
 Identity: NOT revealed (nullifier only)

2. Buying (DarkVeil):
 User ──(commitment hash + nullifier)──────▶ merged contract
 Amount: HIDDEN in commitment
 Identity: NOT revealed (nullifier prevents double-buy)
 Requires proof of prior registration — closes a real gap where a
 wallet could previously buy without ever registering

3. Reveal (after close):
 User ──(private buy data via witness)─────▶ merged contract
 Amount: BECOMES PUBLIC (Midnight Launch reveal; a Cardano Launch settles
 for real on Cardano via ClaimDarkVeilTokens instead — see 4.1)
 Identity: Still protected by UserPublicKey abstraction

4. Certificate:
 Governor ──(closeDarkVeil)────────────────▶ merged contract
 Certificate: PUBLIC (aggregate stats only)
 Individual participation: NOT in certificate
```

---

## 7. Identity System

### Witness-Derived UserPublicKey

All Noctis PSMs use witness-derived identity instead of Midnight's `ownPublicKey`:

```
UserSecretKey (private, never on-chain)
 │
 ▼
persistentHash("noctis:<domain>:user:pk:v1", secretKey.bytes)
 │
 ▼
UserPublicKey (32-byte hash, used as on-chain identity)
```

**Why not `ownPublicKey`?**

`ownPublicKey` returns the transaction submitter's key, which is:
- Bypassable (can be set to any key)
- Not tied to a private secret
- Not domain-separated (same key across all contracts)

Witness-derived `UserPublicKey` is:
- Tied to a private secret (must know the secret to derive the key)
- Domain-separated (different key per contract domain)
- Non-bypassable (must provide the witness)

### Domain Separation

Each PSM uses a unique domain tag:

| Contract | Domain Tag |
|-----|-----------|
| Eligibility Gate (Cardano Launch, merged with DarkVeil) | `noctis:eligibility:user:pk:v1` |
| Bonding Curve (Midnight Launch, merged with Eligibility Gate + DarkVeil) | `noctis:curve:user:pk:v1` |
| Creator Escrow | `noctis:escrow:creator:pk:v1` |
| Vesting | `noctis:vesting:creator:pk:v1` |
| CTO Governance | `noctis:cto:user:pk:v1` |
| LP Escrow | `noctis:lp:governor:pk:v1` |
| Treasury | `noctis:treasury:governor:pk:v1` |

This prevents cross-PSM identity linking — a user's key in the bonding curve is different from their key in DarkVeil, even though both derive from the same secret.

---

## 8. Tokenomics

### Total Supply

| Parameter | Value |
|-----------|-------|
| Total supply | 1,000,000,000 (1 billion) |
| DarkVeil allocation | 10-20% (default 15%) |
| Bonding curve allocation | 80-90% (default 85%) |
| Staking rewards allocation | 25% fixed, optional per-launch toggle (2026-07-14) — see CLAUDE.md's STAKING REWARDS section |
| Per-wallet cap | 5% cumulative (DV + public) |

### Fee Structure

| Fee | Rate | Recipient |
|-----|------|-----------|
| Creator fee | 0.5% (50 bps) | Creator Escrow PSM |
| Platform fee | 1.0% (100 bps) | Platform wallet — ONE destination, no split |
| **Total** | **1.5% (150 bps)** | plus the batcher fee, ceiling &le;1 ADA |

### NIGHT Bond

- **Amount:** $50 USD equivalent in NIGHT (default 100 NIGHT, configurable per launch)
- **Purpose:** Anti-spam + skin-in-the-game for DarkVeil registration
- **Full refund (`claimBondRefund`):** launch cancelled outright, or DarkVeil itself failed (<50% participation) — 100% returned to every registrant in both cases, no forfeiture.
- **Ratio-based refund (`claimRatioBondRefund`):** DarkVeil closed normally. `NIGHT_returned = NIGHT_bonded × tokens_purchased / tokens_allocated` (floored on-chain, computed off-chain). Bought 100% of the flat per-registrant allocation (`baseSlot`) → full refund; bought 0% (ghost) → fully forfeited; anything between is proportional.
- **Forfeited-portion routing:** the forfeited remainder (`bondAmount - claimedRefund`) is paid out in the SAME `claimRatioBondRefund` call — paid whole to the one platform address set at deploy, sent via `sendUnshielded`. Not a cross-PSM call — see §5 below on why that matters.

---

## 9. DarkVeil Protocol

### Phase Lifecycle

```
Inactive ──(startRegistration)──▶ Registration
 │
 │ (startBuying)
 ▼
 Buying
 │
 ┌──────────┼──────────┐
 │ │ │
 (closeDarkVeil) │ (cancelDarkVeil)
 │ │ │
 ▼ ▼ ▼
 Closed (stays) Cancelled
```

### Commitment-Based Buying

1. **Commit:** User computes `commitment = H(buyerKey, launchId, tokenAmount, pricePerToken, nonce)` and submits `commitment + nullifier` to DarkVeil PSM
2. **Hide:** The commitment hash is on-chain, but the inputs are private. Nobody can see the purchase amount or link it to identity.
3. **Prevent double-buy:** The nullifier `H(buyerKey, launchId)` is unique per (user, launch). Submitting it twice is rejected.
4. **Reveal:** After DarkVeil closes, users reveal their commitments by providing the private inputs via witnesses. The PSM recomputes the commitment hash and verifies ownership.
5. **Aggregate:** Revealed amounts update `totalTokensCommitted` and `totalRaisedCommitted`.

### ZK Fair Launch Certificate

When DarkVeil closes, the governor calls `closeDarkVeil(closeTimestamp)` which generates a `FairLaunchCert`:

```
FairLaunchCert {
 launchId: Bytes<32> // Which launch
 totalParticipants: Uint<64> // How many unique buyers
 totalTokensAllocated: Uint<128> // Total tokens sold in DarkVeil
 totalRaised: Uint<128> // Total raised in DarkVeil
 participationRate: Uint<8> // % of allowlist that participated
 closeTimestamp: Uint<64> // When DarkVeil closed
 certHash: Bytes<32> // Unique certificate hash
}
```

This certificate is:
1. **Public** — anyone can verify the DarkVeil was fair
2. **Anchored to Cardano** — stored in a Cardano ZK Anchor contract for permanence
3. **Non-repudiable** — the governor cannot modify it after generation

---

## 10. Bonding Curve Mathematics

The two Cardano curve shapes are deliberately different. The legacy linear curve is the weaker of the two: simple linear pricing, no Midnight dependency at all, and nothing raising the cost of a second wallet. Every current launch type uses the quadratic shape instead — the same cumulative per-wallet-key cap, but behind DarkVeil eligibility and the N-hop challenge, plus a curve that accelerates faster the more of it one wallet buys, which is a second anti-whale mechanic layered on top of the cap. Do not treat one as a simplification of the other.

### both launch types — Quadratic Curve Formula

```
price = basePrice + k * tokensSold^2
 where k = (maxPrice - basePrice) / curveSupply^2
```

**Corrected 2026-07-10:** this quadratic shape is shared by Cardano Launch and Midnight Launch, but they no longer run on the same execution environment. Cardano Launch's public curve is `contracts/cardano/bonding_curve_tier_b.ak` (Aiken, Cardano L1) — the DarkVeil phase before it is the only Midnight-side part of Cardano Launch. Midnight Launch's curve is the Midnight `bonding_curve.compact` merged contract (Section 4.2). Both verify the price via the same multiplication-invariant technique, for different underlying reasons — Aiken/Plutus doesn't forbid division but exact-integer verification is still preferable to rounding; Compact forbids in-circuit division outright:

```
price * curveSupply^2 == basePrice * curveSupply^2 + (maxPrice - basePrice) * tokensSold^2
```

The caller provides `claimedPrice` and the contract verifies this invariant holds (Midnight Launch's Compact version casts to `Field` before squaring/cross-multiplying — `Uint<128> * Uint<128>` trips Compact's static overflow check even for realistic curve parameters). Same `k` derivation — i.e. same curve shape — for both Cardano Launch and Midnight Launch; the two differ only in `currency` (Ada vs Night) and execution environment, not steepness.

#### Example

| Parameter | Value |
|-----------|-------|
| `basePrice` | 0.0001 ADA |
| `maxPrice` | 0.001 ADA |
| `curveSupply` | 850,000,000 (85% of 1B) |
| `priceRange` | 0.0009 ADA |

At 0% sold: price = 0.0001 ADA
At 50% sold: price = 0.0001 + 0.0009 × 0.5² = 0.000325 ADA
At 100% sold: price = 0.001 ADA (10x from start)

Note the quadratic shape stays near `basePrice` for longer and then accelerates — unlike a linear curve's constant rate of increase, which reaches the 50% price point at 50% sold rather than 32.5%.

### Linear Curve Formula (Cardano/Aiken, legacy path)

```
price = basePrice + (tokensSold / curveSupply) * (maxPrice - basePrice)
```

Verified the same way — a multiplication invariant, `price * curveSupply == basePrice * curveSupply + tokensSold * (maxPrice - basePrice)` — though Aiken/Plutus has no circuit-level division restriction, so this is a choice for exactness rather than a hard requirement. Lives in `contracts/cardano/bonding_curve.ak`, entirely separate from the Midnight PSM above. The linear path never touches Midnight — it has no DarkVeil phase to run there.

With the same example parameters, at 50% sold: price = 0.0001 + 0.0009 × 0.5 = 0.00055 ADA — the straight-line midpoint, in contrast to both launch types's quadratic curve above.

### Graduation

**Corrected 2026-07-10.** When `tokensSold == curveSupply`, the curve transitions to `Graduated` state (still just a state flag set inside the buy circuit on the last purchase). What happens next was, for a while, an actual gap: none of `bonding_curve.ak`, `bonding_curve_tier_b.ak`, or the Midnight `bonding_curve.compact` had a code path that moved funds/tokens into the LP at all — `Graduated` was a flag nothing acted on. This is now resolved for Cardano via two new **permissionless** redeemers on the Aiken contracts (not a "merged transaction with LP Escrow PSM" — no such mechanism exists, see Section 5):
1. `Graduate` — verified by real value movement (correct ADA/token amounts leaving the curve contract for the LP Escrow contract), not by a signature. `LP ADA = total raised × 0.985` (net of the 1.5% running fee).
2. `SealLock(timestamp, seeded_ada)` on `lp_escrow.ak` — starts the 365-day lock, verified against the actual amount the curve just seeded.
3. Fee withdrawal availability for governor/creator (`ClaimCreatorFees` etc.)
4. Creator escrow vesting start

Midnight Launch's equivalent is LP seeding into the Midnight LP Escrow PSM (Section 4.6), currently unreachable pending Midnight DEX availability.

---

## 11. Fee Routing

### Per-Buy Fee Split

```
grossPayment = tokenAmount * claimedPrice

creatorFee  = grossPayment * 50  / 10000 (0.5%)
platformFee = grossPayment * 100 / 10000 (1.0%)
netPayment  = grossPayment - creatorFee - platformFee
```

### Fee Accumulators

**Corrected 2026-07-11:** which contract accrues each fee now depends on tier, and Treasury's balance is currency-split, not one number.

| Accumulator | Contract | Withdrawal |
|-------------|-----|------------|
| `creatorFees` (linear) | `bonding_curve.ak` (Cardano) | Via that contract's own `ClaimCreatorFees` |
| `creatorFees` (Cardano Launch, DarkVeil claim + public buy — ONE balance) | `bonding_curve_tier_b.ak` (Cardano) — `creator_fees_accrued` field | Via that contract's own `ClaimCreatorFees` |
| `creatorFees` (Midnight Launch) | merged `bonding_curve.compact` (Midnight) | Via Creator Escrow PSM equivalent circuit |
| `platformFees` (Cardano) | The curve contract itself — `platform_fees_accrued` | Via that contract's single `ClaimPlatformFees` redeemer |
| `platformFees` (Midnight Launch) | merged `bonding_curve.compact` — `platformFees` | Via that contract's own `withdrawFees` |

### Important: Two Distinct Income Streams

The creator has two separate income sources that are never combined. Cardano Launch's Bonding Curve Escrow is ONE balance now (superseding an earlier description of "two Stream A1/A2 balances" — Stream A1 never actually accrued a real fee, since Compact could never enforce Cardano Launch's ADA payment):

1. **Bonding Curve Escrow** — fixed amount raised during the curve (held in Creator Escrow and/or the curve contract itself depending on tier, vested over 90-365 days)
2. **LP Trading Fees** — ongoing fees from DEX trading post-graduation, harvested via `HarvestFees` — DEX-agnostic, verifies only that the Noctis-side LP position is untouched and the correct recipient was paid, not the DEX-specific harvest call itself

---

## 12. LP Lock and DEX Migration

> **Note (2026-07-10):** these design principles apply identically to both execution environments — Cardano's `lp_escrow.ak` (both Cardano curves) and Midnight's LP Escrow PSM (Midnight Launch only, Section 4.6) — but the two are separate contracts, not one shared mechanism. The flow below was written against the Compact PSM's circuit names (`sealLock`, `migrateLp`); the Cardano contract uses the equivalent redeemers (`SealLock`, `MigrateLp`, plus `Graduate` upstream of it — see Section 10's correction) with the same invariants.

### Design Principles

1. **365-day minimum lock** — enforced at contract level (`lockDuration >= 31536000`)
2. **No withdraw function** — by design. There is no way to extract LP tokens. (Distinct from `ClaimBuyback` — see CLAUDE.md's Key Design Principles §5 — which only exists pre-graduation on a force-cancelled curve that never seeded an LP, and never touches `lp_escrow.ak`.)
3. **DEX migration only** — after lock expiry, LP can only move to a whitelisted DEX
4. **Governance-gated whitelist, resolved for real (2026-07-10):** the Cardano whitelist previously only required one governor signature with immediate effect, despite the contract's own file header already claiming "multisig + 72h notice." Now genuinely implemented as three redeemers: `ProposeDexChange` (requires `multisig_threshold`-of-`multisig_signers` real signatures, starts a 72h public-notice clock), `ExecuteDexChange` (permissionless once the notice period elapses — the public proposal window is itself the authorization, same idiom as `ExpireCurve`/`Graduate`), and `CancelPendingDexChange` (lets the multisig withdraw a proposal early).

### Migration Flow

```
LP Escrow Deployed
 │
 ▼
sealLock(timestamp) ──▶ Lock starts (365-day countdown)
 │ (Cardano: SealLock(timestamp, seeded_ada), called permissionlessly     
 │ right after Graduate verifies real value moved into the LP)
 │ Phase 3 fix (2026-07-12): timestamp is now bound to real chain time
 │ (blockTimeGte/blockTimeLte, ±1 hour) — a governor can no longer seal
 │ the lock with an artificially old timestamp to fast-forward expiry
 │
 │ ... 365 days pass (real chain time, not a claimed value) ...
 │
 ▼
isLockExpired ──▶ true
 │ Phase 3 fix: no longer takes a currentTimestamp parameter — reads
 │ blockTimeGte(lockTimestamp + lockDuration) directly
 │
 ▼
migrateLp(dexAddr)
 │ Phase 3 fix: no longer takes a currentTimestamp parameter either —
 │ same reasoning, removes the "any caller can claim expiry passed by
 │ lying about the time" gap entirely rather than just bounding it
 │
 ├─ Verify: lpState == Locked
 ├─ Verify: blockTimeGte(lockTimestamp + lockDuration)
 ├─ Verify: dexAddr in dexWhitelist (whitelist changes now gated by the multisig+72h flow above)
 │
 ▼
lpState = Migrated
 │
 ▼
LP tokens move to DEX (via Zswap layer on Midnight; direct DEX interaction on Cardano)
```

---

## 13. ZK Fair Launch Certificate

### Purpose

The ZK Fair Launch Certificate proves that a DarkVeil phase was conducted fairly, without revealing individual participation details. It is:

- **Publicly verifiable** — anyone can check the certificate hash
- **Anchored to Cardano** — stored permanently on Cardano L1
- **Aggregate only** — contains totals, not individual records

### Certificate Generation

The certificate is generated when the governor calls `closeDarkVeil(closeTimestamp)`:

```compact
certHash = persistentHash(launchId, totalParticipants, totalTokensAllocated, totalRaised, closeTimestamp)
```

### Cardano Anchor

For both launch types launches, the certificate is anchored to Cardano via an Aiken ZK Anchor contract that:
1. Stores the certificate hash permanently
2. Allows anyone to verify the certificate matches on-chain DarkVeil data
3. Serves as a permanent public record of launch fairness

---

## 14. Cardano Integration

### Blockfrost Integration

- **Purpose:** Cardano L1 indexing (UTXOs, transactions, asset metadata)
- **Primary:** Blockfrost API
- **Fallback:** Maestro, Koios
- **Usage:** Token minting, DEX interaction, LP escrow management

### Orcfax Oracle Integration

- **Purpose:** ADA/USD price feed for NIGHT bond calculation
- **Primary:** Orcfax oracle
- **Secondary:** Minswap TWAP
- **Usage:** Convert $50 USD bond requirement to NIGHT amount at registration time

### DEX Graduation

- **Default DEX:** CSwap
- **Whitelist:** Minswap, Splash, WingRiders, SundaeSwap
- **Selection:** Creator chooses at launch wizard
- **LP Pair:** Token/ADA (Cardano) or Token/NIGHT (Midnight Launch, when available)

### Real off-chain DarkVeil eligibility checks (2026-07-12)

`integration/eligibility-checker.ts` implements checks #1 (wallet age ≥ 90 days) and #5 (no direct ADA flow from creator, 90-day lookback) for real, against live Blockfrost data — `checkWalletAge` walks an address's full transaction history to find its earliest activity; `checkNoDirectAdaFlow` scans a registrant's transactions in the lookback window and fetches each one's real inputs/outputs to check whether the creator's address appears on either side. These are meant to run over every DarkVeil applicant **before** the platform builds the allowlist Merkle tree the merged Eligibility Gate/DarkVeil contract (4.1) verifies membership against — see Section 6 for the corrected privacy model this implies. Check #2 (NIGHT balance) is confirmed achievable via `midnight-indexer`'s `unshieldedTransactions` subscription but not yet built; check #4 (stake key match) needs real cross-chain proof machinery that doesn't exist yet.

### N-Hop Challenge Contract (2026-07-12 — Cardano Launch only, Cardano-side)

`contracts/cardano/validators/nhop_challenge.ak` is a new standalone Cardano validator implementing CLAUDE.md's N-hop Sybil challenge window. It lives on Cardano rather than as an eighth Midnight PSM because its reporter bond is ADA-denominated — the same cross-chain reasoning that moved Cardano Launch's public curve to Cardano applies here. It triggers after a registrant's real Cardano wallet becomes public via their `ClaimDarkVeilTokens` call (see Section 4.1), not at registration, for the same privacy reason described throughout this document: nobody's real wallet is linked to DarkVeil participation until they claim. One UTXO per challenge, no continuing datum (resolution is a terminal spend); governor-adjudicated (the underlying transaction-graph evidence can't be verified inside a script); pays the challenger's 25 ADA bond back in full if upheld, or forfeits it to the platform wallet if rejected. Midnight Launch is unaffected — it's already fully build-blocked independent of this feature (see the open issues list).

---

## 15. DIDz Ecosystem Integration

Noctis is part of the DIDz ecosystem, a suite of privacy-preserving identity and application tools built on Midnight Network.

### Three-Pillar Model

| Pillar | Role in Noctis |
|--------|---------------|
| **DIDz** (root identity) | Traders hold a DIDz; Noctis verifies allowlist membership via ZK proofs without revealing identity |
| **AgenticDID** (agent authority) | Creators can delegate scoped authority to agents for launch management (e.g., allowlist updates, phase transitions) |
| **RWAz** (object identity) | Asset verification for real-world asset tokens launched on Noctis (prove ownership without revealing the asset) |

### midnight-modules Reuse

| Module | Noctis PSM | How It's Used |
|--------|-----------|---------------|
| `access-control` | All PSMs | Admin/governor pattern for circuit authorization |
| `commitment-nullifier` | DarkVeil, Bonding Curve | Double-spend prevention for buy orders, NIGHT bond locking |
| `merkle-membership` | Eligibility Gate | Allowlist verification without revealing identity |
| `oracle-attestation` | Bonding Curve | Orcfax price feed verification for ADA/NIGHT conversion |
| `liveness-timer` | Creator Escrow, LP Escrow | Vesting schedule enforcement, escrow time locks |

---

## 16. SilentLedger Architecture Mapping

SilentLedger is a privacy-preserving orderbook DApp on Midnight. Its three contracts map directly to Noctis PSMs:

### AssetVerification → Eligibility Gate

| SilentLedger | Noctis | Reused Pattern |
|--------------|--------|----------------|
| ZK ownership proof | ZK allowlist membership proof | Prove eligibility without revealing identity |
| Composite key hashing | Cumulative purchase tracking | Flatten (owner, asset) → single key |
| Replay prevention via proof hash | Double-registration prevention via nullifier | One-time use of proofs |

### SilentOrderbook → DarkVeil

| SilentLedger | Noctis | Reused Pattern |
|--------------|--------|----------------|
| Commitment-based orders | Commitment-based buy orders | Hide order details in hash |
| ownerHash privacy | UserPublicKey privacy | Identity not revealed |
| Match/cancel lifecycle | Submit/cancel/reveal lifecycle | Order state machine |
| Batch root updates | ZK Fair Launch Certificate | Aggregate state commitment |

### ObfuscatedOrderbook → Bonding Curve

| SilentLedger | Noctis | Reused Pattern |
|--------------|--------|----------------|
| Price-tagged orders | Price-verified buys | Price attached to each order |
| Fill matching | Graduation trigger | Complete when fully matched |
| Sell-side verification gating | Cap enforcement via eligibility gate | Gate before allowing action |

---

## 17. Data Flow Diagrams

### Cardano Launch Launch (End-to-End)

> **Corrected 2026-07-10.** Steps 4, 12, and 13 previously described a Midnight-side bonding curve and a "merged transaction" cap check — neither exists. Updated to match the real split: Midnight for DarkVeil only, Cardano for everything public.

```
Creator
 │
 ├──(1) Configure launch on noctis.zone
 │
 ▼
Launch Wizard
 │
 ├──(2) Deploy Eligibility Gate + DarkVeil as ONE contract (Midnight —
 │ eligibility_gate.compact, Phase 2 2026-07-11; darkveil.compact deleted)
 │ • Set allowlistRoot, cumulativeCap, bondAmount, dvAllocation, dvPrice
 │
 ├──(3) Deploy Bonding Curve — Cardano only (bonding_curve_tier_b.ak),
 │ including the ClaimDarkVeilTokens settlement redeemer.
 │ A Cardano Launch has no Midnight-side bonding curve.
 │
 ├──(4) Deploy LP Escrow (Cardano — lp_escrow.ak, multisig-gated whitelist)
 │
 ├──(5) Deploy Creator Escrow (Midnight) — deployed for shape parity, but never
 │ actually accrues a real fee here (Compact can't enforce ADA
 │ payment); every creator fee accrues on the Cardano curve instead
 │
 └──(6) Deploy Treasury (Midnight — currency-split ADA/NIGHT ledger)
 
Participants
 │
 ├──(7) Register for DarkVeil
 │ • Prove allowlist membership (ZK)
 │ • Lock NIGHT bond
 │ • Get nullifier (prevents double-registration)
 │ • Rejected if registrant == creator
 │
 ├──(8) Submit buy commitment
 │ • Compute commitment = H(buyerKey, launchId, amount, price, nonce)
 │ • Submit commitment + nullifier
 │ • Amount is HIDDEN
 │
 ├──(9) DarkVeil closes
 │ • Governor calls closeDarkVeil
 │ • ZK Fair Launch Certificate generated
 │ • Relayer anchors the certificate + a dv_allocation_root — a Merkle
 │ root over each registrant's private (vkh, amount, salt) allocation,
 │ NOT a plaintext list (an earlier design published every
 │ registrant's amount on Cardano at this step, regardless of whether
 │ they ever transacted again; that's fixed now)
 │
 ├──(10) Reveal buy commitment
 │ • Provide private buy data via witnesses
 │ • PSM recomputes commitment, verifies ownership
 │ • Amount becomes part of this Midnight contract's own on-chain
 │ ledger state (inherent to commit/reveal — unrelated to the
 │ Cardano settlement fix, and unchanged by it). NO ADA moves here — Compact can't custody ADA.
 │
 ├──(11) Claim DarkVeil tokens (Cardano, bonding_curve_tier_b.ak)
 │ • Buyer presents their own (dv_amount, salt, merkle_proof), proven
 │ against the anchored dv_allocation_root
 │ • Pays dv_amount * base_price in real ADA, receives the tokens
 │ • Nullified in dv_claimed so it can't be claimed twice
 │ • Rejected if buyer == creator
 │ • Draws on the SAME 5% cap a public buy draws on: the claim carries
 │ this wallet's running total plus a proof of it, and writes back the
 │ updated cap_root
 │
 ├──(12) Public bonding curve (Cardano, bonding_curve_tier_b.ak)
 │ • Buy tokens at quadratic price, tokens mint directly to buyer
 │ • 5% cap enforced against the SAME cap_root step 11 updates — a
 │ normal Cardano contract check, not a cross-chain or cross-PSM call
 │ • Rejected if buyer == creator (closes the same gap the public
 │ curve previously had)
 │ • Fees: 0.5% creator / 1.0% platform — ONE balance
 │ now (supersedes an earlier two-stream description)
 │
 ├──(13) Graduation
 │ • tokensSold == curveSupply
 │ • Anyone calls Graduate — verified by real value movement, not a
 │ signature; moves LP ADA/tokens from the curve into lp_escrow.ak
 │ • Anyone calls SealLock(timestamp, seeded_ada) — starts the
 │ 365-day lock, verified against what Graduate actually seeded
 │ • Creator escrow vesting starts
 │
 └──(14) Post-graduation
 • Trading on DEX; pool fees harvested via HarvestFees
 • Creator claims vested amounts (90-365 days) and Stream A2 fees
 via ClaimCreatorFees on the Cardano curve contract
 • Governor withdraws treasury fees
 • After 365 days + the multisig+72h proposal process: LP migrates to a
 newly-whitelisted DEX
```

---

## 18. Failure Paths

### DarkVeil Underparticipation (resolved 2026-07-09 — corrected here 2026-07-10)

**Corrected:** this used to describe a governor-discretion `cancelDarkVeil` outcome. The real, resolved design is **Option B, not discretionary**: if DarkVeil fails (below the 50% participation threshold), the launch automatically **converts to a Tier-A-equivalent public launch** — it does not die. The bonding curve opens immediately without ever running a DarkVeil phase, priced from the same P₀ DarkVeil would have used. The creator loses the privacy phase but the launch stays alive: no partial launch-fee refund, no restart cooldown.

**Trigger:** participation measured against the 50% threshold at `T + 24h` (DarkVeil close); governor calls `markDarkVeilFailed` (Midnight Launch — a dedicated ledger flag, independent of `phase`, added specifically because the original `phase == Cancelled` gate couldn't represent "converted to public, not cancelled").

**Consequences:**
- Launch `phase` → `Public` (not `Cancelled`) — the bonding curve proceeds
- All NIGHT bonds become **fully** refundable (100% — DarkVeil's "phase failed → 100% returned, no forfeiture" rule) via `claimBondRefund`, which now actually pays out via `sendUnshielded` rather than only clearing the ledger
- Buy commitments that were never revealed simply have no effect — no tokens were allocated from the failed DarkVeil phase
- Full cancellation (curve never opens at all) is a separate, narrower path reserved for confirmed fraud or regulatory intervention — see Bonding Curve Cancellation below

### Bonding Curve Cancellation

**Trigger:** Governor calls `cancelCurve` — used when:
- DarkVeil reveals show fraud
- Regulatory intervention
- Technical failure before graduation

**Consequences:**
- Curve state → `Cancelled`
- No further buys possible
- Existing buyers retain their token balances
- Fees remain in accumulators (governor can withdraw)

### Stalled Curve Timeout + Principal Buyback (added 2026-07-10)

This subsection didn't exist in the original document — it covers a real gap found and closed this session: 100%-sell-through-only graduation means a curve stuck at 95-99% sold sat in perpetual limbo with no timeout and no way to recover the ADA/NIGHT already raised.

**Trigger:** `MAX_CURVE_DURATION_DAYS` (90 days, platform constant) elapses on a curve still `Active` and not `Graduated`. Anyone (not just the governor) can then call `ExpireCurve` — permissionless by design, verified purely against the deadline having passed, same idiom as `Graduate` and `ExecuteDexChange`: the passage of time is itself the authorization, no signer needed.

**Consequences:**
- Curve state → `Expired`
- **Cardano (Option A — pro-rata buyback):** a new `ClaimBuyback` redeemer lets each token holder return their curve tokens to reclaim a proportional share of the stranded ADA still sitting in the curve contract. This is principal recovery, not a trading exit — it only exists pre-graduation on a curve that never seeded an LP. It does not touch LP tokens, does not exist on `lp_escrow.ak`, and must not be confused with LP withdrawal (which does not exist anywhere in the protocol — see CLAUDE.md's Key Design Principles §5).
- **Midnight Launch:** no buyback redeemer yet — timeout mechanism (`ExpireCurve`-equivalent) is implemented, but Option A was scoped to Cardano only; a Midnight Launch equivalent is unbuilt.

### LP Escrow Edge Cases

**Lock never sealed:** If governor never calls `sealLock`, the lock timestamp remains 0. `isLockExpired` will return true once real chain time passes `0 + 31536000` (Phase 3, 2026-07-12: this now reads real chain time via `blockTimeGte`, not a caller-supplied claim), but `migrateLp` requires governor authorization, so LP is effectively frozen until governor acts.

**DEX not whitelisted:** If no DEX is whitelisted when lock expires, LP remains locked until governor adds a DEX to the whitelist. This is by design — it forces conscious DEX selection.

---

## 19. Glossary

| Term | Definition |
|------|-----------|
| **PSM** | Private State Machine — Midnight's smart contract equivalent |
| **Compact** | The programming language for Midnight PSMs |
| **DarkVeil** | Noctis's private pre-sale phase using ZK commitments |
| **NIGHT bond** | Anti-spam deposit required for DarkVeil registration |
| **ZK Fair Launch Certificate** | Cryptographic proof that DarkVeil was fair |
| **Witness** | Private input to a Compact circuit, provided by the prover |
| `disclose` | Compact function that makes a private value visible on-chain |
| `sealed ledger` | Compact ledger field that can only be set once (at deploy) |
| `persistentHash` | Compact's deterministic hashing function |
| **Contract merging** | The only real cross-PSM mechanism: folding multiple `.compact` source files into one deployed contract at compile time (`include`/`module`), sharing one ledger. Not a runtime/transaction-level mechanism — corrected 2026-07-10, see Section 5. There is no such thing as "transaction merging" in Compact. |
| **Nullifier** | Unique hash that prevents double-actions without revealing identity |
| **Commitment** | Hash of private data that hides the data but enables later verification |
| **Graduation** | When a bonding curve sells all tokens and transitions to DEX trading |
| **Allowlist root** | Merkle tree root of eligible addresses for DarkVeil |
| **Cumulative cap** | 5% per-wallet limit enforced across DarkVeil + public phases |
| **UserPublicKey** | Witness-derived identity (domain-separated hash of private secret) |

---

*This document is the authoritative architecture reference for the Noctis Zone. For protocol constants and design principles, see [CLAUDE.md](../CLAUDE.md). For open issues and build blockers, see internal tracking.*
