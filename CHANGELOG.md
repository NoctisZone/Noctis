# Changelog — Noctis Zone

Notable changes to the Noctis Zone, by release. Internal development history predating this file lives in a local, non-public record.

---

## [Unreleased]

### Removed

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

### Fixed

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

---

## [1.0.0] - 2026-07-31

Initial public release of the consolidated Noctis Zone codebase.

- Cardano L1 contracts — bonding curve, LP escrow, CTO governance, vesting, staking, ZK anchor, N-hop challenge
- Midnight Network contracts (Midnight Launch, design-complete, build-blocked pending ecosystem dependencies) — bonding curve, eligibility gate, creator escrow, treasury, vesting, LP escrow, CTO governance, staking
- Integration layer — chain clients, ZK proof tooling, CLI submitters, browser widgets
- Full public documentation set — see [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/PSM_ARCHITECTURE.md](docs/PSM_ARCHITECTURE.md), [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md), and [ROADMAP.md](ROADMAP.md)

Going forward, entries here describe what shipped, not how it was built — see the docs above for architecture and security detail.
