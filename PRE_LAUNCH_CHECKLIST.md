# Pre-Launch Checklist — Noctis Zone

Human sign-off gate. Three stages: website live, preprod contracts, mainnet.

**Sign-off format:** `[x] Description ✅ INITIALS DATE`  
**Rule:** Don't sign off without actually doing it. "Looks fine in the code" is not a sign-off.
**Code-ready marker:** items tagged `🔧 code-ready` have the underlying code/contract already built and passing its own test suite (verified 2026-07-30) — this is NOT a sign-off and does not check the box. It just means "the work behind this item exists and is tested; what's left is the live/manual verification this checklist actually gates."

---

## Stage 1 — Website live (noctis.zone)

### DNS + hosting

- [ ] Domain `noctis.zone` pointed to production server
- [ ] SSL certificate issued and auto-renewing
- [ ] Site loads at `https://noctis.zone` with no mixed-content warnings
- [ ] WordPress admin accessible at `/wp-admin/`
- [ ] Staging environment available at a separate subdomain

---

### Public pages — desktop

- [ ] **Home page** — hero renders, stat blocks correct, CTA buttons navigate correctly, nav links work, footer links work — 🔧 code-ready (A1, shipped 2026-06-09)
- [ ] **Launches index** — card grid loads, filter tabs work (ALL/LIVE/DARKVEIL ACTIVE/UPCOMING/GRADUATED/DV FAILED), search works, tier filter works, sort works — 🔧 code-ready (A2, shipped 2026-06-09; card data still partly mock, see A9)
- [ ] **Launch detail page (Cardano Launch — e.g. /launch-phantom/)** — all sections render: header, progress bar, DV registration panel, bonding curve chart placeholder, LP info, creator info
- [ ] **DV Registration** — eligibility checklist renders, allocation display correct, NIGHT bond amount correct ($50 USD), registration form present — 🔧 code-ready (A3, shipped 2026-06-09)
- [ ] **How It Works** — all step cards render, FAQ accordion opens/closes, guides link band renders above "Choose your tier" and every link resolves — 🔧 code-ready desktop (A4)
- [ ] **How-To Guides (/how-to/)** — hero spacing clears the fixed nav, sticky quick-nav jumps to all 4 categories, every guide accordion opens/closes, all in-page links resolve
- [ ] **Staking (/staking/)** — discovery grid lists staking-enabled launches, search + status tabs + tier filter work, "My staking" gate shows until a wallet connects, then totals (projects / staked / rewards earned) and per-project rows populate and link to the right launch
- [ ] **Transparency page** — all 10 sections present, all default collapsed, expand/collapse works, wallet addresses placeholder text correct — 🔧 code-ready desktop (A5)
- [ ] **Create Launch wizard** — all 6 steps accessible, chain selector works, DEX selector has no default (forced selection), vesting slider has no default, fee display matches CLAUDE.md's current launch fee constants — 🔧 code-ready desktop (A6, every launch type wired)

---

### Public pages — mobile (iPhone + Android)

- [ ] **Home page** — logo above heading, heading centred, stat blocks below CTA buttons, nav hamburger works, wallet connect hidden from nav, footer 2-col — 🔧 code-ready (A1)
- [ ] **Launches index** — status filter dropdown works, search full-width, filter bar has side padding, no horizontal scroll — 🔧 code-ready (A2)
- [ ] **Launch detail** — body stacks vertically (sidebar below main), no overflow
- [ ] **DV Registration** — stacked layout, logo visible, form usable — 🔧 code-ready (A3)
- [ ] **How It Works** — readable on mobile, no overflow — mobile audit still pending (A7)
- [ ] **Transparency** — sections expand/collapse on mobile, no overflow — mobile audit still pending (A7)
- [ ] **Create Launch wizard** — all steps usable on mobile, form fields don't overflow — mobile audit still pending (A7)

---

### Navigation

- [ ] All nav links point to correct pages
- [ ] LAUNCH TOKEN button visible on desktop, in hamburger menu on mobile
- [ ] DarkVeil dropdown opens and shows correct sub-links
- [ ] Logo links to home page
- [ ] No 404s on any linked page

---

### Content

- [ ] Fee split figures correct on all pages (1.0% + 0.6% + 0.4% = 2.0%)
- [ ] Launch fees match CLAUDE.md's current `TIER_A/B/C_FEE_USD` constants on every page (USD-denominated, paid in ADA or NIGHT equivalent) — do not hardcode figures here, they're subject to change
- [ ] NIGHT bond amount correct ($50 USD)
- [ ] Wallet cap correct (5% per ZK identity)
- [ ] LP lock duration correct (365 days)
- [ ] No references to deprecated/removed reward mechanisms
- [ ] Launch types correctly described (Cardano Launch, Midnight Launch; Solana and XRP marked as announced, not available)

---

### Social + transparency

- [ ] Twitter/X handle registered and linked in footer
- [ ] Discord server created and linked in footer
- [ ] Transparency page placeholder wallet addresses replaced with real addresses
- [ ] `noctis.zone` links correctly from all social profiles

