# Changelog — Noctis Zone

Notable changes to the Noctis Zone, by release. Internal development history predating this file lives in a local, non-public record.

---

## [Unreleased]

### Added

- **Compacted Midnight wallet snapshots.** The sync supervisor banks a wallet's dust state with the
  generation-tree leaves that back none of its own NIGHT collapsed to their hashes, which leaves the roots
  and every spend path it can build unchanged. The compacted state is read back before it is banked and must
  give the same roots, balance and coins, or the full state is banked as before. On Preprod a dust snapshot
  went from about 6.4 MB to 163 KB and its restore from about 80 seconds to 2; a wallet restored from it
  synced and paid for five transactions. The approach is from ODATANO's NIGHTGATE (Apache-2.0).
- **Collecting the platform's venue share from the command line.** `venue-action` gains `read-collection`,
  which reports the pools a collection round would go to and why the rest wait, without a key, and
  `collect`, which runs one round signed and paid by the treasury script's authority key. The authority is
  read from the venue's applied record and declared as a required signer.
- **Reading takeover votes through the site when its indexer needs a key.** The CTO Governance page reads
  each contract from the site's public Midnight indexer when there is one a browser may call. When the
  site's indexer needs a key, as Blockfrost's does, the page now reads through the plugin's
  `np/v1/midnight/contract-state` route, which asks the indexer the same question Midnight.js asks, with
  the key held on the server, and returns the state for the page to decode as before. The route takes only
  a contract address, answers the same address from a 30-second cache, and limits each visitor's uncached
  reads.
- **Carrying a takeover vote through on Cardano from the command line.** `cto-vote-step` records a
  finalized ballot's result, posting the bond from the payer, and then takes whichever step the record waits
  for: execute, expire, pay the bond back, clear. `cto-governance-action`'s new `ballot` action prints a
  finalized proposal the way the Cardano record takes it, which is the recorder's input. For a launch minted
  before 2026-09-30, whose governance script takes a result its own way, `earlierScript` records it the way
  that script accepts and clears with the governor's signature; its tests run that script as those launches
  carry it on chain. The CLI build can stamp and write its bundles for another contracts tree
  (`NOCTIS_CLI_CONTRACTS` with `NOCTIS_CLI_OUTDIR`), for a launch still running on scripts since replaced.
- **Proving through the buyer's own wallet when it can.** The DarkVeil and governance widgets ask a
  connected Midnight wallet for its prover through the DApp connector's `getProvingProvider`, and prove
  with it when the wallet offers one, so a proof is made wherever that wallet's user chose. A wallet
  without one, or a proof its prover cannot make, goes through the platform's proof server as before. Both
  paths prove the same way, with the initial cost model, so the transaction is the same shape either way.
- **Property tests for the curve and fee arithmetic**, over generated curves and amounts: a range costs the
  same however it is split, rounding favours the curve, a round trip never profits, and the fee slices and
  the raise's share never exceed the value they divide. The Midnight contracts' getters that had no test
  now have one, each checked against the public ledger after a state change.
