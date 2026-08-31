# Noctis Zone — Midnight PSM Contracts

Compact contracts for the Midnight Network PSMs that power Noctis's DarkVeil privacy layer and Midnight Launch fully-private launches.

## Quickstart — compile and test, start to finish

**(2026-07-22 — external finding, GitHub user JAlbertCode, 2026-07-14: this section previously named compiler versions but gave no runnable path from a fresh clone to a passing test run. This closes that gap.)**

```bash
# 1. Install dependencies — from the REPO ROOT, not this directory. This
# package is part of an npm workspace (see package.json at the repo root,
# added 2026-07-30) alongside integration/, packages/types, and
# packages/zk-proofs — one shared lockfile, one install for all four.
cd <repo root>
npm install
cd contracts/midnight

# 2. Confirm you have the REAL Compact CLI, not a false positive
compact --version
# Expect: "compact 0.5.1" (or newer within this project's pragma, see
# Compiler below). If this instead prints NTFS-compression-tool help text
# or otherwise looks wrong, see the Windows gotcha below before going
# further — a "successful" wrong-binary run fails confusingly downstream,
# not with an obvious "wrong tool" error.

# 3. Compile every PSM (fast dev-time path — type-checks, skips ZK proving
# key generation, which takes much longer and isn't needed for a normal
# edit/test loop)
npm run compile
# Equivalent to running this once per contract:
# compact compile --skip-zk <name>.compact compiled/<name>

# 4. Run the full simulator-based test suite (this IS how development
# happens here — every PSM is developed and verified against Compact's
# real TS simulator, not by reasoning about the compiler's own claims in
# isolation; see "Simulation-first development" below)
npx vitest run
# Expect: 11 test files, 471 passing (may drift up over time — check the
# most recent resolved-item test counts if this number looks stale)

# 5. (Optional, slow) Full ZK compile for one contract — only needed when
# you specifically need real prover/verifier key artifacts (e.g.
# measuring real file sizes for hosting),
# not for normal development:
compact compile bonding_curve.compact compiled_realzk/bonding_curve
# No --skip-zk. Real PLONK key generation — expect tens of seconds to a
# couple of minutes per contract, output in the tens-to-hundreds of MB
# (see the deploy/zk-artifacts/README.md at the repo root for real,
# measured per-contract sizes).
```

### Simulation-first development

Every PSM in this directory is developed and verified against
`@midnight-ntwrk/compact-runtime`'s real TypeScript simulator (`tests/*.test.ts`,
run via `npx vitest run` above) — **not** by writing Compact and reasoning
about correctness from the language spec alone. The simulator runs the
actual compiled circuit logic against constructed ledger/witness state and
asserts on real outputs, the same trust level as a live contract call minus
network/proof-generation cost. Treat a change as unverified until its
`vitest` run passes, and treat "it compiles" (`compact compile --skip-zk`)
and "it's correct" (`npx vitest run`) as two separate, both-required bars —
this codebase has repeatedly found real bugs that compiled clean but failed
(or silently did the wrong thing) under the simulator (the Aiken/Cardano
side of this codebase follows the same discipline).

### Windows gotcha: `compact` may not resolve to the Compact CLI

