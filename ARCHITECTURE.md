# Architecture — Noctis Zone

High-level structural diagrams for the protocol. For full contract specs, constants, and open design questions, see [CLAUDE.md](CLAUDE.md), internal tracking — this file is a visual reference, not the source of truth for any individual decision.

> **Keeping this file current:** this diagram set (plus `README.md`, `architecture.html`, and `docs/PSM_ARCHITECTURE.md`) needs a real update pass whenever a major architectural fact changes — a contract merges/splits, a new validator ships, a feature's build status moves. It's easy for these to silently drift behind internal tracking (the actual source of truth) since nothing forces a re-read. Check it against current contract/test-count reality periodically, not just when someone notices it's wrong.
>
> **Naming.** A launch is named for the chain its token settles on: a **Cardano
> Launch** or a **Midnight Launch** (**Solana** and **XRP** are announced, not
> built). The code underneath still uses the original `tier_a` / `tier_b` /
> `tier_c` identifiers and cannot stop — a deployed validator's hash depends on
> its name, and stored launch records carry the letter. Read `tier_b` as a
> Cardano Launch and `tier_c` as a Midnight Launch throughout. `tier_a` was the
> earlier linear-curve, no-DarkVeil path, retired on 2026-09-05: no launch is
> created or shown on it, and its validator leaves the build with the next
> validator release, which is why this file carries a single Cardano column.
>
> **Recent structural changes:** the Cardano launch lifecycle was proven
> end-to-end on real Preprod (mint → buy → graduate → vest → stall/buyback) and
> the full DarkVeil lifecycle was rehearsed there separately; a
> `cto_sybil_challenge.ak` validator shipped; multiple full adversarial security
> review passes landed across both chains, with all findings resolved or
> explicitly accepted and documented internally; CTO Governance's off-chain
> backend was built out (voter identity, balance-snapshot builder, relay, badge)
> though the vote-casting transaction layer is still unbuilt; and **the Staking
> Rewards Pool was rebuilt to run unattended** — see the Staking section below.
> Current counts (re-verified this pass, real compile+test runs): **12 Aiken
> validator modules / 549 checks, 8 Compact PSMs / 502 tests**.
>
> **`token_metadata.ak` (CIP-68 on-chain logo):** a validator plus one-shot
> minting policy for a mutable, creator/CTO-controlled reference-NFT logo — not a
> mint-time-only metadata blob, which would be impossible anyway since the
> platform's minting policy is time-locked. Audited on its own immediately after
> being written. A real Lucid Evolution submitter
> (`integration/token-metadata-submitter.ts`) builds unsigned mint/update
> transactions for the creator's own wallet to sign, same pattern as every other
> browser-signed action on this platform. **Not yet wired into the Create Wizard
> or a Token Profile page** — the contract and submitter are real and tested; the
> WordPress-side upload/display/profile-page work (outside this repo) is still
> pending.

## Table of Contents