- **Previewing a vote to pair a frozen allocation into the pool.** Before anyone files a vote to pair a taken-over creator's tokens into the launch's pool, the proposal form shows what the ADA it names would do at the pool's price now: the tokens it buys, how many of the frozen allocation go in and how many stay in vesting, the liquidity minted into the LP escrow, and, when the ADA buys more than is frozen, the price the pool rises to. It reads the same outputs and runs the same arithmetic as the disposition itself, which now shares one function with it, and builds or signs nothing.
- **DEX votes from the browser.** A vote to move a pool's locked LP to another DEX, or to change the DEX whitelist, names the DEX by its 28-byte pool script hash. The ballot carries it in its 32-byte field the way it carries a wallet's key hash, and the relayer reads it back as the script credential the Cardano record keeps, refusing a field that does not hold one. With that, the proposal form offers every vote type.
- **Reading a launch's takeover votes without a wallet.** The governance widget reads each listed governance contract through the site's public indexer, for the CTO Governance page's list of open and recent votes. A contract that cannot be read is reported on its own and does not stop the rest.
- **Proposing a takeover vote from the browser.** The launch page's governance panel files a proposal from the holder's own wallets: a takeover, a dissolve, a release from the community treasury, or one of the three destinations for a frozen allocation. The description is stored on the site first and the proposal commits to its SHA-256; a takeover's description carries the community wallet's public key, read from the connected wallet's existing signature or typed in. The form names why a vote cannot be filed yet, and from when, by the contract's own gates. A proposer takes their bond back once the ballot drew a quorum, and a ballot nobody voted on can have its bond swept. The proposal arguments now live in `cto-proposal-args.ts`, shared by the command-line action and the browser, and a Midnight unshielded address decodes to the 32 bytes a bond refund names without a library. The governance deploy reports the bond floor and graduation time for the launch record.
- **A takeover's pool royalty key comes from the keys the site knows.** Applying a takeover, or a dissolve, installs as the pool's royalty key the public key whose blake2b-224 is the wallet the vote named: the creator's, recorded at mint, or a community wallet's, carried in its proposal's description. The connected wallet is asked to sign for it only when the site knows neither.
- **Taking back a royalty-withdraw request nobody filled.** A creator's waiting requests are listed on the Creator Dashboard, each with a button that returns its ADA to the wallet that placed it, less the network fee. It works whether or not the site is filling withdraws. The refund names the placer's key as a required signer, takes back several requests in one transaction, and never spends a reference-script output from the wallet. Its tests run the compiled request validator against what it builds.
- **Claiming curve fees from the creator dashboard.** A Cardano Launch creator claims their accrued curve fees with their own wallet, from the dashboard's Bonding curve fees card. The claim references the published curve validator, so it fits a transaction, and the site's Blockfrost proxy now relays script evaluation to price it. The whole balance comes to the wallet; a flat 5 ADA platform charge and the network fee are paid from it.
- **Adding and removing NoctisSwap liquidity.** A deposit request pays both sides of a pool at its ratio and receives LQ; a redeem request hands LQ back for a share of both sides. The batcher fills them alongside swap orders, in the order the chain accepted them, each against the pool the previous fill left, and the placer can refund a request until it fills. The planners reproduce both validators' arithmetic exactly: each side pays the least that buys the LQ, and everything else returns with the collateral.
- **Applying a community takeover to a launch's contracts.** Once a takeover, or a vote dissolving one, executes, the `cto-takeover` tool's `apply` action carries it to each contract that holds something of the creator's: the curve's unclaimed fees, the LP escrow's migration authority and harvest recipient, the token metadata's signer, the vesting schedule, and the pool's royalty key through the venue's redirect. Each is its own transaction, and a run applies only what the governance record's current state has not reached. Its tests run the compiled validators against every transaction it builds.
- **Carrying a finished takeover vote through on Cardano, from any wallet.** A new module reads where a launch's governance record stands and plans each step the vote's proposer, or any holder, takes from their own wallet: recording the ballot's result with the relayer bond, executing a passed result once its challenge window has passed or marking an unexecuted one expired, reclaiming the bond to the key that posted it, and clearing the settled result. Each step refuses in words what the governance script would refuse, and its tests run the compiled script against a ballot at real-world scale. The launch page's takeover-vote panel builds them in the browser from the holder's own wallet, in a bundle it loads only when they are opened, and can also close a ballot on Midnight and carry a passed one out there.
- **A market read for each venue pool.** Its trades at the price they realised, the queue of resting swap orders and liquidity requests, its liquidity providers and its token's largest holders, read incrementally from the newest trade a caller already holds.

### Changed

- **The venue contracts have their own repository.** NoctisSwap's Aiken package, with its full history,
  now lives in `NoctisZone/NoctisSwap` and changes there. This repository keeps a byte-identical copy at
  `contracts/cardano-dex`, pinned to a NoctisSwap commit in `contracts/cardano-dex.pin.json`, and CI fails
  if the two differ. Nothing that builds, deploys or reads the venue moved: the path, the blueprint and the
  applied parameters are the same bytes.
- **Every Midnight tool can name its indexer.** The wallet sync, the DUST registration and the launch
  conductor take the relay and indexer addresses from their input, as the other Midnight tools already did,
  and the conductor hands them to each action it starts. A wallet's sync position is numbered by the indexer
  that served it, so a wallet resumed through another provider has to reach the same one. Unnamed, each
  keeps its network's default.
- **A DarkVeil claim from the browser names the published curve script.** A buyer's connected wallet now
  funds, signs and submits the claim Mesh builds against the curve validator's published reference, as the
  creator's fee claim does, so the claim fits a transaction. It lives in its own widget bundle, which the
  claim page loads when a buyer presses Claim; the DarkVeil widget carries no Mesh. A test runs the compiled
  curve validator against a claim built this way, from a CIP-30 wallet, with a real allocation tree.
- **The shared modules every Cardano launch uses carry neutral names.** `launch-schemas.ts`,
  `launch-mint-submitter.ts`, `genesis-datums.ts`, `trade-history-reader.ts`, `vesting-claims-submitter.ts`,
  `vesting-start-submitter.ts`, `dex-change-submitter.ts` and `lp-migration-submitter.ts` replace the names
  they carried from the retired linear curve, and their classes follow. The CLI entry points keep their
  names, since a deployed CLI is found by its file name.
- **Every widget bundle builds from source again.** The royalty-withdraw request's datum and signed-payload
  shapes moved to `venue-royalty-shapes.ts`, which carries no Mesh, so the NoctisSwap panel reads requests
  without it.
