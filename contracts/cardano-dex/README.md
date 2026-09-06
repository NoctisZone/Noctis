# Noctis venue contracts (Cardano)

An own trading venue for graduated Noctis launches: a constant-product pool
with a creator fee slot and a platform fee slot, so the creator's post-graduation
share is charged on every trade against the pool rather than only on trades
placed through the Noctis page.

This is a separate Aiken package from `contracts/cardano` on purpose. The launch
validators there are deployed and their blueprint is fingerprint-guarded; nothing
here changes their hashes.

## Where the code comes from

Splash's royalty pool is the base. Its datum already carries the two slots we
need (`royalty_*` for the creator, `treasury_*` for the platform), and its
royalty-withdraw validator releases only the creator's accrued balance to the
creator's key. See `NOTICE` for the exact provenance and licence terms.

| File | Origin | Status |
|---|---|---|
| `lib/splash/*.ak`, `lib/splash/royalty_pool/single_royalty_pool.ak`, `lib/splash/orders/royalty_withdraw.ak` | splash-core `validators_v3` (Aiken) | vendored unchanged; compiles on stdlib v3.1.0 |
| `validators/royalty_pool/single_royalty_withdraw_pool.ak` | splash-core `validators_v3` (Aiken) | vendored unchanged; still hardcodes Splash's withdraw-request script hash, to be parameterised before deployment |
| `validators/royalty_pool/pool.ak` | ported from `PRoyaltyPool.hs` (Plutarch) | Aiken port with tests; adds the `RedirectRoyalty` arm |

Splash ships the pool validator itself only in Plutarch (Haskell). The Aiken
package in their tree holds the withdraw path and the datum types. The port keeps
their datum layout byte for byte so the vendored withdraw validator applies to a
pool guarded by this script without modification.

## What is Noctis-specific

- **`RedirectRoyalty` (action 5).** Splash's DAO action cannot change the royalty
  key. A passed community-takeover vote must redirect the creator's fee stream,
  so this arm changes `royalty_pub_key` (and bumps the nonce) when the CTO
  governance credential's withdrawal is present in the transaction, and changes
  nothing else.
- **Parameters instead of constants.** The royalty-withdraw script hash is a
  validator parameter here; Splash compiles it in.

## Fee model

`fee_num`, `treasury_fee` and `royalty_fee` are numerators over `100_000`. The
Noctis post-graduation split maps to `royalty_fee = 1_000` (creator 1.0%),
`treasury_fee = 100` (platform 0.1%) and `fee_num = 99_700` (a 0.3% pool fee of
which the 0.1% LP share is the part left in reserves). These are per-pool datum
values set at creation, not constants of the validator.

## Not here yet

Order validator and batcher (Splash's executor is unlicensed and is not used),
the pool factory that lets only a launch's graduation transaction create a pool,
deposit and redeem order validators, and the escrow integration. The build plan
tracks these.

## Build and test

Run Aiken from a WSL-native checkout inside a pseudo-TTY (see the repository
notes on why `/mnt/c` gives false results):

```
aiken check
aiken build
```
