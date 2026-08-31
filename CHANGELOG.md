# Changelog — Noctis Zone

Notable changes to the Noctis Zone, by release. Internal development history predating this file lives in a local, non-public record.

---

## [Unreleased]

### Added

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

### Changed

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
  rounded down. The validator computes both the price and the 2.0% fee split from its
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

---

## [1.0.0] - 2026-07-31

Initial public release of the consolidated Noctis Zone codebase.

- Cardano L1 contracts — bonding curve, LP escrow, CTO governance, vesting, staking, ZK anchor, N-hop challenge
- Midnight Network contracts (Midnight Launch, design-complete, build-blocked pending ecosystem dependencies) — bonding curve, eligibility gate, creator escrow, treasury, vesting, LP escrow, CTO governance, staking
- Integration layer — chain clients, ZK proof tooling, CLI submitters, browser widgets
- Full public documentation set — see [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/PSM_ARCHITECTURE.md](docs/PSM_ARCHITECTURE.md), [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md), and [ROADMAP.md](ROADMAP.md)

Going forward, entries here describe what shipped, not how it was built — see the docs above for architecture and security detail.