- **The genesis datum builder reads no clock of its own.** The mint's time comes from its caller, which
  reads the clock once at the command-line boundary, and a build without one is refused rather than
  stamped with zero.
- **A curve sell pays its own fee.** A sell gives back the share of its range's value that the curve's raise holds, 98.5% or what a buy of that range banked, and its 1.5% fee comes out of that share. The seller receives about 97% of the range's curve value, and selling can never draw down what graduation seeds the pool with, so the pool opens at no less than the price the LP reserve was sized for. A round trip costs 1.5% on each leg. The batch planner quotes sells the same way. This moves the curve's script hash.
- **A vote on what becomes of a taken-over creator's tokens.** After a takeover freezes a creator's allocation, a second vote, no sooner than the ballot cooldown allows, sends all of it to one destination:
  - into the launch's pool, paired with ADA the community wallet supplies at the pool's own ratio, with the LP escrow's lock restarting;
  - into the launch's staking pool at its own rate, opening a pool with the runway the vote names if the launch has none;
  - or kept in vesting until the original schedule ends, after which only passed community votes release it.

  The decision is final: a later vote to dissolve the takeover does not return the tokens. This moves the governance, vesting and LP escrow scripts' hashes, and those of the three scripts that read the governance record.

  The ballot takes the three types, the vote relayer anchors them, and the `cto-takeover` tool's `dispose` action carries out whichever destination the second vote chose. Its tests run the compiled validators against every transaction it builds.
- **A takeover vote's window reaches Cardano in milliseconds.** The relayer carries a Midnight ballot's start and end across in the unit the governance record compares with a launch's graduation time and the ballot cooldown, and a launch records its ballot width in that unit at mint.
- **A takeover vote's cooldown starts when its result settles.** The 90 days before a launch's next ballot count from the end of the last one whose result was executed, or expired unexecuted, whatever its outcome. Any holder may clear a settled result from the governance record, once its relayer bond is paid out, so the next result can be recorded without waiting on the platform. This moves the governance script's hash.
- **Creator vesting is a cliff.** A creator's allocation releases nothing until its whole vesting period has run from graduation, then all of it at once. A community takeover passed at any point in the period finds the whole allocation still in the contract. Launches minted before the change keep the schedule their own validator enforces. This moves the vesting script's hash.
- **Each filled curve order is paid in one output**: what it bought or sold, with what came back, together. The buyer's own change pays that output's minimum ADA, where the batcher used to add it from its own wallet on every buy, and each fill costs one output fewer. The batcher's cut from an order never reaches the reserve an order holds above its maximum spend.
- **A creator-fee or platform-fee claim too small for the ledger is refused before it is built**, with the amount that would be enough, instead of being signed and then refused by the network.
- **A launch's logo can be updated on its own, from an IPFS URI or an https one.** The metadata tool reads the launch's current metadata and replaces only the logo, and a platform without an IPFS pinning service can point the token at the image it hosts. The tool now finds a Cardano Launch's curve by its own role and datum.
- **A staking pool read says when its rewards are quoted**, so a page can count each position's rewards up at the pool's rate between reads.
- **The eligibility gate's refusal of an allowlist update names the rule**: the allowlist changes only while registration is open.
- **A venue round skips the outputs the last round spent while the index still lists them**, instead of building on them and having the fill refused. Each round reports what it spent, and the next declines those orders, and orders whose pool output is among them, until the index catches up.

- **The pool a graduation opens is priced at 1.2× the graduation price on every launch.** The LP reserve is sized at mint from the ADA the curve will raise, net of fees and with the DarkVeil reserve at its flat price, so the opening price no longer depends on the creator share or the staking pool. It was a fixed 20% of supply, which opened a staking launch's pool below its graduation price. No validator changed, and launches already minted keep their datums. The wizard's supply bar and review show the sized reserve.
- A batch of curve orders that does not fit in one transaction is re-planned at half the size and tried again, down to a single order, so a batcher tick fills what fits instead of failing while orders rest.
- A venue buy order carries at least the ledger's minimum ADA for the token output that settles it, sized from the placer's address and the token, so its fill is accepted at submission.
- A failed venue fill reports the reason it failed, whatever was thrown.
- The trading, curve-order and staking browser widgets announce when they are ready, so the page scripts that use them start whenever their bundle finishes loading.

- **A launch step whose receipt was lost is confirmed from the chain rather than
  repeated or abandoned.** The node reports a transaction in a block before its
  reply is decoded, so a reply that cannot be decoded describes a transaction
  that landed. Every tool that drives a launch now reads the chain before
  deciding what a failed step means, records a step the chain shows as done,
  and submits again only what is still owed, a bounded number of times.
- **Every Midnight-side step waits out an indexer outage instead of failing on
  it.** The indexer is probed before a step starts and again after any failure,
  and a step is retried only for a failure that is known to pass, never without
  asking the chain first. An indexer that is back but behind the chain is
  waited for as well, so nothing is built against a state the chain has left.