---

## Stage 2 — Preprod deployment (contracts)

*Tracks B (Cardano contracts) and C (Midnight PSMs) are built and internally tested (see ROADMAP.md) — this stage is about deploying to a live preprod/testnet environment, not initial construction.*

### Cardano preprod (Cardano testnet)

- [ ] Bonding Curve Contract (linear) deployed to preprod — note contract address
- [ ] Bonding Curve Cardano Launch Contract deployed to preprod — note contract address; includes `ClaimDarkVeilTokens`
- [ ] Vesting Contract deployed to preprod — note contract address
- [ ] LP Escrow Contract deployed to preprod — note contract address
- [ ] ZK Anchor Contract deployed to preprod — note contract address
- [ ] CTO Governance Contract deployed to preprod — note contract address
- [ ] N-Hop Challenge Contract (Cardano Launch) deployed to preprod — note contract address; test the 25 ADA bond, 72h post-claim window, 24h defense window with real chain time
- [ ] Staking Rewards Pool Contract (Cardano) deployed to preprod — note contract address; test staking a position, `Unstake`, and a real Merkle-proven `ClaimRewards` payout for a launch that opted in
- [ ] Staking Rewards Pool: confirm `Graduate` on both curve contracts actually seeds the pool's UTXO with `staking_reserve_tokens` in the same transaction as LP, only when `staking_enabled` — and that it's a no-op (no separate output required) when the creator declined
- [ ] LP Escrow: confirm `withdraw()` does not exist in contract ABI — 🔧 code-ready (no such redeemer exists anywhere in `lp_escrow.ak`, real invariant not a test artifact)
- [ ] LP Escrow: test `migrate()` — confirm requires lock expiry + whitelist membership, and that a whitelist change requires the full 72h `ProposeDexChange`/`ExecuteDexChange` notice window — 🔧 code-ready (covered by the Aiken test suite; live preprod re-verification still needed)
- [ ] LP Escrow: test migration atomicity — confirm `addLiquidity` failure reverts `removeLiquidity`
- [ ] ZK Anchor: write a test proof bundle, confirm it's stored and publicly readable
- [ ] CTO Governance: test quorum check (5% + 15 distinct voters), 1% per-voter cap, 30-day min holding period, 90-day post-graduation lockout, 90-day cooldown, and that a passed vote actually redirects the bonding curve's creator fee — anti-whale-takeover fix, 2026-07-28 — 🔧 code-ready (all 5 safeguards + fee redirect covered by the Aiken + Compact test suites; the thread-NFT hardening against forged reference-input attacks is also covered; live preprod re-verification still needed)

---

### Midnight preprod (Midnight testnet)

- [ ] Midnight SDK/devnet maturity — 🔧 code-ready, closed 2026-07-22 per `local/OPEN_ISSUES.md` (8 real Compact PSMs built and tested, 280/280; a real local devnet run with node-confirmed DUST measurements). What's actually still blocking this section now is live infra provisioning, not SDK maturity — the proof-server and the ZK artifact host both have deployment configs/runbooks ready but nothing provisioned yet (pure ops, not code); confirm both are live before starting this section
- [ ] Eligibility Gate PSM deployed (Cardano Launch — merged with the former DarkVeil PSM, Phase 2 2026-07-11)
- [ ] Bonding Curve PSM deployed (Midnight Launch only — merged with Eligibility Gate + DarkVeil)
- [ ] Creator Fee Escrow PSM deployed
- [ ] Vesting PSM deployed
- [ ] Treasury PSM deployed
- [ ] LP Escrow PSM deployed (Midnight Launch only — Midnight-native, currently unreachable in practice pending the Midnight Launch graduation-DEX blocker being resolved)
- [ ] CTO Governance PSM deployed
- [ ] Staking Rewards Pool PSM deployed (Midnight Launch only) — governor `publishStakeSnapshot`/`publishRewardRoot` calls, real `mintUnshieldedToken` payout to a staker on `claimRewards`; confirm the minted reward color is consistently reproducible (`tokenType(rewardDomainSep, thisContract)`) across separate calls

**DUST cost measurement:**
- [ ] DV registration tx: measure `v_fee` → record in internal tracking — 🔧 partially code-ready: `registerForDarkVeil`'s most expensive path (the 20-level Merkle-proof fold) was measured on a real devnet 2026-07-20 (`fees.paidFees = "1"` atomic unit, node-confirmed, reproduced twice) — flagged as a lower bound, not a final mainnet-representative figure; the other 3 tx types below are still unmeasured
- [ ] DV buy tx: measure `v_fee` → record
- [ ] Bonding curve buy tx: measure `v_fee` → record
- [ ] LP deposit tx: measure `v_fee` → record
- [ ] Calculate per-launch DUST budget (Cardano Launch) → record in CLAUDE.md constants
- [ ] Calculate per-launch DUST budget (Midnight Launch, if applicable) → record

---

### End-to-end Cardano Launch flow (preprod)