On Windows, a bare `compact` on `PATH` can resolve to `system32\compact.exe`
— Windows' own built-in NTFS file-compression tool, a completely unrelated
program that also accepts a `compact` invocation and exits 0. This produces
no obvious error; it just silently does nothing useful, and the actual
compile step never happens. `package.json`'s own `compile` script guards
against this automatically (checks the version string looks real before
compiling). If you're running `compact` directly rather than via `npm run
compile`, verify with `compact --version` first — expect a version string,
not a file-compression report — or run everything from WSL/a real Linux or
macOS shell, where this collision doesn't exist.

## Contract Overview

| Contract | Purpose | Status |
|----------|---------|--------|
| `eligibility_gate.compact` | Allowlist verification (20-level Merkle proof, depth reduced from 32), 5% cap tracking, NIGHT bond locking, private registration + commitment-based buying + ZK cert (Cardano Launch — merged in the former `darkveil.compact`, Phase 2, 2026-07-11). Real Cardano Launch settlement (ADA payment + token delivery, plus the N-hop Sybil challenge window) happens on Cardano instead — see `contracts/cardano/validators/bonding_curve_tier_b.ak`/`nhop_challenge.ak`. | ✅ compiles clean (full ZK) |
| `bonding_curve.compact` | Quadratic price discovery (shared `k` for both launch types), fee routing, graduation, plus the full eligibility/DarkVeil merge for Midnight Launch (2026-07-10); same 20-level Merkle allowlist proof as above | ✅ compiles clean (full ZK) |
| `creator_escrow.compact` | Creator fee escrow only (1.0% trade fees, monthly claim) — no vesting. Never actually holds a real fee for either tier in the current architecture — real both launch types fee accrual happens elsewhere, see the contract's own file header | ✅ compiles clean (full ZK) |
| `vesting.compact` | Creator TOKEN allocation vesting (90-365 days, no default) — split from creator_escrow 2026-07-09; timestamps bound to real chain time | ✅ compiles clean (full ZK) |
| `treasury.compact` | Platform fee accumulation, ADA/NIGHT balance split with real floor/warning checks | ✅ compiles clean (full ZK) |
| `lp_escrow.compact` | 365-day LP lock, no withdraw, DEX migration | ✅ compiles clean (full ZK) |
| `cto_governance.compact` | Community takeover governance, weighted voting via a governor-published balance-snapshot Merkle tree (also 20-level), `hasClaimableBalance` zero-volume gate | ✅ compiles clean (full ZK) |
| `staking_pool.compact` | Optional per-launch staking rewards, governor-attested stake snapshot, rewards minted via `mintUnshieldedToken` | ✅ compiles clean (full ZK) |

All 8 PSMs compile with full ZK proving-key generation (`compact compile`, not just `--skip-zk`) as of 2026-07-09 — real prover/verifier key artifacts confirmed, not just a type-check pass. (Was 7 between the Phase 2 merge of 2026-07-11, which retired the standalone `darkveil.compact` into `eligibility_gate.compact`/`bonding_curve.compact`, and `staking_pool.compact` arriving on 2026-07-14.)

**`creator_escrow.compact` and `vesting.compact` used to be one file.** The original merged contract applied a day-based vesting *curve* directly to the fee-escrow balance, which was simultaneously being grown by `depositFees` — a real bug (not just confusing labeling), since the vesting formula assumed a fixed total. CLAUDE.md is explicit that Creator Fee Escrow and creator token vesting are two distinct income streams that must never be conflated; the contracts now match that.

## Architecture

**Corrected 2026-07-12** — the previous version of this diagram showed four separate PSMs (Eligibility Gate, DarkVeil, Bonding Curve, Treasury) calling into each other. That was never accurate post-merge and is doubly stale now: Compact has no cross-contract call mechanism at all (see "Cross-PSM Communication" below), and the DarkVeil circuits were folded into other files two sessions ago. The diagram below reflects what's actually deployed, per tier.

```
Cardano Launch (DarkVeil on Midnight, public curve on Cardano):

┌──────────────────────────────────────────────────────────────────┐
│ ELIGIBILITY_GATE.COMPACT                                         │
├──────────────────────────────────────────────────────────────────┤
│ One merged contract, one shared ledger — it was two files,       │
│ eligibility_gate and darkveil, folded together in Phase 2.       │
│                                                                  │
│ allowlist verify · 5% cumulative cap · NIGHT bond lock/refund    │
│ private registration · commitment buying · ZK fair launch cert   │
└──────────────────────────────────────────────────────────────────┘
    │ separate, off-chain-sequenced tx —
    │ no on-chain call exists
    ▼
    contracts/cardano/bonding_curve_tier_b.ak
    (public quadratic curve, ClaimDarkVeilTokens, fee accrual)
    │
    ▼ post-claim, separate tx
    contracts/cardano/nhop_challenge.ak
    (Cardano only — Sybil challenge window, governor-adjudicated)

Midnight Launch (everything on Midnight):

┌──────────────────────────────────────────────────────────────────┐
│ BONDING_CURVE.COMPACT                                            │
├──────────────────────────────────────────────────────────────────┤
│ A three-way merge, one shared ledger — it was eligibility_gate,  │
│ darkveil and bonding_curve, folded together.                     │
│                                                                  │
│ allowlist verify · 5% cumulative cap (DV + public, atomic)       │
│ NIGHT bond lock/refund · private DV buy · ZK fair launch cert    │
│ quadratic price discovery · fee routing · graduation             │
└──────────────────────────────────────────────────────────────────┘

Shared by both launch types (separate deployed PSMs, with no calls
between them — each is its own off-chain-sequenced transaction):

┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
│ CREATOR_ESCROW + VESTING │ │ TREASURY.COMPACT         │ │ LP_ESCROW.COMPACT        │
├──────────────────────────┤ ├──────────────────────────┤ ├──────────────────────────┤
│ fee escrow claim,        │ │ fee accumulation —       │ │ 365-day lock · migrate   │
│ token vesting            │ │ ADA/NIGHT split          │ │ NO withdraw, by design   │
│                          │ │                          │ │ (Midnight Launch only)   │
└──────────────────────────┘ └──────────────────────────┘ └──────────────────────────┘