- **A command-line tool's result is read past anything logged ahead of it**,
  and every tool that opens a wallet keeps its standard output for the result
  alone, so a completed step can no longer be reported as one that produced no
  result.
- **A launch's phase changes are now driven by one decision, taken from the
  chain and the launch's own published schedule.** What is due is worked out
  from a reading of the contract and the clock, so two runs cannot disagree
  about it and a run that stops leaves nothing to reconcile — the next one
  works it out again from the chain. Each turn does at most one thing, because
  each step changes what the next reading says.
- **Acting on a launch requires a rehearsal of that step first.** A rehearsal
  performs the reading and the decision for real and stops before submitting,
  and it is matched to the launch and the step it was taken for, so a rehearsal
  of one step never clears another. A rehearsal may be taken against a clock
  that has not arrived yet, which is how a window is checked before it opens;
  acting always uses the real one.
- **A launch that has run out of time is always owed its refund first.** The
  deadline after which every bond returns outranks every other step in the
  phase, including closing a settlement record that has been reported complete.
- **The settlement record is closed only when the chain agrees it is
  complete.** Every buyer the contract shows as having revealed must appear in
  the account of what settled, and every settlement in that account must
  already be on the chain at the figure it names. Where completeness is
  unknown, the record stays open — a record closed early would show a buyer as
  having settled nothing.
- **Publishing the set of registrants is refused unless it covers the set the
  contract holds.** Publishing is what freezes who is in the phase, so a set
  built before registration finished would freeze the wrong one permanently.
- **Every deployment now states who holds the key behind each identity it
  fixes.** Where the platform holds one, it is re-derived and checked against
  the value being fixed, so the claim is demonstrated rather than asserted;
  where a separate party holds one, that is recorded as something this cannot
  check. Two arrangements that look correct are refused: an attestor key that
  is really the governor's under another name, and two attestor slots holding
  one key, which would leave a threshold that counts a party twice.
- **A launch can record the creator's own private-phase identity**, which is
  what lets the contract refuse a registration from the person who created the
  launch. It is produced in the creator's own browser, submitted with a
  signature tied to that launch and that identity together, and can be
  corrected until the contract is deployed and not after.
- **The three approvers a private phase is sealed with are real, separately
  generated keys the platform holds.** Two of them must agree before a launch
  will accept a list of who may register. They are drawn as a set and the set is
  refused outright if two came out alike or if one is the governor's own key,
  because either would leave a threshold that one holder satisfies alone;
  nothing is stored until all three pass. What is held can be inspected — each
  slot, whether the three differ, and whether any is the governor's — without
  revealing any of them.
- **Creating a launch now asks for it**, as the last step after the token is
  minted and the launch page exists — which is also the first point at which
  there is a launch for the identity to belong to. It takes two wallet
  approvals, one to produce the identity and one to show the wallet asking is
  the launch's own creator, and the step says which is which. Declining, or a
  browser that cannot complete it, costs nothing: the token and the launch page
  are already made, and the identity can be supplied later.


- A Midnight Launch's DarkVeil phase now runs on the same sealed schedule a
  Cardano Launch does. Registration opening, the buying window opening and the
  DarkVeil close are each driven by a deadline fixed at deploy, before anyone
  bonds, so any wallet may submit the transaction that moves the launch to its
  own advertised window. None of them takes a timestamp from its caller.
- Publishing the registrant set and opening the buying window are separate
  actions here too: the root is published by the party that can compute it, and
  the window opens on the clock afterwards.
- Closing accepts exactly one per-registrant allocation, the largest whole
  number of tokens that divides among the registrants within the DarkVeil
  allocation, so the figure is determined by public ledger state. The Fair
  Launch Certificate records the scheduled close, which is the same value
  whoever submits the closing transaction and whenever they get to it.

- The DarkVeil claim window on a Cardano Launch now opens on its own terms
  rather than on a signature. Everything that transaction relies on — the
  allocation root, the nullifier map it is claimed against, and the launch's own
  declared claim and settlement windows — is public and fixed before it can run,
  so any wallet may submit it. It reads real chain time against a validity range
  the validator bounds, and starting the window is held to moving none of the
  curve's value, which is the pairing every permissionless action on this
  contract makes.
- The nullifier map that records which allocations have been claimed is now
  sized in the same transaction that anchors the allocation root, which is the
  one place the registrant set is known. It is held to one bit per allocation
  leaf, to a ceiling that keeps it inside the transaction budget every claim
  shares with its own Merkle proof, and to starting with every bit clear. A
  launch with no DarkVeil phase carries no map at all.
