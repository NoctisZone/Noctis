# Architecture — Noctis Zone

High-level structural diagrams for the protocol. For full contract specs, constants, and open design questions, see [CLAUDE.md](CLAUDE.md), internal tracking — this file is a visual reference, not the source of truth for any individual decision.

> **Keeping this file current:** this diagram set (plus `README.md`, `architecture.html`, and `docs/PSM_ARCHITECTURE.md`) needs a real update pass whenever a major architectural fact changes — a contract merges/splits, a new validator ships, a feature's build status moves. It's easy for these to silently drift behind internal tracking (the actual source of truth) since nothing forces a re-read. Check it against current contract/test-count reality periodically, not just when someone notices it's wrong.
>
> **Recent structural changes:** Tier A was proven end-to-end on real Preprod (mint → buy → graduate → vest → stall/buyback); a `cto_sybil_challenge.ak` validator shipped; multiple full adversarial security review passes landed across both chains, with all findings resolved or explicitly accepted and documented internally; CTO Governance's off-chain backend was built out (voter identity, balance-snapshot builder, relay, badge) though the vote-casting transaction layer is still unbuilt; and the Staking Rewards Pool gained a real browser-wallet-signed stake/unstake/claim UI, plus a dedicated cross-launch staking page. **A full Midnight/Compact PSM security audit also landed 2026-07-30** — see the note below the diagrams and `local/OPEN_ISSUES.md` for detail; the diagrams themselves are unaffected (the fixes changed circuit-internal logic, not the contract-merge/tier-routing shape these diagrams document). Current counts (re-verified 2026-07-30, real compile+test runs, not carried forward from an earlier note): **10 Aiken validators / 285 checks, 8 Compact PSMs / 280 tests**.
>
> **2026-07-28 — `token_metadata.ak` shipped (CIP-68 on-chain logo, Tier A):** a new validator + one-shot minting policy for a mutable, creator/CTO-controlled reference-NFT logo — not a mint-time-only metadata blob, which would be impossible anyway since the platform's minting policy is time-locked. Audited on its own immediately after being written (5 findings, all fixed — a forgeable one-shot mint / unchecked reference-NFT spend was the most serious). A real Lucid Evolution submitter (`integration/token-metadata-submitter.ts`) builds unsigned mint/update transactions for the creator's own wallet to sign, same pattern as every other browser-signed action on this platform — one real bug found and fixed in it too (a hand-rolled `Credential` schema didn't match Aiken's real one-positional-field encoding). **Not yet wired into the Create Wizard or a Token Profile page** — the contract and submitter are real and tested; the WordPress-side upload/display/profile-page work (outside this repo) is still pending.
>
> **2026-07-24 (off-chain only — no contract or test-count change):** three Tier B gaps closed in the integration layer. **(1)** The shared TypeScript datum schemas were re-synced to the contracts and verified field-for-field, with encode + round-trip decode confirmed. **(2)** A **Tier B graduation submitter** now exists (`tier-b-graduation-submitter.ts` + `graduate-tier-b-launch` CLI + `np_graduate_tier_b_launch()`), mirroring the Preprod-proven Tier A flow (Graduate + SealLock + StartVesting, two-transaction split, seconds-scale timestamps); `lp_escrow`/`vesting` are shared validators, and Tier B's `Graduate` arm was verified structurally identical to Tier A's before porting. **(3)** A **Tier B mint path** now exists — the genesis builder takes a `tier` parameter, so a Tier B launch builds a real `BondingCurveTierBDatum` at the `bonding_curve_tier_b.ak` address. Verified against the contract that DarkVeil claims draw from the same `curve_supply` — no separate Tier B carve-out at genesis. Cardano-side Tier B is now wired end-to-end (mint → activate → buy → DV-claim → graduate); Preprod verification is the next step. **A real `SellTokens` redeemer for Tier B also shipped since** (mirroring Tier A's own `SellTokens`, quadratic pricing + floor-rounded fees adapted) — Tier B's Cardano-side curve now supports both directions, not buy-only.

## Table of Contents

- [System Overview](#system-overview)
- [Midnight PSM Flow (DarkVeil, Tier B/C)](#midnight-psm-flow-darkveil-tier-bc)
- [Midnight Wallet Operations (off-chain)](#midnight-wallet-operations-off-chain)
- [Graduation Flow (Tier A/B — LP Seeding)](#graduation-flow-tier-ab--lp-seeding)
- [Failure & Refund Flow (Stuck Curve, Cancelled Launch)](#failure--refund-flow-stuck-curve-cancelled-launch)
- [CTO Governance Flow](#cto-governance-flow)
- [Contract-to-Tier Reference](#contract-to-tier-reference)

---

## System Overview

Tier A never touches Midnight — it's Aiken-only. Tier B is dual-chain: one merged Midnight PSM handles DarkVeil registration/private-buying only; the public bonding curve, LP Escrow, CTO Governance, and the ZK Anchor all live on Cardano L1 (moved off Midnight entirely once DarkVeil closes, since the public phase needs no privacy and Cardano can enforce real payment natively — 2026-07-09). Tier C moves everything onto Midnight — including the bonding curve, merged into one contract with Eligibility Gate and DarkVeil — except the ZK Fair Launch Certificate anchor and CTO Governance, which are relayed to Cardano L1 for public verifiability even though the launch itself is Midnight-native.

```
NOCTIS ZONE

┌───────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
│ TIER A            │ │ TIER B                   │ │ TIER C                   │
│ Cardano Only      │ │ Cardano + DV             │ │ Midnight + DV            │
├───────────────────┤ ├──────────────────────────┤ ├──────────────────────────┤
│ Bonding Curve     │ │ ┌──────────────────────┐ │ │ ┌──────────────────────┐ │
│ (linear, ADA)     │ │ │ MERGED CONTRACT      │ │ │ │ MERGED CONTRACT      │ │
│ LP Escrow         │ │ │ (Phase 2, Midnight): │ │ │ │ Eligibility Gate +   │ │
│ CTO Governance    │ │ │ Eligibility Gate +   │ │ │ │ DarkVeil + Bonding   │ │
│ Vesting           │ │ │ DarkVeil, one shared │ │ │ │ Curve, ONE shared    │ │
└───────────────────┘ │ │ ledger               │ │ │ │ ledger, NIGHT-priced │ │
                      │ └──────────────────────┘ │ │ └──────────────────────┘ │
                      │                          │ │                          │
                      │ Bonding Curve (quad.,    │ │ Creator Fee Escrow (MN)  │
                      │ Cardano, ADA) +          │ │ Vesting (MN)             │
                      │ ClaimDarkVeilTokens      │ │ Treasury (MN)            │
                      │ (Merkle-root DV          │ │ LP Escrow (MN)           │
                      │ settlement)              │ │ CTO Governance           │
                      │                          │ │ (Aiken, relayed)         │
                      │ Creator Fee Escrow       │ │ ZK Cert Anchor           │
                      │ (Cardano curve's own     │ │ (Aiken, relayed)         │
                      │ accrual only —           │ └──────────────────────────┘
                      │ supersedes old           │                             
                      │ two-stream split)        │                             
                      │                          │                             
                      │ Vesting (MN)             │                             
                      │ Treasury (MN)            │                             
                      │ LP Escrow (Aiken)        │                             
                      │ CTO Governance           │                             
                      │ ZK Cert Anchor           │                             
                      └──────────────────────────┘                             

          │                         │                            │
          ▼                         ▼                            ▼
       ┌──────────────────────────────────────────────────────────────┐
       │                      INTEGRATION LAYER                       │
       │  Blockfrost · Orcfax Oracle · Midnight SDK · Wallet Connect  │
       └──────────────────────────────────────────────────────────────┘

          │                         │                            │
          ▼                         ▼                            ▼
┌───────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│ CARDANO L1        │ │ CARDANO L1 +        │ │ MIDNIGHT NET +      │
├───────────────────┤ │ MIDNIGHT NET        │ │ CARDANO L1          │
│ Aiken:            │ ├─────────────────────┤ ├─────────────────────┤
│ Bonding Curve,    │ │ Aiken: Bonding      │ │ Compact: 6          │
│ LP Escrow, CTO    │ │ Curve (Tier B,      │ │ PSMs (incl. the     │
│ Governance,       │ │ incl. DV claim),    │ │ merge);             │
│ Vesting           │ │ LP Escrow, CTO      │ │ Aiken: ZK           │
└───────────────────┘ │ Gov, ZK Anchor      │ │ Anchor + CTO        │
                      │ Compact: Elig.      │ │ Gov (relayed)       │
                      │ Gate + DarkVeil     │ └─────────────────────┘
                      │ (merged, Phase 2)   │                        
                      │ + 4 shared PSMs     │                        
                      └─────────────────────┘                        
```

**Reading this diagram:** Tier A's four contracts are all Aiken, all on Cardano L1 — no Midnight dependency exists anywhere in Tier A. Tier B's public bonding curve is **Aiken on Cardano** (`bonding_curve_tier_b.ak`, quadratic, ADA-priced) — DarkVeil registration/private-buying stays on Midnight as one **merged** PSM (Eligibility Gate + DarkVeil, Phase 2 2026-07-11 — the two were originally standalone; merging them let the ratio-based NIGHT bond refund logic reach both circuits). A DarkVeil purchase's actual ADA payment and token delivery happen back on Cardano, via `ClaimDarkVeilTokens` on the curve contract (2026-07-11) — a privacy-preserving Merkle-root claim, not the plaintext per-registrant list this diagram previously described. Tier C's Eligibility Gate + DarkVeil + Bonding Curve are **one merged Compact contract** — Compact has no working cross-contract call mechanism, so folding the three source files into one deployed contract with a shared `cumulativePurchases` ledger was the only way to make the 5% cumulative cap real across both the DarkVeil and public phases. Creator Fee Escrow and Vesting are always separate contracts — CLAUDE.md explicitly warns against conflating a creator's trade-fee income with their token vesting schedule. Tier B's Creator Fee Escrow is a single balance accrued entirely in the Cardano curve contract (supersedes the old "two Stream A1/A2 balances" description — Stream A1 never actually existed as a real accrual).

---

## Midnight PSM Flow (DarkVeil, Tier B/C)

The DarkVeil registration → private-buy sequence. **Correction (2026-07-10):** this diagram previously described "transaction merging" as the mechanism connecting these PSMs — that claim was never actually verified and turned out to be wrong. A dispatched research agent compiled real probe contracts against the installed Compact compiler and confirmed there is no working cross-contract-call mechanism of ANY kind — not a call, not a merged transaction, nothing. The only thing that actually works is **compile-time contract merging** (`include`/`module` directives folding multiple `.compact` files into one deployed contract with one shared ledger) — which is exactly what the merge did for Tier C (collapsing three source files into one deployed contract) and what Phase 2 (2026-07-11) later did for Tier B too (collapsing `eligibility_gate.compact` and the now-deleted `darkveil.compact` into one deployed contract, still named `eligibility_gate.compact`). Both boxes below are the SAME deployed contract for both tiers now — shown separately here only to keep their distinct responsibilities (registration/cap vs. commit/reveal) readable. What's still genuinely cross-chain for Tier B is the link to the Cardano bonding curve below it: registration/buying happens on Midnight, but real ADA payment and token delivery for a DarkVeil purchase happen on Cardano via `ClaimDarkVeilTokens` — no atomic link between the two, CLAUDE.md defaults to a 10-minute settlement window instead.

```
Launch Wizard
 │
 ▼
┌───────────────────────┐ ┌───────────────────────┐
│ ELIGIBILITY GATE      │ │ DARKVEIL              │
├───────────────────────┤ ├───────────────────────┤
│ (Tier B: merged       │ │ (Tier B: merged       │
│ into one contract     │ │ into the SAME         │
│ with DarkVeil,        │ │ contract as Elig.     │
│ Phase 2, 2026-07-11   │ │ Gate, Phase 2 —       │
│ — eligibility_gate    │ │ eligibility_gate.     │
│ .compact;             │ │ compact;              │
│ Tier C: merged into   │ │ Tier C: merged into   │
│ Bonding Curve)        │ │ Bonding Curve)        │
│                       │ │                       │
│ Allowlist verify      │ │ Commitment buy        │
│ 5% cumulative cap     │ │ Buy reveal            │
│ track                 │ │ (post-close)          │
│ NIGHT bond lock       │ │ ZK cert gen           │
│ Bond refund           │ │ Failure path          │
│ (claimBondRefund,     │ │ (<50% → refund        │
│ claimRatioBond-       │ │ all)                  │
│ Refund)               │ │ Tier B: no ADA        │
└───────────────────────┘ │ payment here —        │
                          │ real payment lives    │
                          │ on Cardano now,       │
                          │ see below             │
                          └───────────────────────┘
                         │
                         │ Tier B: no atomic link to the curve below (10-min
                         │ settlement window default). Tier C: same contract,
                         │ no gap — see System Overview.
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ BONDING CURVE — Tier B: Aiken/Cardano (bonding_curve_tier_b.ak) │
│ incl. ClaimDarkVeilTokens — settles a DV buyer's private        │
│ purchase for real: ADA payment + token delivery, verified       │
│ against a relayer-anchored Merkle root, not a plaintext         │
│ per-registrant list (2026-07-11)                                │
│ Tier C: Compact, merged with the two above                      │
│ Quadratic price (shared k) · 1.5% fee split (0.5 creator/1.0)   │
│ Graduation @ 100% sell-through · stall timeout (90 days)        │
└─────────────────────────────────────────────────────────────────┘
                                               │
           │                       │                       │                       │
           ▼                       ▼                       ▼                       ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│ CREATOR FEE ESCROW  │ │ VESTING PSM         │ │ TREASURY PSM        │ │ LP ESCROW PSM       │
│ PSM                 │ │                     │ │                     │ │                     │
├─────────────────────┤ ├─────────────────────┤ ├─────────────────────┤ ├─────────────────────┤
│ 0.5% fee accum.     │ │ 90-365d vest,       │ │ 1.0% fee accum.     │ │ 365-day lock        │
│ Monthly claim       │ │ no default          │ │ Governor withdraw   │ │ NO withdraw         │
│ (silence-lock       │ │                     │ │ (USDM               │ │ — ever              │
│ gated)              │ │                     │ │ conversion)         │ │ DEX migrate         │
│                     │ │                     │ │ + 60% of forfeited  │ │ (multisig +         │
│                     │ │                     │ │ Tier C DV bonds     │ │ 72h notice)         │
└─────────────────────┘ └─────────────────────┘ └─────────────────────┘ └─────────────────────┘
                                                           ▲
                                                          │ 40% of forfeited
                                                          │ Tier C DV bonds
                                                     OPS WALLET
```

**Reading this diagram:** Creator Fee Escrow and Vesting are two distinct PSMs, deliberately not shown as one box — CLAUDE.md flags conflating them as "a common source of confusion." Fee Escrow accrues 1.0% of bonding-curve trades and pays out monthly (subject to the silence lock); Vesting controls when and how fast the creator's *token allocation* (not fees) releases, on a 90–365 day schedule the creator must actively choose. LP Escrow fans out from the Bonding Curve because graduation (100% sell-through) is what triggers LP seeding — **resolved 2026-07-10**, see the Graduation Flow diagram below for the real mechanism. Once locked, LP Escrow also supports **HarvestFees**: a DEX-agnostic redeemer that lets Stream B trading fees reach the creator (or the CTO community wallet) without ever touching the locked LP position itself — the real per-DEX harvest call (CSwap/Minswap/Splash/WingRiders/SundaeSwap each differ) still isn't confirmed, only the Noctis-side invariants (LP untouched, correct recipient paid) are enforced on-chain.

---

## Midnight Wallet Operations (off-chain)

Everything above is what the contracts do. This is what has to be true of a
wallet *before* it can call any of them.

A Midnight transaction is paid for in DUST, and DUST is generated by NIGHT that
has been explicitly registered for generation — holding NIGHT is not enough, and
the wallet SDK never registers implicitly while balancing a transaction. A wallet
also has to replay enough chain history to see that DUST before it can spend it.
Those two facts give the platform a fixed sequence to run once per wallet, which
the diagram below describes.

The replay is the expensive half. A dust sub-wallet's state grows as it advances
and does not collapse (upstream `midnightntwrk/midnight-wallet#639`), so the
design treats a replay as something a process is allowed to lose: snapshots make
progress durable while it is still running, and a supervisor gives each attempt a
fresh process to continue in. Progress therefore accumulates across attempts.

```
Platform operator (a CLI — no browser wallet is involved on this path)
 │
 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ REGISTER NIGHT FOR DUST GENERATION                                       │
│ integration/cli/midnight-register-dust.ts        (once per wallet)       │
├──────────────────────────────────────────────────────────────────────────┤
│ Holding NIGHT pays for nothing. A NIGHT UTXO generates the DUST that     │
│ fees are priced in only once it has been registered, and registration    │
│ is its own transaction — the SDK never does it while balancing.          │
│                                                                          │
│ Self-funding: the fee is claimed from what the registered coins have     │
│ already generated, so a wallet holding no DUST can still register.       │
│ Registration state is read from the chain, so a re-run reports that      │
│ there is nothing to do rather than submitting a second time.             │
└──────────────────────────────────────────────────────────────────────────┘
 │
 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ REPLAY TO A SPENDABLE DUST BALANCE                                       │
│ integration/cli/midnight-sync-wallets.ts                                 │
├──────────────────────────────────────────────────────────────────────────┤
│ Each attempt runs in its own child process with a fresh heap and         │
│ resumes from the last snapshot, so replay progress accumulates across    │
│ attempts rather than restarting with each one.                           │
│                                                                          │
│ One invocation replays its wallets in turn, and several invocations can  │
│ run side by side. Memory is not what limits that — ten wallets together  │
│ held about 1.5 GB. Throughput is: a wallet alone advanced at ~230        │
│ blocks/sec and ~130 with nine siblings, contending for one indexer.      │
└──────────────────────────────────────────────────────────────────────────┘
 │  every 30 seconds, and once more on the way out
 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ SNAPSHOT STORE                                                           │
│ integration/midnight-wallet-state-store.ts                               │
├──────────────────────────────────────────────────────────────────────────┤
│ serializeState() per sub-wallet, encrypted with AES-256-GCM under a      │
│ PBKDF2-derived key. Snapshots are taken during replay, not after it,     │
│ so progress is durable from the first minute.                            │
│                                                                          │
│ Written to a temporary file and renamed into place, so a process         │
│ killed mid-write leaves either the previous complete snapshot or the     │
│ new one — never a torn file that would discard the whole history.        │
│                                                                          │
│ Restored only when SDK version, network and seed fingerprint all         │
│ match; any mismatch replays from chain instead. Snapshots live           │
│ outside the repository: they describe real holdings.                     │
└──────────────────────────────────────────────────────────────────────────┘
 │
 ▼
A wallet that can pay its own fees — contract calls, DarkVeil registration
```

**Why the snapshot guards matter.** A snapshot restored under the wrong SDK
version, network or seed does not fail loudly — it produces a wallet holding a
confident and wrong view of what it owns. All three are therefore checked before
a snapshot is used, and any mismatch falls back to replaying from chain, which is
slower but always correct. The same applies to a snapshot that cannot be
decrypted or parsed: it is treated as absent rather than raised as an error,
because a slow start is a better outcome than a failed one.

**Why this is off-chain.** No contract on either chain reads any of this. It is
the platform operating its own wallets, in the same place the eligibility checks
and the allowlist-root publication already run — see the DarkVeil eligibility
notes in `CLAUDE.md` for the same off-chain-computed, on-chain-verified shape.

---

## Graduation Flow (Tier A/B — LP Seeding)

**The success-path counterpart to the Failure & Refund Flow below.** What happens when a bonding curve actually sells out, resolved 2026-07-10 after it sat as a state-flag-only stub since this file's earlier drafts. Tier C graduation is different (Midnight-native, blocked on a DEX to graduate *to* — not shown here).

```
┌──────────────────────────────────────────────────────────────┐
│ 100% SELL-THROUGH                                            │
│ BuyTokens's last purchase                                    │
│ sets curve_state=Graduated                                   │
└──────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Graduate — PERMISSIONLESS, same "the condition is the        │
│ authorization" idiom as ExpireCurve. Anyone can call it;     │
│ nothing to gain by calling it wrong since every effect is    │
│ checked against real value movement, not trusted.            │
│                                                              │
│ Moves, in ONE transaction:                                   │
│ total_raised ADA (Option A, all net-of-fee principal)        │
│ + lp_reserve_tokens (20% of TOTAL_SUPPLY, held in the        │
│ curve's own UTXO since deploy, untouched by BuyTokens)       │
│ → to the launch's own lp_escrow_credential (fixed at         │
│ deploy, can't be redirected)                                 │
│                                                              │
│ Curve is NOT fully consumed — creator/treasury/ops fee       │
│ accumulators stay claimable after, same as always (Stream A) │
└──────────────────────────────────────────────────────────────┘
                                │
      (same transaction, other half verified independently)
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ SealLock (reworked) — also PERMISSIONLESS now.               │
│ Governor-signature requirement replaced with a real value    │
│ check (lp_value_received): the continuing output must        │
│ actually hold the seeded ADA + exactly lp_token_amount of    │
│ the launch token, verified from the LP escrow's OWN side —   │
│ neither redeemer has to trust the other's bookkeeping.       │
│                                                              │
│ lp_state: Cancelled → Locked, 365-day clock starts           │
└──────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ LP LOCKED, 365 DAYS                                          │
│ No withdraw — ever.                                          │
│ HarvestFees can pull DEX trading fees without touching       │
│ the position.                                                │
│ Migrate only after lock expiry (multisig + 72h notice        │
│ per DEX change)                                              │
└──────────────────────────────────────────────────────────────┘
```

**Bonus fix found while building this:** `BuyTokens` never verified the curve's own token reserve actually shrank on delivery — only that some output received tokens (`token_delivered`). Harmless before `lp_reserve_tokens` existed in the same UTXO; became a real risk once it did, since a self-supplied fake "delivery" could have inflated `tokens_sold` (falsely triggering Graduated) without real depletion. Fixed via `curve_token_balance_decreased`, the delivery-side mirror of the payment-side check (`payment_received`) that already existed.

---

## Failure & Refund Flow (Stuck Curve, Cancelled Launch)

**A core user-protection feature, not an edge case.** Every path a buyer or DarkVeil registrant can use to get their money back if a launch stalls or fails, across all three tiers. All timeout/refund mechanics were built 2026-07-10 on top of the failure-path decisions from 2026-07-09.

```
            ┌────────────────────────┐
            │ BONDING CURVE STALLS   │
            │ (Active, never reaches │
            │ 100% sell-through)     │
            └────────────────────────┘
                         │
            ┌─────────────────────────┐
            │                         │
┌───────────────────────┐ ┌───────────────────────┐
│ Governor: CancelCurve │ │ ANYONE: ExpireCurve   │
│ (voluntary, any time) │ │ (permissionless       │
│                       │ │ after 90 days Active, │
└───────────────────────┘ │ no signature needed)  │
                          └───────────────────────┘
            │                         │
            └─────────────────────────┘
                         ▼
            ┌─────────────────────────┐
            │ curve_state = Cancelled │
            └─────────────────────────┘
                         │
      TIER A / TIER B (Cardano)                 TIER C (Midnight)
                  ▼                                     ▼
┌───────────────────────────────────┐ ┌───────────────────────────────────┐
│ Tokens were delivered atomically  │ │ Tokens are internal PSM ledger    │
│ at purchase — buyer already holds │ │ credits; NIGHT paid is tracked in │
│ what they paid for. Nothing to    │ │ `paidByBuyer`.                    │
│ refund on the BUY side.           │ │                                   │
│                                   │ │ claimCurveRefund(recipientAddr)   │
│ ClaimBuyback:                     │ │ — full NIGHT refund, real payout  │
│ holder returns tokens → receives  │ │ via sendUnshielded (used to be    │
│ pro-rata ADA share of the         │ │ ledger-only)                      │
│ stranded principal:               │ └───────────────────────────────────┘
│ total_raised * token_amount       │                                      
│ / tokens_sold                     │                                      
│ (real on-chain division, no       │                                      
│ floor-check needed — Aiken's Int  │                                      
│ is arbitrary-precision)           │                                      
└───────────────────────────────────┘                                      

════════════════ DARKVEIL BOND REFUNDS (all tiers with DV) ════════════════

                   ▼                                      ▼
┌────────────────────────────────────┐ ┌───────────────────────────────────────┐
│ Launch cancelled OR DarkVeil       │ │ DarkVeil closed NORMALLY              │
│ itself failed (<50% participation, │ │ (succeeded, not cancelled,            │
│ launch converts to public,         │ │ not failed)                           │
│ doesn't die)                       │ │                                       │
│                                    │ │ Both tiers now — claimRatioBondRefund │
│ claimBondRefund(recipientAddr)     │ │ : NIGHT_returned = bonded ×           │
│ — 100% NIGHT bond returned to      │ │ purchased / baseSlot (flat per-       │
│ EVERY registrant, no forfeiture.   │ │ capita allocation). Tier C            │
│ Real payout via sendUnshielded     │ │ originally; Tier B ported             │
│ (was ledger-only before)           │ │ the identical formula into            │
│                                    │ │ eligibility_gate.compact when it      │
│ Tier B: same circuit exists on     │ │ merged with darkveil.compact          │
│ eligibility_gate.compact           │ │                                       │
└────────────────────────────────────┘ │ Forfeited remainder (2026-07-         │
                                       │ 10): paid out in the SAME call,       │
                                       │ split 60% treasury / 40% ops, via     │
                                       │ sendUnshielded — reuses the           │
                                       │ existing verifyFeeSlice helper for    │
                                       │ the treasury-share floor check        │
                                       └───────────────────────────────────────┘
```

**Reading this diagram:** the two tier-families need genuinely different mechanisms because their token-delivery models are different, not because one is more "finished" than the other — Tier A/B deliver tokens atomically at purchase (a real UTXO asset transfer), so there's no buyer-side escrow to refund, only stranded *principal* to buy back from whoever now holds the tokens. Tier C's balances are internal ledger credits (pending a still-open Midnight token-standard question), so a direct refund of the NIGHT paid is the natural mechanism instead. DarkVeil bond refunds are a separate flow from curve refunds entirely — a DV registrant's $50-equivalent NIGHT bond and a buyer's curve payment are different money with different refund rules, even for the same person on the same launch. **Tier B's DarkVeil phase needs no ADA-refund path of its own:** since `ClaimDarkVeilTokens` (2026-07-11, described in the tier diagram above), a DarkVeil buyer pays their ADA only at claim time, atomically with token delivery on Cardano — no DarkVeil ADA ever sits in the contract waiting on a phase that might fail. The refundable money in a DarkVeil failure is the NIGHT bond, covered by its own flow below; a DV buyer who has already claimed holds real tokens and shares `ClaimBuyback` with every other holder if the curve later stalls.

---

## CTO Governance Flow

Community takeover (CTO) governance, shared infrastructure across all three tiers (`cto_governance.compact` on Midnight for the private ballot, `cto_governance.ak` on Cardano L1 for anchoring and enforcement). This flow has been through multiple independent security review passes. Anchoring a vote result requires a real bond and passes through a 24-hour challenge window before it takes effect; the downstream validators that enforce a passed vote authenticate the governance record cryptographically rather than by address (see the thread-NFT note below the diagram); and the creator's own tokens may vote but are weight-capped and tallied separately. **Current build status:** the ballot logic is contract-complete and audited, but the vote-casting transaction layer is not yet built, so no CTO vote can be cast in production today.

```
┌─────────────────────────┐
│ LAUNCH GRADUATED        │
│ Fee escrow + LP trading │
│ fees begin accruing     │
└─────────────────────────┘
             │
             │ 90-day minimum wait (CTO_MIN_DAYS_POSTGRD, raised from 30 — anti-whale fix)
             ▼
┌────────────────────────────┐
│ PROPOSAL TRIGGER           │
│ organic (any holder) OR    │
│ silence lock (90d no claim │
│ AND 90d no verified post)  │
└────────────────────────────┘
               │
               ▼
┌───────────────────────────────────────────────────────────┐
│ 72H PRIVATE BALLOT — Midnight, cto_governance.compact     │
│ castVote weight = governor-published balanceSnapshotRoot  │
│ Merkle tree (weight proven in-circuit, never caller-      │
│ supplied). Anti-whale-takeover fix (2026-07-28): EVERY    │
│ voter capped at 1% of supply (maxVoterCap) — creator      │
│ included, not exempt; tallied separately for audit.       │
│ Quorum: 5% of supply from 15+ distinct voters             │
│ (minVoterCount). A balance only counts if held 30+ days   │
│ before the proposal started (minHoldingPeriod).           │
│ NOT YET BUILT: no submitter calls createProposal/castVote │
│ today — contract-complete and audited, but unwired        │
└───────────────────────────────────────────────────────────┘
                ┌──────────────────────────┐
                │                          │
┌───────────────────────────────┐ ┌────────────────┐
│ PASSED (quorum + yes > no)    │ │ FAILED         │
│                               │ │ no quorum, or  │
│ ANCHOR (open relay,           │ │ yes ≤ no votes │
│ Cardano cto_governance.ak):   │ └────────────────┘
│ any holder submits the        │                   
│ signed result + a real bond   │                   
│ (≥25 ADA) — closes the        │                   
│ old zero-verification gap     │                   
│                               │                   
│ 24H CHALLENGE WINDOW:         │                   
│ governor VoidPendingProposal  │                   
│ voids fraud within the window │                   
│ (bond slashed 60/40 treasury/ │                   
│ ops); elapses clean →         │                   
│ ExecuteProposal (permission-  │                   
│ less)                         │                   
│                               │                   
│ EXECUTED — same tx:           │                   
│ • Fee escrow + LP trading     │                   
│   fees → CTO wallet           │                   
│ • Unvested creator tokens     │                   
│   frozen → community          │                   
│   treasury, never burned      │                   
│ • Already-claimed/vested:     │                   
│   unaffected                  │                   
└───────────────────────────────┘                   
                │
                ▼
  ┌──────────────────────────┐
  │ 90-DAY COOLDOWN          │
  │ after ANY vote outcome — │
  │ pass, fail, or voided    │
  │ (CTO_COOLDOWN_DAYS)      │
  └──────────────────────────┘
```

**Reading this diagram:** the ballot itself (Midnight) and the anchor/enforcement (Cardano L1) are deliberately two different trust boundaries, not one contract wearing two hats — `castVote`'s weight check trusts a governor-published Merkle root the same way `eligibility_gate.compact`'s allowlist and `staking_pool`'s reward accounting do, and `AnchorVoteResult` doesn't re-verify the ballot's cryptography, it verifies a real bond was paid and gives the community a real window to catch a lie. The anchor step is intentionally **permissionless** (open relay) rather than platform-only — a platform-only relay could suppress or delay a legitimate community takeover simply by not anchoring, which would reintroduce exactly the centralization risk CTO governance exists to prevent. `ExecuteProposal` is permissionless too, for the same reason; the 24-hour challenge window is what makes that safe rather than an invitation to forge results, since anyone with a fabricated anchor has to put a real bond at risk first. The "EXECUTED" effects listed inside the PASSED box are wired across every contract that holds a creator-facing revenue or token stream — before that fix, none of the three bonding curve contracts, Creator Fee Escrow, Vesting, or LP Escrow actually redirected anything when a vote passed, regardless of what the ballot tally said.

**How enforcement authenticates a passed vote:** the four downstream Cardano validators that enforce a passed vote — `bonding_curve.ak`, `bonding_curve_tier_b.ak`, `lp_escrow.ak`, `vesting.ak` — do not re-run the ballot. They read the `cto_governance.ak` UTXO as a **reference input** and act on the outcome recorded in its datum. Because a Cardano reference input is never spent, that record is authenticated by a **per-launch governance thread NFT** rather than by address: the policy is a governor-signature native script, and the asset name is the `launch_id`, so a given launch's governance record is bound to that launch specifically. Every downstream check requires the referenced UTXO to carry exactly one of that NFT, and `cto_governance.ak` preserves the NFT in its continuing output on every spend — including its permissionless redeemers. Covered by dedicated regression tests; 257/257 Cardano checks pass. **Remaining build work:** the CTO deploy flow must mint that NFT into the genesis governance UTXO — part of the not-yet-built CTO deploy/submitter layer.

**Trust assumption — voting-weight snapshot:** `balanceSnapshotRoot` is published by the governor role, and is the basis on which `castVote` proves each voter's weight. Vote weights themselves cannot be fabricated by any voter — every ballot proves membership in the published root in-circuit. Publication of the snapshot is a governor responsibility, and hardening that role (key custody / multisig) is tracked internally as part of the governance roadmap. The snapshot is derived from public on-chain balances, so any published root is independently re-derivable and auditable by third parties.

---

## Contract-to-Tier Reference

| Contract | Tier A | Tier B | Tier C | Execution layer |
|---|---|---|---|---|
| Eligibility Gate PSM | — | ✓ (merged with DarkVeil into `eligibility_gate.compact`, Phase 2 2026-07-11) | ✓ (merged into Bonding Curve) | Midnight |
| DarkVeil PSM | — | ✓ (merged with Eligibility Gate, Phase 2 2026-07-11) | ✓ (merged into Bonding Curve) | Midnight |
| Bonding Curve (quadratic, Aiken) | — | ✓ (ADA; incl. `ClaimDarkVeilTokens` DV settlement) | — | Cardano L1 (Aiken) |
| Bonding Curve (quadratic, merged Compact) | — | — | ✓ (NIGHT) | Midnight |
| Bonding Curve (linear) | ✓ (ADA) | — | — | Cardano L1 (Aiken) |
| Creator Fee Escrow PSM | — | not used for real fee accrual (Compact never enforced Tier B's ADA payment; all Tier B fees accrue on the Cardano curve contract instead) | ✓ | Midnight |
| Vesting PSM | — | ✓ | ✓ | Midnight |
| Vesting Contract (linear) | ✓ | — | — | Cardano L1 (Aiken) |
| Treasury PSM | — | ✓ | ✓ (+ forfeited-bond routing) | Midnight |
| LP Escrow Contract | ✓ | ✓ | — | Cardano L1 (Aiken; whitelist governance via team multisig + 72h public notice) |
| Midnight LP Escrow PSM | — | — | ✓ | Midnight |
| CTO Governance Contract | ✓ | ✓ | ✓ | Cardano L1 (Aiken; Tier C anchored via relay; open-relay anchor) |
| ZK Anchor Contract | — | ✓ | ✓ | Cardano L1 (Aiken; Tier C anchored via relay — Cardano-side submission now real via Lucid Evolution) |
| N-Hop Challenge Contract | — | ✓ (Tier B only) | — | Cardano L1 (Aiken; new `nhop_challenge.ak`, 2026-07-12 — ADA-denominated bond can't be Midnight-native, same reasoning as the Tier B curve migration; Tier C unaffected, already build-blocked independent of this feature) |
| CTO Sybil-Challenge Contract | ✓ | ✓ | ✓ | Cardano L1 (Aiken; new `cto_sybil_challenge.ak`, 2026-07-19 — bonded, governor-adjudicated secondary defense against a creator voting through wallets other than their registered `creatorKey` to evade `maxVoterCap` (renamed from `creatorVoteCap`, now a uniform per-voter cap — anti-whale-takeover fix, 2026-07-28); direct structural adaptation of `nhop_challenge.ak`) |
| Staking Rewards Pool | ✓ | ✓ | ✓ | Cardano L1 for A/B (`staking_pool.ak`, real on-chain stake custody), Midnight for C (`staking_pool.compact`, governor-attested stake — `bonding_curve.compact` never mints the launch token as a real coin, so there's nothing for a separate contract to custody) — optional per-launch feature, 2026-07-14; reward claiming is real on both tiers (governor-published Merkle-snapshot accounting, no on-chain division; Tier C mints the reward payout live via `mintUnshieldedToken`, confirmed real and executable). **Tier A/B gained a real browser-wallet-signed stake/unstake/claim UI 2026-07-22** — see `integration/staking-submitter.ts`/`staking-widget-entry.ts`; also had the same bare-enterprise-address payout bug fixed elsewhere. Not yet verified end-to-end on real Preprod. |
| Token Metadata (CIP-68 logo) | ✓ | not yet built | not yet built | Cardano L1 (Aiken; new `token_metadata.ak`, 2026-07-28 — mutable, creator/CTO-controlled reference-NFT metadata, decoupled from the platform's own time-locked minting policy; audited on its own, 5 findings fixed. Real Lucid Evolution submitter exists (`token-metadata-submitter.ts`); WordPress-side upload/wizard/Token Profile page work is not yet built, see the note above the diagrams) |

**CTO fee-redirect (2026-07-12) — applies across every row above with a fee/token stream:** until this fix, none of the three bonding curve contracts, Creator Fee Escrow, Vesting, or LP Escrow had any CTO-awareness at all — a passed CTO vote never actually redirected the creator fee, unvested tokens, or LP trading fees to the community wallet, regardless of what `cto_governance`'s own vote-tallying logic said. Fixed by adding the same `ctoTriggered`/community-wallet pattern (`TriggerCTO`/`DissolveCTO` or `triggerCTO`/`dissolveCTO`) to every one of them. Each contract's own trigger must still be called as a separate, off-chain-orchestrated transaction after a vote passes — no cross-contract call mechanism exists to do this atomically.

**Cumulative wallet cap (Cardano, Tier A and Tier B):** the 5% cap is one running total per wallet key across a whole launch, not a limit on a single trade. Both curve validators carry a single 32-byte `cap_root` in their datum committing to every wallet's total, and each trade supplies its own total plus a Merkle proof of it — the validator walks that path twice, once against the current root to prove the total is real, once with the updated leaf to derive the new root. The datum therefore stays one fixed size however many wallets trade, there is no allowlist and anyone can buy, and nothing about a wallet is published unless and until it trades. A Tier B DarkVeil claim and a public buy draw on the same 5%; a sell returns headroom. The tree is defined once in `contracts/cardano/lib/noctis/cap_accumulator.ak` and mirrored by `integration/cap-accumulator-tree.ts`, both pinned to the same ground-truth literals — the two must agree bit for bit, which is only enforceable with one definition. It caps one *wallet key*, not one person: nothing on-chain distinguishes two keys from two people on any tier, which is what DarkVeil eligibility and the N-hop challenge exist to make expensive.

**Chain-time binding:** every time-gated operation in `vesting.compact` (`claimVested`/`startVesting`) and `lp_escrow.compact` (`sealLock`/`migrateLp`) binds against real chain time via `blockTimeGte`/`blockTimeLte`. Timestamps are never taken as an unchecked caller-supplied value, so vesting schedules and the 365-day LP lock advance only with real elapsed time.

Full contract purposes and circuit lists are in CLAUDE.md's [Contract Architecture](CLAUDE.md#contract-architecture) section and `docs/PSM_ARCHITECTURE.md`.

---

*Diagrams are illustrative, not exhaustive — witness functions, helper circuits, and view/read-only circuits are omitted for readability. See `contracts/midnight/*.compact` and `contracts/cardano/validators/*.ak` for actual implementations — all 8 Midnight PSMs (`darkveil.compact` deleted, merged into `eligibility_gate.compact`, Phase 2 2026-07-11; `staking_pool.compact` added 2026-07-14) and 10 Aiken contracts (`nhop_challenge.ak` added 2026-07-12; `staking_pool.ak` added 2026-07-14; `cto_sybil_challenge.ak` added 2026-07-19; `token_metadata.ak` added 2026-07-28) compile clean (full ZK proving-key generation for Compact; `aiken check`/`aiken build` for Aiken) as of 2026-07-30 (real re-run, both suites, this pass) — 280 Compact tests, 285 Aiken checks. Test/contract counts drift fast in this project — re-verify against `find contracts/cardano/validators -name '*.ak' | wc -l` / `find contracts/midnight -name '*.compact' | wc -l` and the two suites' own real run output rather than trusting this line blindly.*
