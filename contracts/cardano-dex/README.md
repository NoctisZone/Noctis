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
| `validators/royalty_pool/deposit_order.ak` | ported from `PRoyaltyDeposit.hs` (Plutarch) | a request to add liquidity; the placer's side of a deposit |
| `validators/royalty_pool/redeem_order.ak` | ported from `PRoyaltyRedeem.hs` (Plutarch) | a request to remove liquidity; the placer's side of a redeem |
| `lib/noctisswap/orders.ak` | ours, layouts after Splash's `DepositConfig`/`RedeemConfig` | the order action and request types, and the reward-address rule |
| `validators/royalty_pool/swap_order.ak` | ours, informed by `PSwap.hs` (Plutarch) and `limit_order.ak` (Aiken) | a swap request: price floor, partial fills, pro-rata executor fee, permitted executors, and a no-skim rule |
| `validators/royalty_pool/pool_mint.ak` | ours | the pool factory as the LQ minting policy: a pool is created only in a launch's graduation transaction, and its opening shape is checked at the mint |
| `validators/royalty_pool/redirect.ak` | ours | the governance side of a royalty redirect: grants the pool's redirect withdrawal only against the launch's own CTO governance record |
| `lib/noctisswap/pool_state.ak` | ours | shared datum and value readers |
| `lib/noctisswap/launch_records.ak` | ours | field-for-field mirrors of the launch package's governance and escrow records, and the thread NFT naming |

Splash ships the pool validator itself only in Plutarch (Haskell). The Aiken
package in their tree holds the withdraw path and the datum types. The port keeps
their datum layout byte for byte so the vendored withdraw validator applies to a
pool guarded by this script without modification.

## What is Noctis-specific

- **`RedirectRoyalty` (action 5).** Splash's DAO action cannot change the royalty
  key. A passed community-takeover vote must redirect the creator's fee stream,
  so this arm changes `royalty_pub_key` (and bumps the nonce) when the redirect
  script's withdrawal is present in the transaction, and changes nothing else.
- **The redirect script decides whether and where.** It reads the launch's CTO
  governance record as a reference input: a takeover needs the record in the
  triggered state and the new key hashing to the community wallet it names; a
  dissolve needs the dissolved state and the new key hashing to the creator's
  fee-recipient key as the LP escrow records it. The pool is the input at the
  pool validator's address that holds the NFT its datum names, and that name
  carries the launch id; the governance and escrow records carry their own
  NFTs under the platform's thread NFT policy. One pool per redirect
  transaction: exactly one input at the pool script.
- **Parameters instead of constants.** The royalty-withdraw script hash and the
  withdraw-request script hash are validator parameters here; Splash compiles
  them in.
- **The creator's payout address is derived, not declared.** A claim request
  carries no destination; the reward must go to the key hash of the pool's
  `royalty_pub_key`. A CTO redirect of that key moves the payout with it.
- **The platform slot has its own small script** that acts on one real pool:
  the input it names must sit at the pool validator's address and hold the NFT
  its datum names, and exactly one input sits there. The pool's own DAO arm
  keeps its shape independently — liquidity untouched, only the treasury
  counters and the treasury fee free to move, neither counter below zero, and
  whatever leaves matched to a counter — instead of Splash's multisig
  DAO action: withdraw to the platform wallet, or move `treasury_fee` within
  `[0, max_treasury_fee]` and below what the pool's own schedule can carry,
  touching nothing else. Neither action moves the pool nonce: that is replay
  protection for the creator's signed royalty claim, and moving it would cancel
  a claim the creator had already signed. The redirect arm still bumps it, and
  must — a replaced key's old signatures have to die with it.
- **The factory is one minting policy.** Splash mints LQ under policies served
  from its own infrastructure. Here one policy mints the pool NFT and the LQ
  token together, named with the pool and LQ role tags and the launch id, and
  its authority is the launch's own LP escrow: the escrow's thread NFT is
  minted once at genesis and the escrow leaves its unsealed state only once.
  Graduation therefore stays permissionless, as the curve's own graduation is,
  and no platform signature can withhold a pool. At the mint it checks the
  whole opening shape: the pool output at the pool script, the platform fee
  schedule and empty counters in the datum, the treasury and redirect scripts
  as the two DAO entries, a
  royalty key that hashes to the creator's fee recipient as the LP escrow
  records it, and the escrow sealed in the same transaction holding the entire
  opening position. The lock holds the LP position from the pool's first
  block.
- **One order per pool spend, and no skim.** A swap request meets the pool
  alone (exactly two inputs), so the pool's fee slices are taken on the whole
  of what the order trades; orders cannot net against each other inside a
  transaction and pay the creator and the platform on the difference only.
  What leaves the pool reaches the placer in full and what enters the pool is
  exactly the part being traded, so the executor earns the agreed fee and
  nothing else. Throughput comes from chaining transactions, as Splash's own
  executor does. Splash's newer batch design trades that guarantee for an
  executor spread; this package does not.
- **Deposit and redeem requests name the pool's own assets.** A request whose
  assets are not the pool's is refused outright, and a deposit's collateral is
  checked back to the placer on every fill, not only when ADA is the surplus
  side. Both are tightenings over the Plutarch source.

## Parameters and deployment order

Applying a parameter fixes a validator's hash, and four of the venue scripts
take another one's hash, so they are applied in this order:

1. `royalty_withdraw_pool(withdraw_request_vh)` — the hash of
   `withdraw_order`, which takes no parameters and is therefore already fixed.
2. `pool(royalty_withdraw_vh)` — the hash from step 1.
3. `redirect(thread_nft_policy, pool_vh, cto_governance_cred, lp_escrow_cred)`
   and `treasury(authority, max_treasury_fee, pool_vh)` — both take the pool
   validator's hash from step 2, alongside the platform's thread NFT policy and
   the launch package's governance and escrow validators.
4. `pool_mint(thread_nft_policy, pool_vh, redirect_cred, treasury_cred, …)` —
   the pool from step 2 and the redirect script from step 3. The factory writes
   the redirect credential into every pool's datum as the second `dao_policy`
   entry, which is what keeps the pool's own hash independent of the redirect
   script's.

The four order validators take no parameters at all. A launch's genesis records
the factory's policy id in its curve and escrow datums, so the venue's hashes
are final before any launch is minted against them.

## Fee model

`fee_num`, `treasury_fee` and `royalty_fee` are numerators over `100_000`. The
Noctis post-graduation split maps to `royalty_fee = 1_000` (creator 1.0%),
`treasury_fee = 100` (platform 0.1%) and `fee_num = 99_700` (a 0.3% pool fee of
which the 0.1% LP share is the part left in reserves). These are per-pool datum
values set at creation, not constants of the validator.

## Not here yet

The batcher (Splash's executor is unlicensed and is not used), and the launch
package's side of the graduation transaction (the curve seeding the pool output
instead of raw reserves), which rides the launch package's next validator
pass. The build plan tracks these.

## Build and test

Run Aiken from a WSL-native checkout inside a pseudo-TTY (see the repository
notes on why `/mnt/c` gives false results):

```
aiken check
aiken build
```