- Cancelling a Cardano Launch curve now stops at the DarkVeil claim window, the
  same state the permissionless expiry already refuses, so a registrant holding
  an allocation they can still settle keeps the chance to settle it. That window
  ends on the clock without anyone's permission, and a launch can be cancelled
  once it has.
- The Cardano Launch curve is published as a reference script and named by every
  spend. It serialises whole into one publishing transaction with room to spare,
  and because the script is public, a wallet that finds no published copy can
  publish one and then act — which is what keeps the permissionless paths open
  to anyone.

- A Cardano Launch's DarkVeil phase now runs on a schedule sealed at deploy
  rather than on a signature. Registration opening, the buying window opening,
  and the DarkVeil close are each driven by a deadline fixed before anyone
  bonds, so a launch reaches its own advertised window on time and any wallet
  may submit the transaction that moves it. Each of these reads real chain time
  against the sealed deadline and takes no timestamp from its caller, so there
  is no value for a caller to name. The Fair Launch Certificate records the
  scheduled close for the same reason.
- Closing DarkVeil accepts exactly one per-registrant allocation: the largest
  whole number of tokens that divides among the registrants within the DarkVeil
  allocation. Two bounds admit one integer, so the figure is determined by
  public ledger state and any other value is refused.
- Publishing the registrant set and opening the buying window are now separate
  actions. The platform publishes the root, because computing it needs the
  registrant set; the window then opens on the clock. This mirrors how the
  allowlist root is already published before it takes effect.
- **A DarkVeil launch now publishes its whole schedule, and anyone can read it
  off the chain.** The times a launch runs to were already fixed before anyone
  could bond and could not be moved afterwards. They are now also readable by
  anybody, so a registrant can check the dates they were shown against the
  contract itself rather than taking the site's word for them. The same is true
  of the participant floor and of the deadline after which a stalled launch
  returns every bond — the terms are public, in the place they are enforced.
- Every step of a DarkVeil launch either refuses a repeat outright or does
  nothing the second time, whichever is right for that step. Recording a
  settlement twice cannot inflate the figures the Fair Launch Certificate is
  sealed from, and a corrected figure replaces the old one rather than being
  added to it. One party approving an allowlist root repeatedly still counts
  once, so a threshold means what it says.
- A launch cannot be deployed with role identities nobody holds. Where the
  allowlist attestors and the creator were once allowed to be placeholders
  derived from a single secret, a real deployment now refuses them — a
  threshold assembled from one secret is satisfied by one person, and these
  values are fixed at deployment and cannot be corrected afterwards.

### Added

- **A launch's private-phase contract is prepared from the launch's own
  record.** The schedule the launch page shows, the launch id its mint
  produced and the identity its creator bound are read from the record when
  the contract's inputs are assembled, so the contract enforces the schedule
  the site displays rather than one typed from a calendar. A record whose
  steps are out of order, or that has no creator identity yet, is refused
  before anything is spent; a compressed rehearsal schedule is accepted and
  named as one.
- The ZK Fair Launch Certificate is issued when the DarkVeil settlement record
  closes, which is the first moment every figure in it is final, and it can be
  issued only once. Until then its hash is empty, which is how a reader tells an
  unissued certificate from one that certifies nothing. The relayer refuses to
  assemble and anchor a bundle from a certificate that has not been issued.
- The certificate publishes what a launch actually settled — the tokens that
  really moved and the amount really raised at the DarkVeil price — rather than
  what buyers stated they intended during the private phase. Both sets of totals
  remain in public state, so the two can be compared by anyone.

- Anyone can now prove that a published DarkVeil registrant tree contains a key
  that never registered, and doing so fails the phase and returns every bond in
  full. The proof is the whole authorization: it needs a real Merkle path into
  the published root for a key that holds no bond, and neither half can be
  fabricated, so the check cannot be used against a healthy launch. This is the
  counterpart to the existing path for a registrant the tree leaves out, so the
  tree can now be held to the registrations in both directions.
- A published allowlist root names the evidence it was built from. The
  attestors approve the root and a commitment to that evidence together, so a
  threshold cannot be assembled from parties who agreed on the root while
  disagreeing about the facts behind it, and a root published this way can be
  recomputed and contradicted by anyone holding the evidence.

- A DarkVeil settlement can be closed only once it reflects a claim window that
  really ran: where buyers revealed purchases during the private phase, at least
  one of them must have settled. A launch in which nobody revealed anything is
  unaffected and still closes normally. Where the check does apply, the launch
  reaches the refund path instead, which returns every bond in full.

- A DarkVeil that closes and whose settlement record is not closed within its
  sealed deadline can be ended by anyone, returning every NIGHT bond in full
  through the existing refund. A bond's route home therefore never depends on a
  single party continuing to act.
- The ratio-based bond refund waits for the settlement record to be closed
  before reading it, so a refund is computed only against a complete record.
  This matches the two other circuits that already read that record.

### Fixed