- [System Overview](#system-overview)
- [Midnight PSM Flow (DarkVeil)](#midnight-psm-flow-darkveil)
- [Midnight Wallet Operations (off-chain)](#midnight-wallet-operations-off-chain)
- [Graduation Flow (Cardano Launch — LP Seeding)](#graduation-flow-cardano-launch--lp-seeding)
- [Staking Rewards Pool](#staking-rewards-pool)
- [Failure & Refund Flow (Stuck Curve, Cancelled Launch)](#failure--refund-flow-stuck-curve-cancelled-launch)
- [CTO Governance Flow](#cto-governance-flow)
- [Contract Reference](#contract-reference)

---

## System Overview

A launch is named for the chain its token settles on, and both launch types run
the same DarkVeil private buying phase on Midnight.

A **Cardano Launch** is dual-chain: one merged Midnight PSM handles DarkVeil
registration and private buying only; the public bonding curve, staking, LP
Escrow, vesting, CTO Governance and the ZK Anchor all live on Cardano L1. The
public phase moved off Midnight entirely once DarkVeil closes (2026-07-09) —
it needs no privacy by definition, and Cardano can enforce real payment natively.

A **Midnight Launch** moves everything onto Midnight, including the bonding
curve, merged into one contract with Eligibility Gate and DarkVeil. Only the ZK
Fair Launch Certificate anchor and CTO Governance are relayed to Cardano L1, for
public verifiability, even though the launch itself is Midnight-native.

```
NOCTIS ZONE

┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐
│ CARDANO LAUNCH                       │  │ MIDNIGHT LAUNCH                      │
│ Token on Cardano L1 · ADA            │  │ Token on Midnight · NIGHT            │
├──────────────────────────────────────┤  ├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │  │ ┌──────────────────────────────────┐ │
│ │ MERGED PSM (Midnight):           │ │  │ │ MERGED PSM (Midnight):           │ │
│ │ Eligibility Gate + DarkVeil,     │ │  │ │ Eligibility Gate + DarkVeil +    │ │
│ │ one shared ledger                │ │  │ │ Bonding Curve, one shared        │ │
│ └──────────────────────────────────┘ │  │ │ ledger, NIGHT-priced             │ │
│                                      │  │ └──────────────────────────────────┘ │
│ Bonding Curve (quadratic, ADA,       │  │                                      │
│ Cardano) + ClaimDarkVeilTokens       │  │ Creator Fee Escrow (Midnight)        │
│ (Merkle-root DV settlement)          │  │ Staking Pool (Midnight)              │
│                                      │  │ LP Escrow (Midnight)                 │
│ Creator Fee Escrow (accrues in       │  │ Vesting (Midnight)                   │
│ the Cardano curve itself)            │  │ Treasury (Midnight)                  │
│ Staking Pool (Aiken)                 │  │                                      │
│ LP Escrow (Aiken)                    │  │ CTO Governance (Aiken, relayed)      │
│ Vesting (Aiken)                      │  │ ZK Cert Anchor (Aiken, relayed)      │
│ CTO Governance (Aiken)               │  │                                      │
│ ZK Cert Anchor (Aiken)               │  │                                      │
│ Treasury (Midnight)                  │  │                                      │
└──────────────────────────────────────┘  └──────────────────────────────────────┘

                    │                                         │
                    ▼                                         ▼

  ┌────────────────────────────────────────────────────────────────────────────┐
  │ INTEGRATION LAYER                                                          │
  │ Blockfrost · Koios · ADA/USD median oracle · Midnight SDK · Wallet Connect │
  └────────────────────────────────────────────────────────────────────────────┘

                    │                                         │
                    ▼                                         ▼

┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐
│ CARDANO L1 + MIDNIGHT                │  │ MIDNIGHT + CARDANO L1                │
├──────────────────────────────────────┤  ├──────────────────────────────────────┤
│ Aiken: bonding curve (incl. DV       │  │ Compact: merged curve PSM +          │
│ claim), staking, LP escrow,          │  │ escrow, staking, LP, vesting,        │
│ vesting, CTO gov, ZK anchor          │  │ treasury                             │
│ Compact: merged DarkVeil PSM         │  │ Aiken: ZK anchor + CTO gov           │
└──────────────────────────────────────┘  └──────────────────────────────────────┘
```

**Reading this diagram:** a Cardano Launch's public bonding curve is **Aiken on Cardano** (`bonding_curve_tier_b.ak`, quadratic, ADA-priced) — DarkVeil registration and private buying stay on Midnight as one **merged** PSM (Eligibility Gate + DarkVeil, Phase 2 2026-07-11 — the two were originally standalone; merging them let the ratio-based NIGHT bond refund logic reach both circuits). A DarkVeil purchase's actual ADA payment and token delivery happen back on Cardano, via `ClaimDarkVeilTokens` on the curve contract (2026-07-11) — a privacy-preserving Merkle-root claim, never a plaintext per-registrant list. A Midnight Launch's Eligibility Gate + DarkVeil + Bonding Curve are **one merged Compact contract** — Compact has no working cross-contract call mechanism, so folding the three source files into one deployed contract with a shared `cumulativePurchases` ledger was the only way to make the 5% cumulative cap real across both the DarkVeil and public phases.

Creator Fee Escrow and Vesting are always separate contracts — CLAUDE.md explicitly warns against conflating a creator's trade-fee income with their token vesting schedule. A Cardano Launch's Creator Fee Escrow is a single balance accrued entirely in the Cardano curve contract, and its vesting runs on `vesting.ak`, a Cardano validator rather than a Midnight PSM.

The retired linear-curve path (`bonding_curve.ak`) is not drawn. It was Aiken-only — it never touched Midnight, because it had no DarkVeil phase — and it leaves the build with the next validator release.

---

## Midnight PSM Flow (DarkVeil)

The DarkVeil registration → private-buy sequence, identical on both launch types.

**Correction (2026-07-10):** this diagram once described "transaction merging" as the mechanism connecting these PSMs. That claim was never verified and turned out to be wrong — real probe contracts compiled against the installed Compact compiler confirmed there is no working cross-contract-call mechanism of any kind: not a call, not a merged transaction, nothing. What does work is **compile-time contract merging** (`include`/`module` directives folding several `.compact` files into one deployed contract with one shared ledger). That is what a Midnight Launch does with three source files, and what Phase 2 (2026-07-11) later did for a Cardano Launch with two, collapsing `eligibility_gate.compact` and the now-deleted `darkveil.compact` into one deployed contract that kept the `eligibility_gate.compact` name.

Both top boxes below are therefore the **same deployed contract** on both launch types — drawn apart only to keep their two jobs readable (registration and cap tracking, versus commit and reveal). What is still genuinely cross-chain on a Cardano Launch is the link down to the bonding curve: registration and buying happen on Midnight, but real ADA payment and token delivery for a DarkVeil purchase happen on Cardano via `ClaimDarkVeilTokens`. There is no atomic link between the two, so a 10-minute settlement window covers the handoff.

```
Launch Wizard
 │
 ▼
┌───────────────────────────┐  ┌──────────────────────────┐
│ ELIGIBILITY GATE          │  │ DARKVEIL                 │
├───────────────────────────┤  ├──────────────────────────┤
│ Cardano Launch: merged    │  │ The SAME deployed        │
│ with DarkVeil into one    │  │ contract as Eligibility  │
│ contract (Phase 2,        │  │ Gate on both launch      │
│ eligibility_gate.compact) │  │ types — drawn apart only │
│ Midnight Launch: merged   │  │ to keep the two jobs     │
│ into the Bonding Curve    │  │ readable                 │
│                           │  │                          │
│ Allowlist verify          │  │ Commitment buy           │
│ 5% cumulative cap track   │  │ Buy reveal (post-close)  │
│ NIGHT bond lock           │  │ ZK cert generation       │
│ Bond refund               │  │ Failure path             │
│ (claimBondRefund,         │  │ (<50% → refund all)      │
│ claimRatioBondRefund)     │  └──────────────────────────┘
└───────────────────────────┘
              │ Cardano Launch: no atomic link to the curve below —
              │ a 10-minute settlement window covers the gap.
              │ Midnight Launch: the same contract, so no gap at all.
              ▼
┌───────────────────────────────────────────────────────────────────┐
│ BONDING CURVE                                                     │
├───────────────────────────────────────────────────────────────────┤
│ Cardano Launch: Aiken (bonding_curve_tier_b.ak), quadratic, ADA.  │
│   ClaimDarkVeilTokens settles a DarkVeil buyer's private purchase │
│   for real — ADA payment plus token delivery, checked against a   │
│   relayer-anchored Merkle root rather than any published roster.  │
│ Midnight Launch: Compact, merged with the two boxes above, NIGHT. │
│                                                                   │
│ 1.5% fee split (0.5 creator / 1.0 platform) · graduation at 100%  │
│ sell-through · stall timeout at 90 days                           │
└───────────────────────────────────────────────────────────────────┘
           │                      │                      │                      │
           ▼                      ▼                      ▼                      ▼
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ CREATOR FEE ESCROW │ │ VESTING            │ │ TREASURY PSM       │ │ LP ESCROW          │
├────────────────────┤ ├────────────────────┤ ├────────────────────┤ ├────────────────────┤
│ 0.5% fee accrual   │ │ 90-365 days,       │ │ 1.0% platform fee  │ │ 365-day lock       │
│ Monthly claim,     │ │ no default —       │ │ USDM conversion    │ │ NO withdraw —      │
│ silence-lock gated │ │ the creator must   │ │ Every forfeited    │ │ ever               │
│                    │ │ choose             │ │ DarkVeil bond,     │ │ DEX migrate        │
│                    │ │                    │ │ whole              │ │ (multisig + 72h)   │
└────────────────────┘ └────────────────────┘ └────────────────────┘ └────────────────────┘
```

**Reading this diagram:** Creator Fee Escrow and Vesting are two distinct contracts, deliberately not shown as one box — CLAUDE.md flags conflating them as "a common source of confusion." Fee Escrow accrues the creator's 0.5% of bonding-curve trades and pays out monthly, subject to the silence lock; Vesting controls when and how fast the creator's *token allocation* (not fees) releases, on a 90–365 day schedule the creator must actively choose. On a Cardano Launch both live on Cardano: the fee accrues in the curve contract's own balance, and vesting runs on `vesting.ak`.

LP Escrow fans out from the Bonding Curve because graduation (100% sell-through) is what triggers LP seeding — see the Graduation Flow diagram below. Once locked, LP Escrow also supports **HarvestFees**: a DEX-agnostic redeemer that lets post-graduation trading fees reach the creator, or the CTO community wallet, without ever touching the locked LP position. The real per-DEX harvest call (CSwap, Minswap, Splash, WingRiders and SundaeSwap each differ) arrives with the DEX integration work; what the contract enforces today are its own invariants — the LP position is byte-for-byte unchanged, and the correct recipient is really paid in the same transaction.

**Forfeited DarkVeil bonds go whole to the platform wallet.** An earlier version of this diagram split them 60/40 between a treasury and an ops wallet; that pair was retired for *revenue* on 2026-08-06. One address now receives the launch fee, the platform's 1.0% of trade volume, forfeited DarkVeil bonds and staking claim fees alike.

**The treasury/ops pair is not gone from the platform, though — only from revenue.** Three validators still pay a *slashed challenge bond* to two separate addresses, 60/40: `nhop_challenge.ak`, `cto_sybil_challenge.ak` and `cto_governance.ak` each carry `treasury_bps = 60` / `ops_bps = 40` and a `treasury_pub_key_hash` / `ops_pub_key_hash` pair in their datum, with tests pinning the split. That is a different kind of money — a forfeited bond from someone who challenged and lost, not platform income — but it means both addresses must still be provisioned, and any claim that the platform has no split anywhere is wrong.

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

## Graduation Flow (Cardano Launch — LP Seeding)

**The success-path counterpart to the Failure & Refund Flow below.** What happens when a bonding curve actually sells out. A Midnight Launch graduates differently — Midnight-native, and blocked on a DEX to graduate *to* — so it is not shown here.

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

## Staking Rewards Pool

An optional per-launch pool a creator funds out of the launch's own supply. Once
it opens at graduation it runs unattended: the contract works out what every
position is owed from elapsed time, so **no key, signature or published snapshot
decides a payout.** The platform cannot pay a staker early, pay them late, pay
them the wrong amount, or stop them being paid.

That is a change of mechanism, not just of operator. The pool used to be settled
by a governor who computed rewards off-chain and published a Merkle root of
`(staker, cumulative_reward)` leaves; claiming proved membership in that root.
It was auditable — anyone could re-derive the root from public stake events —
but it still put the platform between a staker and their tokens.

**What replaced it** is the reward-per-token accumulator that AMM staking
contracts have used for years, adapted to the eUTxO model:

```
On every spend of the pool, first advance it to the present:

  elapsed  = now - last_update_ms
  emitted  = min(emission_per_day * elapsed / MS_PER_DAY, unallocated)
  acc     += emitted * ACC_SCALE / total_staked
  unallocated -= emitted

Then one subtraction answers what any position is owed:

  owed = amount * acc / ACC_SCALE - debt

where `debt` is what that position would have been owed had it been staked from
the beginning. Staking sets `debt` so that `owed` starts at zero.
```

Aiken has real integer division, so this is computed on-chain rather than
attested. (The "no on-chain division" constraint recorded elsewhere in this
project is a Compact limitation; it was carried across to Cardano by analogy and
does not apply there.)

**Positions are entries under a Merkle root in the pool's datum, not separate
UTXOs.** This is forced, not stylistic: paying a UTXO to a script address runs no
validator, so if a position lived in its own UTXO then `debt` — the field that
decides the payout — would be authored by whoever created it. Under one root the
pool authenticates every position it pays.

A wallet therefore has at most one position per pool, and:

- **Staking again** adds to that position and compounds whatever it has already
  earned. Those tokens are already in the pool, so nothing has to move.
- **The 7-day minimum** is a lock on withdrawal, not a period of earning nothing.
  Adding to a position restarts it; claiming does not.
- **Unstaking** returns the stake and everything owed on it in one transaction.
- **Topping up** is permissionless — anyone may give a pool tokens — and buys
  more days at the same rate rather than a faster rate.
- **Closing** needs the budget spent, a 90-day cooldown elapsed, every position
  closed and every reward claimed. A top-up inside the window revives the pool.
  A staker who never returns keeps it open and keeps their tokens; the window is
  an opportunity to top up, not a forfeiture.

Nothing is emitted while nobody is staked, and the budget is untouched in that
case, so a quiet stretch moves the end date later rather than burning tokens
nobody received.

**A Midnight Launch is the exception, and it is a real one.** `staking_pool.compact`
still takes a governor-attested stake snapshot, because `bonding_curve.compact`
never mints the launch token as a real Midnight coin — it tracks ownership as an
internal ledger map — and Compact has no cross-contract call with which a
separate staking contract could take custody of it. Reward *claiming* there is
real: the payout is minted to the staker directly. The trustless custody model
above is the Cardano one.

> **Not yet exercised on a real chain.** The contracts, their 549 checks and the
> browser-signed UI are all in place; a Preprod run of stake → claim → unstake →
> top-up → close has not been done. Pools created before this rebuild sit at the
> previous validator's address and cannot be reached by the new one.

---

## Failure & Refund Flow (Stuck Curve, Cancelled Launch)

**A core user-protection feature, not an edge case.** Every path a buyer or DarkVeil registrant can use to get their money back if a launch stalls or fails, on every launch type. All timeout/refund mechanics were built 2026-07-10 on top of the failure-path decisions from 2026-07-09.

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
            CARDANO LAUNCH                       MIDNIGHT LAUNCH 
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

═══════════ DARKVEIL BOND REFUNDS (both launch types) ═════════════════════

                   ▼                                      ▼
┌────────────────────────────────────┐ ┌───────────────────────────────────────┐
│ Launch cancelled OR DarkVeil       │ │ DarkVeil closed NORMALLY              │
│ itself failed (<50% participation, │ │ (succeeded, not cancelled,            │
│ launch converts to public,         │ │ not failed)                           │
│ doesn't die)                       │ │                                       │
│                                    │ │ Both now — claimRatioBondRefund       │
│ claimBondRefund(recipientAddr)     │ │ : NIGHT_returned = bonded ×           │
│ — 100% NIGHT bond returned to      │ │ purchased / baseSlot (flat per-       │
│ EVERY registrant, no forfeiture.   │ │ capita allocation). Built for a       │
│ Real payout via sendUnshielded     │ │ Midnight Launch first; a Cardano      │
│ (was ledger-only before)           │ │ Launch reuses the same formula in     │
│                                    │ │ eligibility_gate.compact, which it    │
│ The same circuit serves both       │ │ gained when darkveil.compact merged   │
│ launch types.                      │ │                                       │
└────────────────────────────────────┘ │ The forfeited remainder is paid in    │
                                       │ the SAME call, whole, to the one      │
                                       │ platform wallet — there is no fee     │
                                       │ split anywhere on the platform now.   │
                                       │                                       │
                                       │                                       │
                                       └───────────────────────────────────────┘
```

**Reading this diagram:** the two launch types need genuinely different mechanisms because their token-delivery models differ, not because one is more "finished" than the other. A Cardano Launch delivers tokens atomically at purchase — a real UTXO asset transfer — so there is no buyer-side escrow to refund, only stranded *principal* to buy back from whoever now holds the tokens. A Midnight Launch's balances are internal ledger credits, pending the still-open Midnight token-standard question, so a direct refund of the NIGHT paid is the natural mechanism instead.

DarkVeil bond refunds are a separate flow from curve refunds entirely: a registrant's $50-equivalent NIGHT bond and a buyer's curve payment are different money with different rules, even for the same person on the same launch.

**A Cardano Launch's DarkVeil phase needs no ADA-refund path of its own.** Since `ClaimDarkVeilTokens`, a DarkVeil buyer pays their ADA only at claim time, atomically with token delivery on Cardano — no DarkVeil ADA ever sits in a contract waiting on a phase that might fail. The refundable money in a DarkVeil failure is the NIGHT bond, covered by its own flow above. A buyer who has already claimed holds real tokens, and shares `ClaimBuyback` with every other holder if the curve later stalls.

---

## CTO Governance Flow

Community takeover (CTO) governance, shared infrastructure across every launch type (`cto_governance.compact` on Midnight for the private ballot, `cto_governance.ak` on Cardano L1 for anchoring and enforcement). This flow has been through multiple independent security review passes. Anchoring a vote result requires a real bond and passes through a 24-hour challenge window before it takes effect; the downstream validators that enforce a passed vote authenticate the governance record cryptographically rather than by address (see the thread-NFT note below the diagram); and the creator's own tokens may vote but are weight-capped and tallied separately. **Current build status:** the ballot logic is contract-complete and audited, but the vote-casting transaction layer is not yet built, so no CTO vote can be cast in production today.

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

**Reading this diagram:** the ballot itself (Midnight) and the anchor/enforcement (Cardano L1) are deliberately two different trust boundaries, not one contract wearing two hats — `castVote`'s weight check trusts a governor-published Merkle root the same way `eligibility_gate.compact`'s allowlist does (the Cardano staking pool no longer works this way — see the Staking Rewards Pool section), and `AnchorVoteResult` doesn't re-verify the ballot's cryptography, it verifies a real bond was paid and gives the community a real window to catch a lie. The anchor step is intentionally **permissionless** (open relay) rather than platform-only — a platform-only relay could suppress or delay a legitimate community takeover simply by not anchoring, which would reintroduce exactly the centralization risk CTO governance exists to prevent. `ExecuteProposal` is permissionless too, for the same reason; the 24-hour challenge window is what makes that safe rather than an invitation to forge results, since anyone with a fabricated anchor has to put a real bond at risk first. The "EXECUTED" effects listed inside the PASSED box are wired across every contract that holds a creator-facing revenue or token stream — before that fix, none of the three bonding curve contracts, Creator Fee Escrow, Vesting, or LP Escrow actually redirected anything when a vote passed, regardless of what the ballot tally said.

**How enforcement authenticates a passed vote:** the four downstream Cardano validators that enforce a passed vote — `bonding_curve.ak`, `bonding_curve_tier_b.ak`, `lp_escrow.ak`, `vesting.ak` — do not re-run the ballot. They read the `cto_governance.ak` UTXO as a **reference input** and act on the outcome recorded in its datum. Because a Cardano reference input is never spent, that record is authenticated by a **per-launch governance thread NFT** rather than by address: the policy is a governor-signature native script, and the asset name is the `launch_id`, so a given launch's governance record is bound to that launch specifically. Every downstream check requires the referenced UTXO to carry exactly one of that NFT, and `cto_governance.ak` preserves the NFT in its continuing output on every spend — including its permissionless redeemers. Covered by dedicated regression tests. **Remaining build work:** the CTO deploy flow must mint that NFT into the genesis governance UTXO — part of the not-yet-built CTO deploy/submitter layer.

**Trust assumption — voting-weight snapshot:** `balanceSnapshotRoot` is published by the governor role, and is the basis on which `castVote` proves each voter's weight. Vote weights themselves cannot be fabricated by any voter — every ballot proves membership in the published root in-circuit. Publication of the snapshot is a governor responsibility, and hardening that role (key custody / multisig) is tracked internally as part of the governance roadmap. The snapshot is derived from public on-chain balances, so any published root is independently re-derivable and auditable by third parties.

---

## Contract Reference

A launch is named for the chain its token settles on. The earlier linear-curve
path was retired on 2026-09-05 and is no longer listed; its validator leaves the
build with the next validator release.

| Contract | Cardano Launch | Midnight Launch | Execution layer |
|---|---|---|---|
| Eligibility Gate PSM | ✓ merged with DarkVeil into `eligibility_gate.compact` | ✓ merged into the Bonding Curve | Midnight |
| DarkVeil PSM | ✓ merged with Eligibility Gate | ✓ merged into the Bonding Curve | Midnight |
| Bonding Curve (quadratic, Aiken) | ✓ ADA, incl. `ClaimDarkVeilTokens` DV settlement | — | Cardano L1 (Aiken) |
| Bonding Curve (quadratic, merged Compact) | — | ✓ NIGHT | Midnight |
| Creator Fee Escrow | ✓ accrues in the Cardano curve's own balance | ✓ PSM | Cardano L1 / Midnight |
| Vesting | ✓ `vesting.ak` | ✓ PSM | Cardano L1 (Aiken) / Midnight |
| Treasury PSM | ✓ | ✓ (+ forfeited-bond routing) | Midnight |
| LP Escrow Contract | ✓ | — | Cardano L1 (Aiken; whitelist governance via team multisig + 72h public notice) |
| Midnight LP Escrow PSM | — | ✓ | Midnight |
| CTO Governance Contract | ✓ | ✓ | Cardano L1 (Aiken; a Midnight Launch anchors via relay; open-relay anchor) |
| ZK Anchor Contract | ✓ | ✓ | Cardano L1 (Aiken; a Midnight Launch anchors via relay — Cardano-side submission real via Lucid Evolution) |
| N-Hop Challenge Contract | ✓ | — | Cardano L1 (`nhop_challenge.ak` — an ADA-denominated bond cannot be Midnight-native, the same reasoning that moved the public curve to Cardano) |
| CTO Sybil-Challenge Contract | ✓ | ✓ | Cardano L1 (`cto_sybil_challenge.ak` — bonded, governor-adjudicated secondary defence against a creator voting through wallets other than their registered `creatorKey` to evade `maxVoterCap`; a structural adaptation of `nhop_challenge.ak`) |
| Staking Rewards Pool | ✓ `staking_pool.ak` | ✓ `staking_pool.compact` | Cardano L1 (Aiken) / Midnight — optional per launch; see the Staking Rewards Pool section |
| Token Metadata (CIP-68 logo) | ✓ | not yet built | Cardano L1 (`token_metadata.ak` — mutable, creator/CTO-controlled reference-NFT metadata, decoupled from the platform's own time-locked minting policy) |

**CTO fee-redirect (2026-07-12) — applies across every row above with a fee/token stream:** until this fix, none of the three bonding curve contracts, Creator Fee Escrow, Vesting, or LP Escrow had any CTO-awareness at all — a passed CTO vote never actually redirected the creator fee, unvested tokens, or LP trading fees to the community wallet, regardless of what `cto_governance`'s own vote-tallying logic said. Fixed by adding the same `ctoTriggered`/community-wallet pattern (`TriggerCTO`/`DissolveCTO` or `triggerCTO`/`dissolveCTO`) to every one of them. Each contract's own trigger must still be called as a separate, off-chain-orchestrated transaction after a vote passes — no cross-contract call mechanism exists to do this atomically.

**Cumulative wallet cap (both Cardano curves):** the 5% cap is one running total per wallet key across a whole launch, not a limit on a single trade. Both curve validators carry a single 32-byte `cap_root` in their datum committing to every wallet's total, and each trade supplies its own total plus a Merkle proof of it — the validator walks that path twice, once against the current root to prove the total is real, once with the updated leaf to derive the new root. The datum therefore stays one fixed size however many wallets trade, there is no allowlist and anyone can buy, and nothing about a wallet is published unless and until it trades. A DarkVeil claim and a public buy draw on the same 5%; a sell returns headroom. The tree is defined once in `contracts/cardano/lib/noctis/cap_accumulator.ak` and mirrored by `integration/cap-accumulator-tree.ts`, both pinned to the same ground-truth literals — the two must agree bit for bit, which is only enforceable with one definition. It caps one *wallet key*, not one person: nothing on-chain distinguishes two keys from two people on any launch, which is what DarkVeil eligibility and the N-hop challenge exist to make expensive.

**Chain-time binding:** every time-gated operation in `vesting.compact` (`claimVested`/`startVesting`) and `lp_escrow.compact` (`sealLock`/`migrateLp`) binds against real chain time via `blockTimeGte`/`blockTimeLte`. Timestamps are never taken as an unchecked caller-supplied value, so vesting schedules and the 365-day LP lock advance only with real elapsed time.

Full contract purposes and circuit lists are in CLAUDE.md's [Contract Architecture](CLAUDE.md#contract-architecture) section and `docs/PSM_ARCHITECTURE.md`.

---

*Diagrams are illustrative, not exhaustive — witness functions, helper circuits, and read-only circuits are omitted for readability. See `contracts/midnight/*.compact` and `contracts/cardano/validators/*.ak` for the real implementations: **8 Midnight PSMs / 502 tests** and **12 Aiken validator modules / 549 checks**, all compiling clean (full ZK proving-key generation for Compact; `aiken check` for Aiken) as of this pass, both suites really re-run rather than carried forward. Counts drift fast here — re-derive them from the two suites' own output rather than trusting this line.*