CTO_GOVERNANCE.COMPACT — a separate ballot PSM used by every launch
type. It triggers each dependent contract's own triggerCTO circuit,
each in its own separate transaction.
```

## Cross-PSM Communication

**Corrected 2026-07-10/2026-07-12.** Compact has no contract-to-contract call mechanism of any kind — confirmed by compiling real probe contracts against the compiler (every call form fails with "contract types are not yet implemented"). "Transaction merging" was never a real primitive; that claim has been retracted everywhere in this codebase. Two things actually happen instead:

- **Compile-time contract merging:** folding multiple `.compact` source files into ONE deployed contract with one shared ledger, via `include`/`module` directives, before compilation. This is how the 5% cumulative DarkVeil+public cap is enforced atomically — `eligibility_gate.compact` (Cardano Launch, merged with the former `darkveil.compact`) and `bonding_curve.compact` (Midnight Launch, merged with both former `eligibility_gate.compact`/`darkveil.compact` sources) each read/write one shared `cumulativePurchases` map inline. There is no cap check that crosses a deployed-contract boundary in either tier.
- **Separate, off-chain-sequenced transactions:** everything else that looks like "PSM A calls PSM B" (CTO trigger/dissolve, launch cancellation, fee deposits) is actually two independent transactions the platform's off-chain orchestration layer submits in sequence, with no on-chain atomicity guarantee between them. **Corrected 2026-07-12:** an earlier version of this section said neither Cardano Launch's Cardano curve nor Midnight Launch's `bonding_curve.compact` had any CTO-awareness at all, so a passed CTO vote never redirected creator fees. That gap is now closed — both, plus Creator Escrow, Vesting, Treasury, and LP Escrow, all gained the same `ctoTriggered`/community-wallet pattern (`TriggerCTO`/`DissolveCTO`). Each still requires its own separate, off-chain-orchestrated transaction to invoke — there's no atomic "one vote redirects everything" call, since no cross-contract call mechanism exists — but the redirect itself now genuinely works everywhere it's supposed to.

`checkAndUpdateCap` (referenced in an earlier version of this section) was removed from `eligibility_gate.compact` — it was a standalone circuit nothing ever called; the cap check now lives inline in `revealBuyCommit` directly.

## Compiler

- **Version:** compactc v0.31.1 (CLI 0.5.1)
- **Pragma:** `>= 0.16 && <= 0.23`
- **Validation:** `compact compile --skip-zk` for development, full compile for validation
- **SDK pin:** `integration/package.json`'s `@midnight-ntwrk/midnight-js-*` packages are pinned to `4.1.1`. The deployed proof-server must run a compatible version of this same SDK generation — a mismatched proof-server version is a confirmed failure mode (`/prove` returns 400/500), not just a theoretical risk. Re-check this pin before bumping either side.

## Key Design Decisions

1. **Witness-derived identity:** All user identity uses `UserPublicKey` (domain-separated `persistentHash` of private secret), never `ownPublicKey` (which is bypassable)
2. **No division in circuits:** Price verification uses multiplication invariant: `price * supply == base * supply + sold * range`
3. **Commitment-nullifier pattern:** DarkVeil uses commitment hashes + nullifiers for double-spend prevention without revealing identity
4. **Sealed metadata:** All deploy-time parameters use `sealed ledger` for immutability
5. **Governor pattern:** Admin operations use witness-derived governor key (same pattern as midnight-modules `access-control`)

## Reused Patterns

| Pattern | Source | Used In |
|---------|--------|---------|
| Witness-derived UserPublicKey | midnight-expert FungibleToken | All PSMs |
| Commitment-nullifier | midnight-modules | DarkVeil, Eligibility Gate |
| Merkle membership | midnight-modules | Eligibility Gate |
| Compile-time contract merging (`include`/`module`) | — | both launch types DarkVeil+curve cap enforcement |
| Liveness timer | midnight-modules | Creator Escrow, LP Escrow |
| Access control | midnight-modules | All PSMs (governor pattern) |
| Composite key hashing | SilentLedger AssetVerification | Eligibility Gate |
| Commitment-based orders | SilentLedger SilentOrderbook | DarkVeil |
| Fill matching | SilentLedger ObfuscatedOrderbook | Bonding Curve |

## SilentLedger Upgrade Plan

SilentLedger's three contracts are being upgraded in parallel:

1. Replace `ownPublicKey` with witness-derived `UserPublicKey`
2. Add `disclose` on all witness-derived values flowing to ledger
3. Widen `Uint<64>` to `Uint<128>` for bonding curve math
4. Replace placeholder `validateProof` with witness-based ZK verification
5. Add `sealed` to metadata fields
6. Extract reusable patterns into midnight-modules

---

*They can't front-run what they can't see.*