- **Adding to a stake that has earned pays the 5 ADA charge**, as a claim or an exit does, so the transaction is accepted. The staking pool takes the charge whenever rewards are compounded, and the stake builder now includes it.
- A server-side Midnight wallet now only banks a checkpoint of a sub-wallet
  that was standing still while the checkpoint was taken. A checkpoint records
  two things that have to describe the same moment, and taking one while the
  wallet was mid-catch-up could capture them a fraction apart — after which the
  restored wallet could never move forward again, while continuing to look
  healthy until it was asked to pay a fee. A checkpoint is now declined unless
  the wallet's position is unchanged across it, and a restored wallet has to be
  seen advancing before it is trusted.
- Every checkpoint a round declines is reported with the reason. The previous
  silence covered exactly the case that mattered.

### Removed

- The linear curve's remaining off-chain code: its transaction submitter, datum schema and redeemer table,
  and the branches that still decoded it in the batcher, the trade-history reader, the genesis builder and
  the allocation planner. The claim and start-vesting submitters keep only their halves on the shared
  vesting validator.
- A registration nonce nothing read any more, from the Midnight Launch contract's witnesses and the
  browser's derived private state.
- The linear-curve launch path's two browser widgets: the live-curve buy widget
  and the post-graduation creator dashboard. The path is retired: no launch is
  created or shown on it, and its validator leaves the build with the next
  validator release.

### Added