- [ ] Creator creates Cardano Launch launch via wizard → launch fee paid (per current `TIER_B_FEE_USD`) → launch created on-chain
- [ ] DV registration window opens → register with eligible wallet → NIGHT bond locked (Eligibility Gate PSM, Midnight)
- [ ] Registration freezes at T-2h → allocation per wallet (`baseSlot`) calculated correctly
- [ ] DarkVeil buying window opens → submit buy commitment (private, Midnight) → private state updated
- [ ] DarkVeil closes → relayer anchors `dv_allocation_root` on Cardano ZK Anchor Contract (Merkle root, not a plaintext registrant list)
- [ ] Buyer calls `ClaimDarkVeilTokens` on the Cardano Bonding Curve Cardano Launch contract → presents `(dv_amount, salt, merkle_proof)` → pays real ADA → receives tokens (this is where real Cardano Launch DarkVeil settlement actually happens, not on Midnight)
- [ ] Ratio-based NIGHT bond refund correct for a partial buyer (`claimRatioBondRefund`); ghost registrants forfeit fully, split 60/40 treasury/ops
- [ ] Regression (Critical fix, 2026-07-30, see `local/SECURITY_AUDIT.md` for detail): confirm the fix holds against real preprod behavior, not just the simulator — 🔧 code-ready (13 regression tests pass; live preprod re-verification still needed since this closes a real fund-drain exploit)
- [ ] N-hop challenge: submit a test challenge against a claimed allocation within 72h, confirm the 24h defense window and governor-adjudicated resolution both work
- [ ] Public bonding curve opens on Cardano → buy tokens → price increases correctly
- [ ] Bonding curve graduates at 100% sell-through → `Graduate` redeemer seeds LP to CSwap (preprod), verified by real value movement; if staking was enabled at launch creation, confirm the same transaction also seeds the staking pool
- [ ] LP enters escrow → 365-day lock confirmed → no withdraw() possible
- [ ] Creator fee escrow accumulating correctly (1.0% of trades) — **on the Cardano Bonding Curve Cardano Launch contract itself, not a Midnight PSM** (the Creator Fee Escrow PSM never holds a real Cardano Launch fee)
- [ ] Creator claims fee via `ClaimCreatorFees` on the Cardano curve contract → correct amount
- [ ] Vesting starts at graduation → daily release correct (`total_allocation / vest_days`), timestamp bound to real chain time

---

### End-to-end Cardano launch flow (preprod)

- [ ] Creator creates a Cardano launch → launch fee paid (per current `LAUNCH_FEE_USD`)
- [ ] Linear bonding curve active → buys increase price correctly
- [ ] 5% per-address cap enforced
- [ ] Graduation at 100% sell-through → LP seeded; if staking was enabled at launch creation, confirm the staking pool is seeded in the same transaction

---

## Stage 3 — Mainnet launch

*This stage requires completed security audit (Track E) and successful preprod sign-off (Stage 2).*

### Security audit

- [ ] Security audit report received for all Priority 1 contracts — **note:** multiple internal adversarial passes are done and documented across both Cardano and Midnight, most recently a 13-finding security review pass on 2026-07-30, with real fixes + regression tests, not just findings — see ROADMAP.md Track E1/E1b. This item is specifically about an **independent, professional** audit, which has not happened yet and internal review does not substitute for.
- [ ] All Critical and High findings resolved or accepted with documented rationale — 🔧 code-ready for every INTERNAL finding to date (all Critical/High findings across both audit tracks are fixed with regression tests, none left as accepted-risk); still pending whatever an independent audit turns up
- [ ] Formal verification complete for bonding curve integral, LP migration atomicity, ZK proof soundness — not done as a separate formal-proof exercise; covered instead by adversarial test coverage (see ROADMAP.md Track E2) — confirm this substitution is acceptable before signing off, or commission real formal verification
- [ ] Audit report published on Transparency page

---

### Final mainnet checks

- [ ] All contract addresses set in WordPress (Settings page CLI-path/contract-address fields — the site is WordPress PHP + vanilla JS, not the `constants.ts`/`lib/cardano.ts` Next.js paths CLAUDE.md's file-structure section sketches; those were never built)
- [ ] Orcfax oracle integration tested with live mainnet datums
- [ ] Blockfrost mainnet project ID set in environment
- [ ] Treasury, ops, and team wallet addresses set (public on Transparency page)
- [ ] NIGHT purchase policy confirmed: ops wallet has sufficient NIGHT for first 30 days
- [ ] DUST budget confirmed: sufficient NIGHT held to cover estimated first-30-day tx volume
- [ ] Treasury stablecoin balance above 10,000 ADA floor before first Cardano Launch launch
- [ ] Stablecoin selection confirmed as USDM (native Cardano, no bridge risk)
- [ ] Social handles registered: Twitter/X ✅, Discord ✅

---

## Final sign-off

- [ ] All Stage 1 items signed off
- [ ] All Stage 2 items signed off
- [ ] All Stage 3 items signed off
- [ ] **MJ sign-off**: ___ / ___
- [ ] **[Co-founder] sign-off**: ___ / ___

Once all sign-offs are on this line, we LAUNCH.
