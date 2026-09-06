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
| `validators/royalty_pool/single_royalty_withdraw_pool.ak` | splash-core `validators_v3` (Aiken) | vendored; the request script hash is now a validator parameter |
| `validators/royalty_pool/pool.ak` | ported from `PRoyaltyPool.hs` (Plutarch) | Aiken port with tests; adds the `RedirectRoyalty` arm |
| `validators/royalty_pool/withdraw_order.ak` | ported from `PRoyaltyWithdrawOrder.hs` (Plutarch) | the creator's claim request; payout address derived from the pool's royalty key |
| `validators/royalty_pool/treasury.ak` | ours, informed by `PRoyaltyDAOV1.hs` | the platform slot: withdraw to the platform wallet, adjust the treasury fee within a band |
| `lib/noctisswap/pool_state.ak` | ours | shared datum and value readers |

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
- **Parameters instead of constants.** The royalty-withdraw script hash and the
  withdraw-request script hash are validator parameters here; Splash compiles
  them in.
- **The creator's payout address is derived, not declared.** A claim request
  carries no destination; the reward must go to the key hash of the pool's
  `royalty_pub_key`. A CTO redirect of that key moves the payout with it.
- **The platform slot has its own small script** instead of Splash's multisig
  DAO action: withdraw to the platform wallet, or move `treasury_fee` within
  `[0, max_treasury_fee]`, each bumping the nonce and touching nothing else.

## Fee model

`fee_num`, `treasury_fee` and `royalty_fee` are numerators over `100_000`. The
Noctis post-graduation split maps to `royalty_fee = 1_000` (creator 1.0%),
`treasury_fee = 100` (platform 0.1%) and `fee_num = 99_700` (a 0.3% pool fee of
which the 0.1% LP share is the part left in reserves). These are per-pool datum
values set at creation, not constants of the validator.

## Not here yet

Order validator and batcher (Splash's executor is unlicensed and is not used),
the pool factory that lets only a launch's graduation transaction create a pool,
deposit and redeem order validators, the governance-side script that grants the
redirect withdrawal on a passed vote, and the escrow integration. The build plan
tracks these.

## Build and test

Run Aiken from a WSL-native checkout inside a pseudo-TTY (see the repository
notes on why `/mnt/c` gives false results):

```
aiken check
aiken build
```