- A new Aiken package, `contracts/cardano-dex`, for an own trading venue for
  graduated launches: a constant-product pool whose datum carries a creator fee
  slot and a platform fee slot, so the creator's post-graduation share is charged
  on every trade against the pool. The pool validator is ported from Splash's
  royalty pool (CC0-1.0; provenance in the package's NOTICE) and keeps Splash's
  datum layout, so their royalty-withdraw validator, vendored unchanged, applies
  as is. One arm is new: a passed community-takeover vote can redirect the
  creator's fee key, which Splash's own governance action does not allow. A
  separate package; the venue's own scripts change no deployed validator's hash.
  The package also carries the creator's claim request, a platform treasury
  script, the governance-side redirect script, deposit, redeem and swap requests,
  and the pool factory: one minting policy that creates a launch's pool NFT and
  LQ token only in that launch's graduation transaction, on the authority of the
  launch's own LP escrow.
- A browser widget for CTO governance. A holder's Cardano wallet derives their
  launch-scoped voting identity and proves control of the address the snapshot
  names; a Midnight wallet pays for and submits the vote. Registration accepts
  only a server answer that derives the identity this wallet holds, a fetched
  snapshot leaf is re-verified against the published root before it is used, and
  the page can tell whether this identity has already voted from the public
  nullifier set alone.
- One client-side implementation of the wallet-control handshake the platform's
  private endpoints require, usable from a raw CIP-30 wallet API or a built
  connection, with the same action-scoped binding the server verifies.
- Midnight wallets can be replayed to a spendable DUST balance across process
  restarts. Each sub-wallet's sync state is snapshotted every 30 seconds while the
  replay is still running, encrypted with AES-256-GCM under a PBKDF2-derived key,
  and written by temporary file and rename so an interrupted write leaves either
  the previous complete snapshot or the new one. A snapshot is restored only when
  the SDK version, network and seed fingerprint all match what wrote it; anything
  else replays from chain, as does a snapshot that cannot be decrypted or parsed.
- A supervising CLI replays wallets one at a time, giving each attempt its own
  process and a fresh heap to continue in, so progress accumulates across
  attempts. Each attempt reports the index it reached, which is what makes the
  run's own convergence readable.
- Registering a wallet's NIGHT for DUST generation reads its registration state
  from the chain, so re-running it reports that there is nothing to do instead of
  submitting again.
- A price feed over a venue pool's own history: every trade with the side it was
  taken from, the rate it realised, and the reserves it left. Rates stay exact
  rationals end to end and are compared by cross-multiplication, because the
  validator the pool is priced by compares integers — two prices a float cannot
  tell apart are still two prices, and on a token worth a fraction of a lovelace
  that is most of them. Bars bucket by wall time aligned to the epoch, leave an
  empty bucket out rather than carrying the last price forward, and keep each
  side's volume in its own total. The feed also says whether the walk behind it
  reached the pool's opening, so a truncated read is never charted as a complete
  history.
- A monitor over the batcher's rounds, which alerts on one outcome and counts the
  rest. A resting limit order and a declined one are the venue working; only an
  attempted fill that did not happen pages. Liveness is measured on rounds rather
  than on fills, so a market with nothing to fill stays quiet and a batcher that
  has stopped does not. A round that threw before reading the chain is counted
  apart from a round with failures in it — the first says nothing about the venue
  — and pools read are tracked against the most ever seen, so a read returning
  fewer of them is visible as a drop rather than as a quiet day.

### Changed

- A launch names the token its DarkVeil bond is posted in. The bond amount was
  always set per launch; the asset is now set with it, sealed at deploy and read
  by every path that moves a bond — the registration that takes it, both refund
  routes, the forfeiture sweep and the disputed-bond claim. A launch that wants
  the bond in the native token says so by omission, and behaves as it did. On a
  Midnight Launch the bond and the curve are separately denominated: the colour
  governs the bond alone, and every trade, fee and liquidity payment stays
  native, because that launch prices its curve in the native token.

- Registration eligibility weighs the asset the bond is actually posted in,
  rather than naming one. Where a whole unit of that asset is a dollar, the
  threshold is a multiplication and no price source is read, so the figure a
  deploy seals and the figure a registration pays are the same figure.

- A Cardano Launch graduates onto the venue. The curve's `Graduate` seeds the
  output that carries the launch's pool NFT, minted by the venue's factory
  policy in the same transaction, with the whole raise and the LP reserve; the
  LP escrow seals holding the pool's LQ token as its position, named in its
  genesis datum; the curve datum names the factory policy. Three validator
  hashes change (the Cardano Launch curve, the LP escrow and vesting) and ship
  with the next validator release. The genesis builder takes the factory
  policy id as a required input.
- The LP escrow and vesting validators look the governance record's thread NFT
  up under its role-tagged name, as the record carries it.
- A launch cannot be minted with no token side for its pool. The LP reserve
  percentage is now bounded where the vesting window, the creator allocation and
  the LP lock duration are already bounded, and the derived token figure is
  checked as well as the percentage — a valid percentage still floors to nothing
  on a small enough supply, and the figure the genesis datum carries is the
  derived one. Graduation compares the pool's token balance against that field,
  so at zero the comparison is satisfied by absence.
- The creator's post-graduation stream is called the pool royalty. It is charged
  at the launch's NoctisSwap pool into a royalty slot in the pool's own datum,
  keyed to the creator and paid to the key hash that slot produces, so the
  destination is derived from the pool rather than declared by a claim. The
  escrow's `HarvestFees` is the third-party-DEX path, for a position that has
  migrated after the lock, and is documented as that.
- The graduation CLI takes the creator's royalty public key from the launch
  record rather than from whoever runs it. The record's copy is captured and
  hash-checked when the launch is created, so a key that cannot be matched to the
  launch's own creator is refused on the day it is offered.
- The compiled-artifact guard records one fingerprint per compiled Compact contract, and each
  CLI is held to the artifacts of the contract it proves against. A build that carries no
  artifacts for a contract says so rather than proving against whatever it is pointed at.
- The Midnight packages resolve to exactly one copy of each. The wasm-bearing ones
  carry their own object identity, so a second copy of the same package makes objects
  minted by one unrecognisable to the other. `onchain-runtime-v3` is now named in the
  root overrides and the ledger package is pinned to a single exact version rather than
  a range, matching what the protocol package itself pins, so a fresh install resolves
  one copy of each without relying on the lockfile to hold it there.

- A public trade reaches a Cardano Launch curve as an order, applied against it in a
  batch, and the curve settles nothing else: it refuses a direct spend whatever shape it
  arrives in. A batch is built against one curve output, so a direct spend consumed that
  output out from under the batch being assembled and destroyed it. Selling is unaffected
  as a capability — a sell is an order like a buy, priced in the same batch. Claiming a
  DarkVeil allocation and claiming a buyback are separate paths and are unchanged.
- A forfeited challenge bond is paid whole to a single address named in the challenge's
  own datum, rather than divided between two. Which address that is stays a value written
  at launch creation, so it can be a dedicated one without changing a contract.
- A batch is applied to a bonding curve only by a key the curve's own datum names,
  alongside that key's real signature on the transaction. The set of keys is written at
  genesis and rewritten afterwards by a governor-signed action that moves no funds and
  is capped in length, so batchers can be added or rotated without moving the launch's
  address. An empty set means no batch can be applied; an order still stands and stays
  spendable by its own owner, with no batcher and no deadline involved.
- Bonding curve trades on both Cardano curves are priced by summing the price of each
  token a trade moves through, so a trade costs the same whether it is made in one
  transaction or several. A buyer pays the range rounded up and a seller receives it
  rounded down. The validator computes both the price and the 1.5% fee split from its
  own state, so a trade names only an amount and a wallet.
- Any token amount can be traded. Fee slices floor independently and the remainder
  stays with the curve.
- Trade prices shown in the UI and the price chart are recomputed from the curve state
  each trade executed against, and are reported as an average per token — a large buy
  spans a range of prices rather than executing at one.
- Both bonding curve validators locate their own input and continuing output through
  one shared pair of helpers instead of repeating the lookup at each call site. The
  two helpers differ by intent: one requires a continuing output, and one returns an
  option for the checks that must distinguish "no continuing output" from "the wrong
  one" and reject the first cleanly. Both curves are smaller as a result and each fits
  in a single published reference script.

### Security

Guarantees the Cardano launch validators now make, each pinned by a test that
fails when its check is removed:

- A community-takeover result anchored on Cardano is bound to the payee and
  the amount the ballot named. The anchored reference covers both fields, an
  allocation must name a positive amount and a recipient, and the off-chain
  derivation moved in step, held to a pinned cross-language vector.
- Activating a curve and starting a vesting schedule are pure state
  transitions: every asset stays exactly where it was. A fee claim from a
  curve takes the fee and nothing else.
- A trade batch settles each order exactly once, and only an order the
  transaction itself spends.
- A migrated liquidity position must come back as a token under a policy
  other than the escrow's own thread token, and the escrow keeps its ada
  across the move.
- A staking pool is funded only by its launch's graduation; once its budget
  is spent, only the creator or the governor may refill it. A stake that
  compounds accrued rewards pays the same charge a claim does. Closing a pool
  delivers its whole remaining value, dust included, to the creator.
- The metadata validator recognises a launch's curve by the role its thread
  token actually carries.
- Every deadline is measured against the earliest moment the transaction can
  be valid, so no deadline arm executes before the deadline has passed.
- An order is filled only by a batch of its own launch's curve that names it.
  A sell fill is measured net of the order's own deposit, and cancelling an
  expired sell returns its ada as well as its tokens.
- A challenge posts the platform's bond on chain and names a governor the
  launch's own governance record confirms. A sybil challenge commits to the
  challenged identity and reveals it only when the challenge is upheld.
- An emergency freeze of a community wallet is honoured by every path that
  pays or empowers that wallet.
- The certificate anchor keeps its whole value, not only its ada, across
  every key-holder action.
- The venue factory refuses to open a pool with no liquidity-token supply.
### Fixed

- A trading wallet no longer spends the output it set aside as collateral. A
  script spend requires collateral and collateral must be pure ada, so the
  smallest such output is the one set aside — and the same one ordinary coin
  selection reached for first. Collateral survives a successful spend but an
  input does not, so the trade went through and left the wallet without the
  pure-ada output its next trade needed. Selection now holds that output back,
  and a transaction that could only balance by consuming it is refused.
- The DarkVeil claim-record fetch carries the wallet-control proof the server
  requires; the widget signs the challenge through the wallet it is given.
- A launch that opted into a staking pool now graduates. The pool takes its own
  clock from the graduation transaction's validity range, while the curve only
  requires that the same timestamp fall inside that range, so one value satisfies
  both contracts and the seeding transaction now carries it. The pool is funded in
  the same transaction that seeds the LP, on terms the curve derives for itself
  field by field.
- A graduation is signed by the wallet paying for it and by nobody else unless the
  transaction declares that it needs another signature. Funding a staking pool
  needs no one's approval, so graduation no longer gathers a signature it never
  had to have, and the fee it carries matches the transaction it pays for.
- Staking a position works against a live pool. Every timestamp a staking spend
  writes is taken from the validity range the validator reads, rather than from the
  builder's own clock, so the pool state a spend proposes is the one the contract
  derives. A spend's range also opens behind the clock, because a node validates
  against the chain tip's slot rather than wall-clock time, and it never opens
  earlier than the pool's own last update.
- The staking pool's position history is replayed from the time each spend was
  validated at, which is what the contract itself used. Positions therefore rebuild
  onto the root the pool actually carries, and the proofs built from them are
  accepted. Reading a pool still re-derives that root and refuses to go on when it
  disagrees.
- A staking position is quoted at the instant a claim would settle it. Reading a
  pool advances it to the same validity-range bound a claim uses, rather than to
  the reader's own clock, so the amount shown is the amount a claim pays out. That
  bound opens behind the clock so a claim is already valid against the chain tip,
  and emission is whole units, so the two readings differed by a visible amount
  rather than a rounding step.

---

## [1.0.0] - 2026-07-31

Initial public release of the consolidated Noctis Zone codebase.

- Cardano L1 contracts — bonding curve, LP escrow, CTO governance, vesting, staking, ZK anchor, N-hop challenge
- Midnight Network contracts (Midnight Launch, design-complete, build-blocked pending ecosystem dependencies) — bonding curve, eligibility gate, creator escrow, treasury, vesting, LP escrow, CTO governance, staking
- Integration layer — chain clients, ZK proof tooling, CLI submitters, browser widgets
- Full public documentation set — see [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/PSM_ARCHITECTURE.md](docs/PSM_ARCHITECTURE.md), [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md), and [ROADMAP.md](ROADMAP.md)

Going forward, entries here describe what shipped, not how it was built — see the docs above for architecture and security detail.
