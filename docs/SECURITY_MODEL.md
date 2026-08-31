# Noctis Zone — Security Model

> **Version:** 2.0
> **Last Updated:** July 12, 2026
> **Status:** Post-audit. Two full adversarial review passes (2026-07-11) plus three hardening passes (2026-07-12) have run against every PSM and Aiken validator. This document reflects the current, fixed state — not a pending checklist. The full per-finding audit trail is maintained internally.

---

## Table of Contents

1. [Security Principles](#1-security-principles)
2. [Threat Model](#2-threat-model)
3. [Attack Vectors](#3-attack-vectors)
4. [Cryptographic Assumptions](#4-cryptographic-assumptions)
5. [Access Control](#5-access-control)
6. [Privacy Guarantees](#6-privacy-guarantees)
7. [Economic Security](#7-economic-security)
8. [Audit History](#8-audit-history)
9. [Incident Response](#9-incident-response)

---

## 1. Security Principles

1. **Privacy by default** — All user data is private unless explicitly disclosed
2. **No withdraw on LP** — By design. LP tokens cannot be extracted, only migrated after lock expiry
3. **Forced vesting** — Creator must choose 90-365 days. No default. No instant liquidity.
4. **Cumulative cap enforcement** — 5% per-wallet limit tracked across DarkVeil + public phases, enforced inline at the point of purchase (not via a separate, independently-callable circuit — see 3.2)
5. **Governor accountability** — Admin key is witness-derived, domain-separated, and all actions are on-chain
6. **Fail-safe cancellation** — DarkVeil and bonding curve can be cancelled with bond/principal refunds
7. **No division in circuits** — All math uses multiplication invariants to avoid precision issues (Compact); Aiken's arbitrary-precision `Int` allows real division where the Cardano contracts need it
8. **On-chain enforcement over off-chain trust, everywhere it's achievable** — where it genuinely isn't achievable (see 6, off-chain eligibility computation), the trust boundary is stated explicitly rather than implied away

---

## 2. Threat Model

### Assets

| Asset | Real current location | Value |
|-------|----------|-------|
| User secret keys | Client-side (wallet) | Identity, funds |
| Governor secret key | Server-side (secured) | Admin control |
| NIGHT bonds | `eligibility_gate.compact` (Cardano Launch) / `bonding_curve.compact` (Midnight Launch, merged) | $50 USD per participant |
| Token balances | Merged curve contract per tier — `eligibility_gate.compact`/`bonding_curve_tier_b.ak` (Cardano Launch) or `bonding_curve.compact` (Midnight Launch) | User tokens |
| LP tokens | `lp_escrow.ak` (Cardano) / Midnight LP Escrow PSM (Midnight Launch, design pending a graduation-target DEX) | Post-graduation liquidity |
| Creator escrow (Cardano Launch) | **Not `creator_escrow.compact`** — accrues directly on `bonding_curve_tier_b.ak`, the Cardano curve contract, since real ADA settlement moved there entirely. `creator_escrow.compact`'s `depositFees` is real and tested but never invoked in this architecture. | Creator's raised funds |
| Creator escrow (Midnight Launch) | `bonding_curve.compact`'s inline `creatorFees` ledger field — same reason, Compact has no cross-contract call mechanism to route it through a separate PSM | Creator's raised funds |
| Treasury fees | Per-tier curve contract (accrual) → `treasury.compact` is designed to receive them but, like `creator_escrow.compact`, is never actually invoked by either tier's curve in the shipped architecture | Platform fees |
| N-hop challenge bond (Cardano Launch only) | `nhop_challenge.ak`, one UTXO per challenge | 25 ADA per challenge |
| ZK Fair Launch Certificate | Merged curve/eligibility contract → Cardano ZK Anchor Contract, relayed by a platform-operated relayer | Launch integrity proof |
| Staking reserve (Cardano) | `staking_pool.ak` — real on-chain custody, one pool-state UTXO + one position UTXO per stake action | Up to 25% of total supply, optional per launch |
| Staking reward mint budget (Midnight Launch) | `staking_pool.compact`'s `poolBalance` ledger field — an authorized-to-mint budget, not pre-funded custody; real coins mint only at claim time via `mintUnshieldedToken` | Up to 25% of total supply, optional per launch |

### Adversaries

| Adversary | Capabilities | Motivation |
|-----------|-------------|------------|
| Front-running bot | Sees pending transactions | Steal MEV |
| Whale | Large capital, multiple wallets | Exceed 5% cap |
| Malicious creator | Controls launch config | Rug-pull, self-buy, wash-trade |
| Compromised governor | One attesting key | Cancel launches; a single key no longer writes the electorate (see 3.4) |
| Network observer | Sees all on-chain data | De-anonymize participants |
| Sybil attacker | Creates many identities | Spam DarkVeil registration, dilute `base_slot` (see 3.8) |

---

## 3. Attack Vectors

### 3.1 Front-Running

**Attack:** Bot sees a large buy order and submits their own order first to profit from the price impact.

**Mitigation:** DarkVeil uses commitment-based buying. Buy amounts are hidden in commitment hashes. Bots cannot see what to front-run.

**Residual risk:** During the public bonding curve phase (all tiers), transactions are visible. This is accepted — DarkVeil is the front-run protection layer, not the public phase.

### 3.2 Cap Circumvention

**Attack:** Whale splits funds across multiple wallets to exceed the 5% cumulative cap.

**Mitigation (current, corrected):**
- DarkVeil: Each wallet must prove allowlist membership via ZK against a governor-published Merkle root (leaf derived **in-circuit** from the caller's own identity — see 4, Merkle Tree).
- Public + DarkVeil phases (both tiers): the 5% cap is enforced **inline**, at the point of purchase, inside `revealBuyCommit`/`buyTokens`/`submitBuyCommit` — never via a standalone, separately-callable circuit, so the cap cannot be manipulated independently of an actual purchase. (A standalone `checkAndUpdateCap` circuit named in older documentation no longer exists; any reference to it is stale.)
- Cross-phase: the cumulative cap tracks across DarkVeil + public phases in one shared ledger map per tier's deployed contract.

**Residual risk:** A sophisticated whale with multiple distinct identities on the allowlist could still exceed 5% total. This is an accepted limitation — the cap raises the bar, not an absolute wall.

### 3.3 Creator Rug-Pull

**Attack:** Creator launches, raises funds, then drains LP or abandons the project.

**Mitigation:**
- LP is locked for 365 days with **no withdraw function**
- Creator funds are vested over 90-365 days (no default, forced selection), timestamp-bound to real chain time (see 3.9)
- ZK Fair Launch Certificate provides permanent public record of launch fairness
- Governor can cancel DarkVeil/the bonding curve if fraud is detected (bonds/principal become refundable)
- If the creator goes silent (no fee claim + no claimable-balance change) **and** the launch actually has a real balance to recover, the community can trigger a CTO vote — gated on `hasClaimableBalance` so a zero-volume launch can never have a CTO vote triggered over nothing

**Residual risk:** Creator could still abandon the project after vesting completes. This is a business risk, not a protocol risk.

### 3.4 Governor Key Compromise

**Attack:** Attacker steals the governor's secret key and uses it to cancel launches, withdraw fees, or manipulate governance.

**Mitigation:**
- Governor key is witness-derived (not stored on-chain in plaintext)
- All governor actions are on-chain and publicly auditable
- Fee withdrawal is limited to accumulated amounts (cannot steal user funds)
- Cancellation triggers bond/principal refunds (participants protected)
- **CTO vote weight cannot be fabricated by the governor** — `castVote` requires a real Merkle proof against a published `balanceSnapshotRoot`, so no single voter can fabricate a `voteWeight` out of nothing
- **The attested facts take two keys, not one.** `balanceSnapshotRoot`, `lastCreatorActivity`/`hasClaimableBalance`, and each tier's `allowlistRoot` are written only after **two of three registered attestors** have called for the same value, in separate transactions, within 24 hours of each other. Approvals are recorded per signer, so one attestor calling twice is one approval; rounds are numbered, so an approval given for a superseded value cannot be counted toward the current one.
- The signatures cannot be gathered into one call, and that is deliberate. Every witness for a call is produced by whoever builds it, so a threshold checked inside a single circuit would be one party holding every secret — which is why the accumulation is on-chain.

**Residual risk:** Attestation establishes agreement, not truth. Two attestors who agree on a wrong value write a wrong value, so the facts above still rest on honest off-chain computation — what changed is that no single key decides them. The inputs are public, so a wrong root is provable by anyone after the fact, and the CTO safeguards (1% per-voter cap, 15 distinct voters, 30-day holding period) mean a skewed snapshot has to be broad rather than surgical to matter.

The staking pool's `rewardRoot` is attested by the governor alone, and is published on an automated daily schedule. Its effect is bounded by the contract rather than by the number of signers: cumulative claims can never exceed the pool's real balance, so a wrong root changes how a funded pool is divided and cannot create tokens or reach any other launch. Reporting liveness is likewise a single call — `lastGovernorUpdateTimestamp` records that the governor answered, which is what the break-glass challenge asks, and is deliberately not something a second party can withhold.

A governor can also cancel a legitimate launch; recovery is re-deploying with a new governor key.

### 3.5 De-Anonymization

**Attack:** Adversary correlates on-chain data to identify DarkVeil participants.

**Mitigation:**
- `UserPublicKey` is a domain-separated hash of a private secret — not linkable to real-world identity
- Different PSMs/tiers use different domain tags — cross-PSM linking is prevented
- Buy commitments are hashes — individual amounts are hidden until reveal
- Nullifiers are unique per (user, launch) — not linkable across launches
- ZK Fair Launch Certificate contains only aggregate data
- Cardano Launch's real DarkVeil settlement (`ClaimDarkVeilTokens` on `bonding_curve_tier_b.ak`) uses a Merkle-root allocation scheme specifically so that no registrant's real Cardano wallet is ever linked to their DarkVeil participation **unless and until that specific wallet claims** — an earlier design had pre-seeded every registrant's `(wallet, amount)` pair in plaintext on Cardano at deploy time, which was a real privacy violation, found and fixed in the same pass that added real settlement

**Residual risk:** Once a user claims their tokens (Cardano Launch) or reveals their commitment, their real wallet address and token amount become linked and public. This is accepted — the claim/reveal is voluntary and is the mechanism `nhop_challenge.ak` (3.8) relies on to have anything real to challenge against.

### 3.6 Double-Buying in DarkVeil

**Attack:** User submits multiple buy commitments to get more than their allocation.

**Mitigation:**
- Nullifier `H(buyerKey, launchId, ...)` is unique per (user, launch)
- `buyNullifiers`/`registrationNullifiers` sets prevent duplicate nullifiers
- A user can only submit one commitment per launch
- **Registration-to-buying linkage:** `submitBuyCommit` requires the caller to recompute their own registration nullifier and prove it is already a member of `registrationNullifiers`, so a buy commitment cannot be submitted by a wallet that never passed the wallet-age/allowlist/NIGHT-bond gate.

**Residual risk:** None at the protocol level. A user with multiple distinct identities could submit multiple commitments, but this is bounded by the allowlist.

### 3.7 Replay Attacks

**Attack:** Adversary reuses a previously valid proof or commitment.

**Mitigation:**
- Registration/buy/vote nullifier sets prevent proof and commitment replay (`registrationNullifiers`, `buyNullifiers`, `voteNullifiers`)

**Residual risk:** None at the protocol level.

> Correction: an earlier version of this document referenced a `usedVerifications` set in "ObfuscatedOrderbook (SilentLedger)" as part of Noctis's own replay prevention. No such contract or ledger field exists anywhere in this codebase — "SilentLedger/ObfuscatedOrderbook" only ever appears as a pattern-inspiration credit in file header comments (fill-matching conventions borrowed for `bonding_curve.compact`), not as a deployed Noctis component. Noctis's actual replay prevention is entirely the nullifier sets above.

### 3.8 Sybil Registration / Slot Dilution

**Attack:** A creator's own associates register as ghost DarkVeil participants, increasing `registered_count` and shrinking `base_slot = dv_supply / registered_count` for every legitimate buyer — diluting real participants' allocations without the creator ever touching their own wallet.

**Mitigation:** `contracts/cardano/validators/nhop_challenge.ak` (Cardano Launch only — Midnight Launch is fully build-blocked independent of this feature). Anyone can post a 25 ADA bond and challenge a DarkVeil claimant as a Sybil (within 5 hops of the creator's wallet, 180-day lookback). Deliberately triggers **after** the claimant's `ClaimDarkVeilTokens` call, not at registration — a registrant's real wallet is never publicly linked to DarkVeil until they claim, so triggering earlier would require deanonymizing every registrant just to make them challengeable (see 3.5). Resolution is **governor-adjudicated** — the actual N-hop transaction-graph evidence and the timing of the challenge are both facts a Compact/Aiken script has no way to verify independently (same category as `hasClaimableBalance`/`lastCreatorActivity`, see 5). The contract's on-chain job stays narrow: hold the bond, enforce a mandatory 24-hour defence window against real chain time, and pay out correctly — the challenger's bond back in full if upheld, or forfeited to the platform wallet if rejected. The window counts from a submission time the chain agreed to: opening a challenge mints a token under the validator's own policy, and that mint is where the recorded time is checked against the transaction's validity range. A challenge that never minted cannot be resolved at all, so the defence window a registrant gets is a real 24 hours rather than whatever the challenger wrote down.

**Residual risk:** Because the challenge can only fire post-claim, it cannot prevent the dilution itself — the tokens are already delivered and cannot be clawed back on Cardano once claimed. This is accepted by design: the mechanism provides post-fact accountability and a bounty, not real-time prevention. A different griefing vector — an outsider registering enough of a launch's DarkVeil participants to force a failed phase — is bounded economically rather than by this mechanism: every registration locks a NIGHT bond worth $50, and a registrant who then buys nothing forfeits all of it, so the attack is paid for per identity and refunds nothing. The eligibility checks in 3.5 set the floor on what an identity costs to produce in the first place.

### 3.9 Timestamp Manipulation

**Attack:** a caller supplies a false timestamp to a time-gated operation, attempting to advance a vesting schedule or an LP lock faster than real elapsed time.

**Mitigation:** All of these now bind the supplied timestamp against real chain time via `blockTimeGte`/`blockTimeLte` (±1 hour tolerance for anchor-setting calls where some slack is legitimate, exact for hard deadline checks). `migrateLp`/`isLockExpired` had their `currentTimestamp` parameter removed entirely — same idiom `bonding_curve.compact`'s `expireCurve` already used.

**Residual risk:** None beyond the general assumption that the underlying chain's own timestamp/slot data is honest — the same assumption every other timestamp check in this system already depends on.

### 3.10 Staking Rewards Pool — trust model split by tier

**Attack (governor-forged reward claim):** Both `staking_pool.ak` and `staking_pool.compact` gate reward claims on a governor-published Merkle root over `(staker, cumulative_amount)` leaves — the same trust model already accepted for allowlist membership and CTO voting weight elsewhere in this codebase (Section 5, Governor Pattern). A malicious or compromised governor could publish a root crediting themselves (or a colluding party) with rewards never actually earned.

**Mitigation:** The underlying stake/unstake events (Cardano) or off-chain-observed stake activity (Midnight Launch) are all real, public on-chain facts — the governor's reward computation is independently re-derivable and auditable by anyone, the same "trust the computation because it's checkable, not because it's promised" argument already made for `hasClaimableBalance`/`lastCreatorActivity` (Section 5). Neither contract will pay out more than the caller's own proven leaf allows, and `poolBalance` (or the real UTXO balance on the Cardano side) hard-caps total payout regardless of what the governor publishes — a forged root can misallocate who gets what, but cannot mint value the pool was never funded with.

**Tier-specific residual risk:** Cardano's `staking_pool.ak` gives real on-chain custody of the staked tokens themselves — a forged reward root affects only the reward payout, not the underlying stake. Midnight Launch's `staking_pool.compact` has a strictly larger trust surface: `bonding_curve.compact` never mints the Midnight Launch launch token as a real coin (tracked only in an internal ledger map), and Compact has no cross-contract call mechanism to reach it, so **"staked amount" itself is governor-attested, not custodied** — a compromised Midnight Launch governor could misrepresent who has how much staked, not just misallocate rewards. This is a real, deliberate architecture difference from Cardano, chosen over merging staking circuits into the already-audited `bonding_curve.compact` — flagged here explicitly rather than presented as equivalent to the Cardano side.

---

## 4. Cryptographic Assumptions

### Hash Function

- **`persistentHash`** — Midnight's built-in deterministic hash function; **`blake2b_256`** — the Aiken/Cardano-side equivalent
- **Assumption:** Collision resistance (no two distinct inputs produce the same hash)
- **Usage:** Identity derivation, commitment computation, nullifier computation, Merkle node hashing, certificate hash

### Merkle Tree

- **Allowlist verification** (DarkVeil registration) and **balance-snapshot verification** (CTO vote weight) — prove membership without revealing which leaf
- **Depth:** fixed at 20 levels in Compact (1,048,576 max leaf capacity, 37.5% fewer hash operations per proof; Aiken's DarkVeil-allocation Merkle proof on `bonding_curve_tier_b.ak` has no fixed-depth constraint at all, since Aiken has no `fold`-only-fixed-loop-count limitation the way Compact's ZK circuits do)
- **Leaf derivation:** the leaf is derived **in-circuit** from the caller's own identity (`persistentHash` over a domain tag + the caller's own witness-derived key), not supplied as a free witness value — this closed a real identity-borrowing bug where a caller could previously copy another registrant's leaf+proof and pass membership as someone else
- **Assumption:** the tree is built correctly and the root is published honestly by the governor. This is a real, accepted trust boundary — see 6 (Privacy Guarantees) for what this means for the eligibility checks specifically.

### Zero-Knowledge Proofs

- **Proof system:** Midnight's native ZK proof generation (via `compactc`'s full compile path, not `--skip-zk`)
- **Assumption:** Soundness (false statements cannot be proven) and zero-knowledge (proofs reveal nothing beyond validity)
- **Usage:** allowlist membership, balance-snapshot membership (CTO votes), commitment/nullifier ownership
- **What ZK proofs do NOT do here:** they do not, and cannot, independently verify facts about **external chain state** (e.g. a Cardano wallet's real transaction history). No bridge or state-reading mechanism exists that would let a Midnight circuit verify a Cardano-side fact in zero-knowledge (confirmed — Compact has no cross-contract call mechanism at all, and the only Cardano↔Midnight bridge found is one-way and NIGHT-only). See 6 for how DarkVeil eligibility actually handles this.

---

## 5. Access Control

### Governor Pattern

All admin operations require the governor's witness-derived key:

```compact
const govSecret = getGovernorSecret;
const govKey = deriveGovernorKey(govSecret);
assert(disclose(govKey == governorKey), "Only governor can ...");
```

### Governor Capabilities (current, per real contract)

| Action | Contract(s) | Risk if compromised |
|--------|-----|---------------------|
| `activateCurve` / `cancelCurve` / `expireCurve`* | All 3 curve contracts | Start/stop buying (*`expireCurve` is permissionless once a stall deadline passes — "the deadline is the authorization," not governor-gated) |
| `revealBuyCommit`/allowlist cap enforcement | Merged eligibility+curve contract per tier | Inline, not separately callable — see 3.2 |
| `updateBalanceSnapshot` | `cto_governance.compact` | Publishes the Merkle root every `castVote` weight proof is checked against — **one key writes the electorate's weights.** A dishonest or compromised governor can publish a skewed snapshot, and this contract cannot check it: Compact has no cross-contract read into the ledger that holds real balances, so there is no ground truth on hand to compare against (see 3.4). What bounds it: weights are capped at 1% per voter with a 15-voter minimum and a 30-day holding requirement, so a skew has to be spread across many plausible, aged holders rather than concentrated in one; every timestamp is pinned to real chain time; snapshot age is bounded; and the inputs are public, so a wrong root is provable by anyone. **Detectable after the fact, not prevented.** |
| `updateCreatorActivity` | `cto_governance.compact` | Sets `lastCreatorActivity` **and** `hasClaimableBalance` from off-chain monitoring — same governor-attested-fact trust boundary as the balance snapshot above |
| `TriggerCTO` / `DissolveCTO` (or `triggerCTO`/`dissolveCTO`) | **All three** bonding curve contracts (`bonding_curve.ak`, `bonding_curve_tier_b.ak`, `bonding_curve.compact`), plus `lp_escrow.ak`/`creator_escrow.compact`/`vesting.compact`/`treasury.compact` | Redirects a live creator/LP fee stream to a community wallet, or reverts it. Governor-only trigger, but only fires after a real passed CTO vote (see 4/5's balance-snapshot gate) |
| `withdrawFees`/`claimFees` (all currencies) | Per-tier curve contract, `treasury.compact`, `creator_escrow.compact` | Now pay out **real value** via `sendUnshielded`/real UTXO movement — before the audit, several of these were ledger-only decrements with no matching real transfer. The risk profile changed from "impossible to actually drain" to "real, but bounded to fixed, pinned payout addresses — not an arbitrary destination" |
| `ResolveChallenge{upheld, current_timestamp}` | `nhop_challenge.ak` (Cardano Launch) | Governor adjudicates an N-hop Sybil challenge off-chain; on-chain only enforces the defense-window timing and correct payout (see 3.8) |
| `sealLock` / `migrateLp` | `lp_escrow.ak`/`lp_escrow.compact` | Seal/migrate LP; timestamps now bound to real chain time (see 3.9) |
| `ProposeDexChange` / `ExecuteDexChange` / `CancelPendingDexChange` | `lp_escrow.ak` | Multisig-gated proposal + mandatory 72h public notice before a whitelist change takes effect — replaced an earlier single-governor-signature, immediate-effect design |
| `publishStakeSnapshot` / `publishRewardRoot` | `staking_pool.ak`/`staking_pool.compact` | Publishes the Merkle roots every `ClaimRewards`/`claimRewards` proof is checked against. On Midnight Launch specifically, this is the ONLY record of "who has staked how much" — see 3.10's residual-risk note, a strictly larger trust surface than the equivalent Cardano risk |
| `topUpPool` | `staking_pool.ak`/`staking_pool.compact` | Creator-only (not governor), increases the pool's mintable/claimable budget — cannot be used to drain, only to add |

### User Authentication

Users prove identity via witness-derived `UserPublicKey`:

```compact
const sk = getUserSecret;
const caller = deriveUserPublicKey(sk);
assert(disclose(caller.bytes == ownerHash), "Not the owner");
```

---

## 6. Privacy Guarantees

### What Is Guaranteed

1. **Identity privacy:** `UserPublicKey` is a domain-separated hash. It cannot be linked to a real-world identity without the secret key.
2. **Amount privacy (DarkVeil):** Buy amounts are hidden in commitment hashes until the reveal phase (Midnight Launch) or the real Cardano claim (Cardano Launch's Merkle-root allocation scheme — nobody's amount is published unless and until they claim).
3. **Cross-PSM/cross-tier unlinkability:** Different domain tags prevent linking a user's activity across contracts.
4. **Cross-launch unlinkability:** Nullifiers are launch-specific. A user's nullifier in Launch A is different from Launch B.
5. **Aggregate-only transparency:** The ZK Fair Launch Certificate contains only totals, not individual records.

### How DarkVeil eligibility actually works (important correction, 2026-07-12)

CLAUDE.md's Registration Eligibility section previously described check #1 (wallet age ≥ 90 days) as verified via "a ZK proof against UTxO history" generated client-side. **This was never achievable and has been corrected** — see 4 (Zero-Knowledge Proofs) for why no such mechanism can exist. The real, current model:

- Checks #1 (wallet age) and #5 (no direct ADA flow from creator, 90-day lookback) are computed **off-chain**, against real Blockfrost data, in `integration/eligibility-checker.ts` (`checkWalletAge`, `checkNoDirectAdaFlow`).
- Only wallets that pass get a leaf in the allowlist Merkle tree the governor publishes.
- The on-chain `verifyAllowlist` ZK proof only ever proves **membership** in that published tree — it has no way to independently re-verify wallet age or any other off-chain-computed fact itself.
- Check #2 (NIGHT balance ≥ $50 USD) is confirmed **achievable** via `midnight-indexer`'s public `unshieldedTransactions(address)` GraphQL subscription (real third-party verification, not wallet self-report) but is not yet built — needs a new indexer client plus a real Orcfax/Minswap price-oracle client.
- Check #4 (stake key ≠ creator's) is **genuinely blocked**, not just deferred: a registrant's real Cardano stake key isn't independently verifiable inside a Midnight circuit or an off-chain check without real cross-chain proof machinery (a wallet-signed attestation, or a ZK proof binding a Midnight registration to a provably-owned Cardano stake key). A witness self-report would be security theater, not a real gate — this needs actual Midnight wallet SDK work that doesn't exist yet.

This is the same trust model already used for `cto_governance.compact`'s balance-snapshot tree: **trust the governor's off-chain computation, verify membership in what they published** — not a false claim of trustless, fully on-chain verification of every underlying fact.

### What Is NOT Guaranteed

1. **Post-reveal/post-claim amount privacy:** After a user reveals their commitment (Midnight Launch) or claims their tokens (Cardano Launch), their real wallet address and token amount become linked and public.
2. **Network-level privacy:** IP addresses, timing analysis, and other network-level attacks are not mitigated by the protocol.
3. **Allowlist privacy:** the allowlist root is public. Individual membership is private (via ZK proofs), but the underlying eligibility computation (see above) is trusted, not independently re-verifiable on-chain.
4. **Correctness of the underlying off-chain eligibility computation:** the platform must actually run the eligibility checks honestly before publishing the allowlist root — there is no on-chain mechanism that would catch a governor who published a root containing an ineligible wallet.

---

## 7. Economic Security

### NIGHT Bond (DarkVeil registration)

- **Amount:** $50 USD equivalent, fixed at lockup, never re-priced at release
- **Purpose:** Anti-spam + skin-in-the-game
- **Refund — ratio-based:** `NIGHT_returned = NIGHT_bonded × (tokens_purchased / tokens_allocated)`. Bought 100% of allocation → 100% returned. Bought 50% → 50% returned, 50% forfeited. Bought 0% (ghost) → 100% forfeited. Phase failed (<50% participation) → 100% returned to all, no forfeiture. Implemented for **both tiers** (Midnight Launch originally, ported to Cardano Launch's `eligibility_gate.compact` in a later merge) and pays out for real via `sendUnshielded` (an earlier version of several of these claim circuits only cleared the ledger with no real payout — an audit finding, now fixed).
- **Forfeiture routing:** paid whole to the one platform address, directly via `sendUnshielded` from the same claim call — no separate cross-contract step needed, since the destination is a fixed, real address.

### N-Hop Challenge Bond (Cardano Launch only)

- **Amount:** 25 ADA, held in a dedicated `nhop_challenge.ak` UTXO per challenge
- **Purpose:** Anti-spam for Sybil-registration challenges (see 3.8)
- **Upheld:** bond returned to the challenger in full (a NIGHT bounty is paid separately, off-chain-orchestrated, since a Cardano script cannot send NIGHT directly)
- **Rejected:** bond forfeited to the platform wallet (the same destination as a forfeited NIGHT bond)

### Fee Structure

- **Total:** 2.0% per trade
- **Split:** 1.0% creator / 0.6% treasury / 0.4% ops
- **Real accrual location (per tier, not the originally-designed Midnight PSMs — see 2):** The linear curve — `bonding_curve.ak`. Cardano Launch — `bonding_curve_tier_b.ak` (Cardano, both public-phase and DarkVeil-claim fees). Midnight Launch — `bonding_curve.compact`'s inline ledger fields.
- **Withdrawal:** gated to the active fee recipient (creator, or the community wallet once a CTO vote has passed — see 5), amounts limited to accumulated balances, real value movement enforced by audit

### LP Lock

- **Duration:** 365 days minimum, timestamp-bound to real chain time (see 3.9)
- **No withdraw:** by design. LP tokens cannot be extracted.
- **Migration:** only to whitelisted DEXes, only after lock expiry, gated by a multisig proposal + mandatory 72h public notice, not a single governor signature
- **`HarvestFees`:** lets ongoing DEX trading fees reach the fee recipient without touching the locked LP position itself — verifies only that the locked amount is byte-for-byte unchanged and the correct recipient is paid, does not model any specific DEX's real harvest call (that remains genuinely open per DEX)

---

## 8. Audit History

The protocol has been through **multiple full adversarial review passes** across both chains — every Compact PSM and every Aiken validator — followed by dedicated hardening passes. Reviews covered the standard categories for this class of system: authorization and access control, value conservation, privacy and disclosure boundaries, cryptographic construction, time handling, and economic/griefing vectors.

**All findings from those passes have been resolved, or explicitly accepted and documented, before this version.** Where a finding resulted in a contract change, it is covered by dedicated regression tests: the suites stand at **257 Aiken checks** and **256 Compact tests**, all passing.

Per-finding writeups — including severity, reproduction detail, and the specific fix — are maintained internally rather than published. This is deliberate: forensic exploit detail is useful to an attacker well beyond the specific contract it was found in, and several of these contracts share patterns. **The full audit trail is available to auditors, integration partners, and security researchers on request.**

### Known trust boundaries (not defects — design decisions)

These are the points where the protocol relies on something other than on-chain enforcement. They are stated here rather than buried, because a security model that hides its trust assumptions is not a security model:

- **Governor-published roots.** Allowlist membership and CTO voting-weight snapshots are published by the governor role. They are derived from public on-chain data, so any published root is independently re-derivable and auditable by third parties — but their publication is a trusted step. Hardening the governor role (key custody, multisig) is tracked internally.
- **Off-chain eligibility computation.** Some DarkVeil eligibility checks are computed off-chain and enforced via allowlist membership, because the underlying facts are not reachable from inside a Midnight circuit. Section 6 describes exactly how this works, rather than implying stronger guarantees than exist.
- **Per-DEX LP fee-harvest compatibility** is confirmed per DEX before that DEX is whitelisted, not assumed.

### Reporting

Please report suspected vulnerabilities **privately** rather than opening a public issue, so a fix can be shipped before any disclosure.

---

## 9. Incident Response

### DarkVeil Cancellation

1. Governor calls the cancel circuit for the merged eligibility/DarkVeil contract
2. All participants can claim bond refunds via `claimBondRefund` (full refund) or `claimRatioBondRefund` (partial, if the phase closed normally but a participant under-bought — see 7)
3. No tokens are allocated from DarkVeil
4. Public bonding curve may proceed (governor decision)
5. Post-mortem published with root cause analysis

### Bonding Curve Cancellation

1. Governor calls `cancelCurve`
2. No further buys possible
3. Existing buyers retain token balances
4. Fees remain in accumulators
5. **Governor CANNOT withdraw accumulated fees from a cancelled curve** — `withdrawFees` explicitly rejects once `curveState == Cancelled`. This is a deliberate change from an earlier design: allowing fee withdrawal from a cancelled curve created a real double-drain race against `claimCurveRefund`, which lets buyers reclaim their full gross payment (fees included) on a cancelled/failed launch. Fees on a cancelled launch are void, not claimable.
6. Buyers reclaim principal via `claimCurveRefund` (curve never graduated) or `ClaimBuyback` (stuck curve past its stall deadline, pro-rata)

### Governor Key Compromise

1. Identify compromise (anomalous governor actions — a skewed balance snapshot, an unexpected `TriggerCTO`, an implausible `hasClaimableBalance`/`lastCreatorActivity` update)
2. Deploy new PSM/validator instances with a new governor key
3. Migrate user balances and state to new instances
4. Revoke old governor key (by abandoning old contracts)
5. Post-mortem published with timeline and impact assessment

### LP Escrow Issues

1. If lock is not sealed: governor must call `SealLock`/`sealLock` — this now requires **real value received** (`lp_value_received`) matching the graduation transfer, not just a governor signature
2. If DEX is not whitelisted: a `ProposeDexChange` must clear its 72h public notice window before `ExecuteDexChange` can run — no more single-signature immediate whitelist changes
3. If LP is stuck: same propose → notice → execute path applies for adding a new destination DEX

### N-Hop Challenge Disputes (Cardano Launch)

1. Anyone can submit a challenge against a claimed DarkVeil allocation within the 72-hour post-claim window, posting a 25 ADA bond
2. Governor must wait a mandatory 24-hour defense window (enforced via real chain time) before resolving
3. Governor adjudicates the underlying N-hop evidence off-chain against real Blockfrost data, then calls `ResolveChallenge{upheld, current_timestamp}`
4. Upheld: challenger's bond returned in full, NIGHT bounty paid separately off-chain. Rejected: bond forfeited to the platform wallet.

---

*This document reflects the security state of the codebase as of 2026-07-12, after two adversarial audit passes and four hardening passes. It should still be validated by an independent, professional security audit before mainnet deployment — internal review, however thorough, is not a substitute for one.*
