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
| `validators/royalty_pool/single_royalty_withdraw_pool.ak` | splash-core `validators_v3` (Aiken) | vendored; the request script hash is a validator parameter, a claim's amounts are bounded below, and the claim must pay the creator's own key |
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
  `royalty_pub_key`, delegated by the creator or not at all. The pool-side
  script holds that rule itself, so it binds every claim rather than one route
  through one. A CTO redirect of
  that key moves the payout with it. A claim draws a non-negative amount from
  each side, so the counter it settles against can only fall.
- **The platform slot has its own small script** that acts on one real pool:
  the input it names must sit at the pool validator's address and hold the NFT
  its datum names, and exactly one input sits there. The pool's own DAO arm
  keeps its shape independently — liquidity untouched, only the treasury
  counters and the treasury fee free to move, neither counter below zero, and
  whatever leaves matched to a counter — instead of Splash's multisig
  DAO action: withdraw to the key the pool's datum names — a payout may carry
  ADA beyond what the pool paid, so a token-only withdrawal can meet its own
  minimum from the platform's own inputs, and no other surplus is allowed — or
  move `treasury_fee` within `[0, max_treasury_fee]` and below what the pool's
  own schedule can carry, touching nothing else. Neither action moves the pool nonce: that is replay
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
- **A pool keeps its own two assets, and its liquidity has a direction.** The
  successor of any pool spend still holds the pool's token and its LQ token, in
  the same number of assets it started with, so nothing foreign can arrive in
  the place of something the pool named. Deposit and redeem each state which
  way liquidity moves, and the proportion they are held to is a proportion of
  liquidity the pool actually has.
- **An order carries only what it names.** Every value rule in the four order
  validators is an inequality over a named set: the assets the request trades,
  its LQ, the pool's own. Each order is therefore held to carrying exactly
  those and ADA — which every order holds for the executor's fee and its own
  minimum, and which each validator accounts for in its own arithmetic — and a
  swap's continuation to the same set, so nothing rides along that none of the
  rules measures and no token can be left on a continuation to block the next
  fill. A request assembled with anything else is refundable rather than
  fillable, which puts the discipline where the order is built: our own front
  end and batcher.
- **A pool names four assets, and they are four different assets.** Reserves,
  liquidity and the pool's own NFT are each read out of the pool's value by
  name, so each balance answers for exactly one of them. The factory writes
  those names from the launch rather than taking them on trust: the second
  asset is the launch's token, being neither ADA nor the pool's own LQ or NFT,
  which with the value capped at four assets leaves it nothing else to be.
- **One continuing output answers for one pool.** A pool's NFT exists in a
  single unit, exactly one input of any transaction may carry it, and the
  successor is found by it — so a pool's own arm accounts for the pool it is
  spending and no other, and the two validators it delegates to each keep the
  same count.
- **What the pool delegates, it delegates to a script.** Three of the five
  actions are authorised by a withdrawal at a credential the datum names, which
  is evidence only because a withdrawal at a script credential runs that
  script. Both credentials the datum carries are script credentials, and they
  are different scripts, so each action is authorised by the one the pool names
  for it. The factory takes them as script hashes, so it can write no other
  kind. A royalty claim likewise requires the pool input it names to carry the
  NFT that input's own datum names, which is what ties the claim to a pool
  without the two scripts having to name each other.
- **The fee schedule is a schedule.** The three fees are numerators over a
  fixed denominator, and each is held to being one in both directions: enough
  left after both slices for the pool to price against, and no numerator above
  the denominator. That is what keeps a fee slice smaller than the trade it is
  taken from, and so keeps the reserves the pool reports equal to the reserves
  it holds. The factory fixes the schedule at creation and is where it is
  checked, since no later action can raise or lower it.
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

`fee_num`, `treasury_fee` and `royalty_fee` are numerators over `100_000`, and
a swap is priced on what survives both slices — `fee_num - treasury_fee -
royalty_fee` — so what the pool keeps is whatever `fee_num` leaves below the
denominator.

The Noctis post-graduation split is `royalty_fee = 1_000` (the creator's 1.0%),
`treasury_fee = 100` (the platform's 0.1%) and `fee_num = 99_900`, leaving 0.1%
in the pool's own reserves: a total take of **1.2%** plus the batcher fee.

They are per-pool datum values rather than constants of the validator, but the
factory writes them from its own parameters onto every pool it mints and no arm
can raise or lower them afterwards, so a deployment's schedule is fixed at the
moment its factory hash is.

## How a pool opens

A pool comes into being in its launch's graduation and nowhere else, as one
transaction that satisfies four validators at once:

| output | what it is | what holds it to that |
|---|---|---|
| 0 | the curve's own continuing record | `Graduate`: the state, the raise and both reserves really leaving, nothing padded |
| 1 | the LP escrow, sealed | `SealLock`: the position its datum names really arrives, and its lovelace does not move |
| 2 | the pool, opened | the factory: its own expected datum field for field, four assets, the NFT, the LQ remainder |
| 3 | the staking pool, seeded | `TopUpPool`, on a launch that opted into staking |

The factory names outputs 1 and 2 **by index**, so the order above is part of
the transaction's meaning. Every step is permissionless: the factory's
authority is that the curve is spent under `Graduate` in the same transaction,
and the curve's authority is that it really sold through. Nothing can withhold
a pool from a launch that earned one.

The escrow's position is the pool's own LQ token, `initial_lq` of it, minted
here and held for the lock. The pool keeps the rest of the LQ supply, so
circulating liquidity is read from the pool's balance rather than stored.

**Every script is referenced, not carried.** The curve, the escrow, the staking
pool and the factory together are roughly twice the 16,384-byte transaction
cap, so all four are named through published CIP-33 pointers. Referenced, a
staking graduation is under 2.8 KB.

**Measured budgets.** Evaluated against a real script context with
`aiken tx simulate`, a staking graduation spends **2,861,455** memory units and
**1,068,537,256** cpu steps — about 17% and 11% of a mainnet transaction's
limits. A launch that declined staking spends roughly two thirds of that. The
figures are for the current build and are worth re-measuring when a validator
in either package changes.

## How a swap fills

A swap request meets the pool **alone**. `swap_order.ak` requires the
transaction to have exactly two inputs, so one fill is one order against one
pool, and throughput comes from chaining transactions rather than from packing
them.

That is a guarantee, not a limit. Orders able to net against each other inside
a single transaction would pay the creator and the platform on the difference
only; here every order meets the pool by itself, so both fee slices are taken
on its whole input.

| | what it is |
|---|---|
| input 0 / 1 | the pool and the order, in the ledger's own order |
| output 0 | the pool, its reserves moved and its two counters credited |
| output 1 | the placer's reward, or the order continuing with the rest to trade |
| output 2 | the executor's payment, when it takes one |

Both inputs are named **by index** in the two redeemers, and the transaction
builder sorts inputs before serialising them — so the numbers are positions
after that sort, not the order a caller listed them in. The submitter predicts
the sort and then decodes the finished transaction to confirm the prediction
held, because getting it wrong is silent: the transaction is well formed, both
scripts run, and each checks the wrong input.

**The executor supplies nothing.** With only two inputs there is no room for
one of its own, so the order carries `ex_fee` lovelace and the transaction
balances out of it. `ex_fee` is a ceiling rather than a price: every rule the
order states about it is an inequality, so an executor may take less and leave
the difference with the placer.

**Measured cost.** Evaluated against a real script context with
`aiken tx simulate`:

| fill | pool `Swap` | order `Fill` | size | fee |
|---|---|---|---|---|
| buy, ADA in | 710,423 mem | 583,396 mem | 934 B | 0.433230 ADA |
| sell, token in | 713,723 mem | 637,597 mem | 887 B | 0.431162 ADA |
| partial buy | 710,423 mem | 723,359 mem | 1,079 B | 0.439610 ADA |

Each row is one transaction that really validates, priced with the budgets the
same run measured. A 100 ADA trade against a 20,000 ADA pool; the fee moves
with the transaction's size rather than with the trade's.

The dearest of the three spends **1,433,782** memory units and **494,857,489**
cpu steps — under a tenth of what one mainnet transaction is allowed. Both
validators are referenced rather than carried: the two together are 7.3 KB and
would fit, but carrying them costs a further 0.21 ADA on every fill forever.

**An order sets aside 1.5 ADA** for its own execution: the fill's fee, plus the
smallest output the protocol's per-byte minimum admits, because an executor's
payment has nowhere else to go. The floor under that was bisected against the
real builder across every dimension that makes a fill bigger — a
token-to-token pool, a placer with a stake key, an executor the order names,
and an executor paying itself at a base address, all at once — and came to
1,409,932 lovelace. 1.5 ADA clears it by about 6%, which is the margin that
absorbs a validator growing or a protocol parameter moving without every order
in flight becoming unfillable.

**1.5 ADA funds one fill.** The fee is shared out in proportion to what is
filled, so a fill of part of an order draws only that part of the fee while
still paying for a whole transaction. At 1.5 ADA the least of an order anyone
can fill is about **94%** of it: an order fills whole or waits.

That is a choice about where the cost sits, and the price floor is the cheaper
lever. A trade moves the price against itself, so **an order worth about p% of
the pool needs a floor about p% below spot** — set the floor from the quote
rather than from spot and an order fills whole. Set it from spot and an order
of any real size can never clear it, at any fee. Against a 20,000 ADA pool a
floor 0.5% under spot admits about 100 ADA in one trade, 1% admits 205, and 2%
admits 413.

Raising the fee buys the same fill certainty far more expensively: a pool that
can serve only 15% of an order needs about seven fills' worth of fee to serve
that 15%. A placer who genuinely wants to be filled in pieces gets a better
deal placing several orders, each of which fills whole for 1.5 ADA.

So the placement screen owes the placer two checks, both answerable before
signing and neither visible afterwards — an order that cannot fill just sits
there: that the floor leaves room for the order's own impact, and that the fee
covers the part that would actually fill.

For scale, mainnet's block budget runs out at roughly **40 to 45 fills** — the
cpu-step limit binds first — which is a ceiling the chain sets rather than one
the venue does.

## What is a pool, and what is an order

Both venue scripts are shared: every pool in the venue sits at one address and
every swap request at another, so an address proves nothing and anyone may
park anything at either. The two sides need different answers.

**A pool is authenticated, and its own datum cannot do it.** A datum names the
NFT it claims to be identified by, so a forger names one they minted
themselves and satisfies any test drawn from the datum alone. A genuine pool
NFT can only have come from the factory, whose policy is a deployment fact no
on-chain actor can influence — so a pool is a UTXO holding exactly one asset
under that policy, tagged with the pool role, whose datum names that same
asset. The pool's LQ token shares the policy and is deliberately not a
candidate: it is fungible, so a balance of it says nothing about identity.

**An order needs no authentication, because it is a request.** Nobody forges a
claim on somebody else's funds by writing a datum; an order can only ever spend
itself. What matters is that a malformed one is counted rather than thrown or
quietly dropped — a reader that reports three pools where the chain holds four
is indistinguishable from a chain that holds three, and the difference is a
launch whose market has silently stopped trading.

## How a round of fills runs

A pool fills one order per transaction, so a round of work against one pool is
a **chain, not a set** — and every rule the runner follows comes out of that.

**The state a round was read at is correct only for its first fill.** Each fill
spends the pool output the last one made, so the second order in a pool's queue
meets a pool that has already moved: a worse price, and possibly a floor it no
longer clears. The runner carries each successor forward and re-asks whether
the next order is still fillable against it, rather than reusing what was read
before any of the round ran. The successor is derived from the fill's own
arithmetic rather than read back from the chain, because waiting for a
confirmation between links would cost a block per fill.

**A failure ends that pool's chain, and nothing else.** After a fill fails,
either it never reached the chain or it reached it and the reply did not come
back, and the two are not distinguishable from outside. Every later fill in
that chain rests on whichever is true, so the chain stops and the next round
re-reads the chain, which is the authority on the question. Other pools are
untouched — their chains never shared an input with this one.

**Chain depth is exposure.** A chained transaction is invalid if its parent
never lands, so ten fills against one pool is one transaction's fate shared by
ten. The depth a round will reach is bounded, and the default is ten.

**Fills follow the reader's sequence, never the runner's preference.** The
sequence is block height, then transaction index, then output index — all facts
of the chain, so the order a batcher is obliged to follow is derivable by
anyone from public data, and a run that departs from it is visible as such
afterwards.

**Every order comes back in one of four outcomes**, because they mean four
different things to whoever is watching: `filled` is work done; `unfillable` is
the normal resting state of an order waiting for a price; `declined` is the
batcher choosing not to, under a stated rule; and `failed` is the only one that
is ever an alarm. A monitor that cannot tell an idle market from a broken one
pages for the first and stays silent through the second.

### What the executor's float has to be

A fill has two inputs and neither is the executor's — the order pays for its
own execution out of `ex_fee` — so a batcher never funds a fill and needs no
working capital to run one. Its only ada at stake is **collateral**, which
every Plutus spend must name and which is taken only when a transaction is
accepted and a script then fails. That makes the float question materially
smaller than it is for a venue whose executor fronts trades, and it is worth
settling the hosting and key-custody decisions against the real figure rather
than the assumed one.

## What a quote promises, and what it only estimates

An order is not filled when it is signed. It rests until an executor meets it,
and the pool it meets is not the pool it was quoted against — so **a quote is a
bound, not a price**, and the two ways a fill departs from its quote point in
opposite directions.

The pool may move first, because other fills land in between, and the placer
then gets less than the quote said. What stops that going arbitrarily far is
the order's own price floor, and **the floor is the only figure anyone is bound
to**: a fill pays at or above it, or the validator refuses the fill. The other
direction is the execution fee, which is a ceiling rather than a price — a
settled fill charges what the transaction cost and returns the rest — so the
lovelace side usually comes back slightly better than quoted.

**The floor is set from the quote, never from spot.** This is the one mistake
worth designing against, because it is silent. A trade moves the price against
itself, so an order worth roughly p% of the pool realises about p% below spot;
a floor placed at spot less a small tolerance is therefore unreachable at any
size and at any fee, forever. From outside, that order is indistinguishable
from one patiently waiting for a better price. A draft is checked against the
pool before it is returned, so an order that could not be filled at the state
it was quoted at is refused rather than handed back.

**Price impact is measured against the fee-inclusive spot**, so it is the
effect of the trade's size alone. Measuring from the fee-free mid price would
report the pool's own fee a second time, as though the trade had caused it: a
1 ADA trade into a 20,000 ADA pool would read about 121 basis points where the
honest figure is 2.

Everything is exact integer arithmetic and rates are rationals, in the shape
the order datum states its floor in — a rate that has been through a float is a
rate that no longer agrees with the validator.

## Getting out of an order

`swap_order.ak`'s cancel arm is one line — the placer's own signature, and
nothing else. No deadline, no batcher, no counterparty, no conditions. An order
is never something its placer has to wait to get out of.

**A venue order has no expiry, and that is the design rather than a gap.** The
launch curve's order is the other way round: it carries a deadline and a
permissionless expiry sweep beside the owner's own cancel. The difference is
the instrument. A curve order is a queued instruction against a curve that will
eventually graduate and close, so an unfilled one needs returning and a
deadline anyone may act on is right. A venue order is a resting limit order,
and resting indefinitely is what a limit order is for — giving it an expiry
would make it a worse instrument, and letting a stranger return it would hand
them the choice of when somebody else's order stops existing.

So expiry here is off-chain and advisory: a tracker can say an order has been
sitting a long while and offer the placer the button. Nobody else can act on
it, ever.

**What a placer actually needs is not a countdown but an answer**, because an
order that will never fill looks exactly like one patiently waiting. Four
states, and two of them are permanent:

- **fillable** — an executor can fill it now, and this says how much.
- **waiting** — the pool cannot reach its floor yet, and this says how far
  short it is in basis points, so the placer can tell a normal day's move from
  a different market.
- **unfundable** — its execution fee is below what one fill costs. The fee is
  fixed when the order is written, so no part of it can be filled at any price,
  now or later.
- **orphaned** — it names a pool that does not exist. One unit of a pool NFT is
  ever minted, so nothing can arrive later to change that.

Nothing is ever stranded beyond recovery: every one of those is cancellable by
the placer, immediately, for as long as it exists.

Two details about the cancel transaction itself. **Cancels batch and fills
cannot** — the two-input rule lives inside the fill arm, so one transaction can
take back as many of a placer's orders as fit, for one fee and one signature.
And **a cancel offers the wallet's own UTXOs to coin selection where a fill must
refuse them**, which matters more than it sounds: the orders most in need of
cancelling are underfunded ones, which carry barely more than the minimum an
output must hold, so taking a network fee out of one leaves too little to stand
as an output. Without the wallet chipping in, exactly the orders that most need
cancelling would be the ones that could not be.

## A pool's history is a chain, not a feed

**A pool is a single-threaded state machine, so it needs no follower.** Every
action against a pool spends the one UTXO carrying its NFT and creates exactly
one successor carrying it again — `pool.ak` finds its own continuation that
way, and `swap_order.ak` finds it the same way. Each transaction therefore
names its predecessor in its own inputs, and the chain of them *is* the
history. This is the shape the launch curve's trade-history reader already
uses, for the same reason.

That buys three things over a block-range follower with a stored cursor:

- **Rollbacks need no machinery.** Walking backward from the pool as it stands
  now cannot produce a history the chain does not currently have. A rolled-back
  event is simply not on the path.
- **Requests scale with events, not blocks.** A quiet pool costs nothing to be
  up to date on.
- **Nothing has to be stored to be correct.** A caller that keeps events is
  caching, not bookkeeping, and a wrong cache is repaired by walking again.

The cost is that a busy pool's whole history is proportional to that history,
so the walk stops on a transaction the caller already knows — the incremental
read — or after a set number of events. A result says which stopped it, because
a truncated history and a complete one look identical in the events themselves.

**Every event carries the reserves after it**, which is what a price feed
cannot reconstruct later if it was not recorded at the time — except that here
it never has to be, because the chain still holds it.

Events are classified from what moved rather than from the redeemer, so no
second request is needed per event and the answer rests on what happened rather
than on what was asked for. A movement matching no known shape is reported as
unclassified with what was seen, never guessed at. Two rules do the work:

- **Reserves are netted; deltas are not.** A swap's fee slices stay in the pool
  and move to the counters, so the tradable reserve grows by less than the
  trader put in. What a trade executed at is the *balance* movement — the same
  reading the pool validator takes, since it compares both states under the old
  datum. Reporting the netted delta would understate every trade by its own
  fee.
- **A fee withdrawal moves the balance and not the price.** It is the only
  event whose tradable reserves do not move at all, which is exactly how it is
  told apart from everything else.

One trap worth naming, since it is the eUTXO classic: **a reference input is
never spent.** Blockfrost returns reference and collateral entries in the same
`inputs` array as real ones, flagged, so a walk that does not filter them can
follow a pool somebody merely *looked at* into a history that never happened.

## Collecting the platform's slice

The platform's 0.1% is never paid to the platform. It is **credited**, in the
pool's own datum, to a counter `read_pool_state` subtracts back out of the
reserves — so it sits in the pool's UTXO while belonging to nobody who trades
there. The creator's 1.0% sits beside it under its own pair of counters,
claimed under a different redeemer with the creator's signature over the pool's
nonce.

Collecting the platform's side is one transaction that runs **two scripts over
the same pool and lets neither decide alone**. `pool.ak` action 3 spends the
pool and requires a withdrawal at the credential its own datum names; it fixes
what may change — the two treasury counters and nothing else — and pins the
value movement to the counter movement exactly. `treasury.ak` runs at that
credential and decides how much: it re-finds the pool independently, re-checks
its shape, and requires the payout to reach the address the pool's datum names.
Neither script trusts the other's reading. So a collection cannot pay somewhere
else, cannot take more than has accrued, and cannot touch the reserves or the
creator's counters on the way past.

Four things follow, and together they are the whole of the operating decision.

- **A collection costs exactly one network fee.** A payout carrying tokens
  needs the protocol's minimum lovelace to exist, which a small ADA counter
  cannot always cover — so the platform tops it up from its own wallet and
  receives it back in the same output. Track the whole transaction and every
  term cancels but one: the platform's lovelace changes by the ADA counter less
  the fee, exactly. The ADA side of the payout is a floor rather than an exact
  figure for precisely this reason, and the token side stays exact, because
  nothing makes a surplus there necessary.
- **The two counters are not the same kind of thing.** The ADA counter pays for
  its own collection; the token counter never does. Tokens come out in the same
  transaction for nothing, which makes them no reason to go and no reason to
  wait — a token has to be sold before it pays for anything, and selling it
  costs another transaction.
- **One transaction per pool, always.** `treasury.ak` counts the inputs at the
  pool validator and refuses a second, so a collection speaks for one pool and
  no other. The fee is therefore charged per pool per collection, and the only
  lever an operator has is *when*: waiting earns nothing extra but puts more
  behind the same single fee. Nothing decays and nothing expires.
- **Collecting does not move the price.** The counters were already outside the
  reserves, so taking them out changes the pool's balance and not its price. It
  is the one event in a pool's history with that signature — which is how the
  walk above tells a collection from a redeem — and it means no trader is
  affected by the timing and there is no good or bad moment to go.

Because a collection is a pool spend, it competes with a fill against the same
pool rather than sharing it: whichever lands first invalidates the other's
reading of that pool. Nothing is lost but the effort, and the same is true of
two batchers against one pool.

The ledger side reconciles rather than merely reports. Over a **complete**
history, what was earned less what was withdrawn must equal what the datum says
is owed — a real assertion rather than arithmetic, because a pool opens with
all four counters at zero and the factory refuses one that does not, so a gap
means the pool is carrying a claim nothing paid for. Over a partial history the
same figure means something else entirely: what was owed when the walk began.
The two are told apart by whether the walk reached the pool's opening, and by
nothing else.

### When to collect, and what one round can do

The decision has two modes, and they weigh the token side differently on
purpose — they are asking different questions, and what the alternative to
acting *is* differs between them.

- **threshold** — *is this pool worth going to today?* The alternative is
  waiting, and waiting costs nothing: nothing decays, nothing expires, and the
  tokens will still be there next time. So only the ADA counter counts, since
  only it pays for the transaction. The default is **50 ADA**, chosen off the
  curve rather than picked: the fee is 4.2% of a 10 ADA collection, 0.84% of
  50, and 0.42% of 100 — each doubling halves the share, so 50 is where the
  saving from waiting first falls under one percent and keeps shrinking.
- **sweep** — *we are going anyway; is this pool worth including?* The
  alternative is now leaving the money behind rather than waiting, so the whole
  value counts, tokens included at what the pool itself would pay for them. A
  pool holding less than one fee's worth in total is still left alone, because
  paying to collect dust makes the record worse rather than tidier.

A sweep exists for **disclosure, not profit**. The platform publishes its
addresses and discloses quarterly, and sweeping first means the disclosure
covers money the platform holds rather than money it is owed. It costs one fee
per pool — a hundred pools is about 42 ADA a quarter — so the price of the
cleaner record is small and known in advance.

**Collections are independent of one another, which fills are not.** Two fills
against one pool must chain, because the second reads state the first moved.
Two collections against *different* pools share nothing on chain: any order,
any block, and a failure ends only itself. What links them is off chain — every
collection needs a wallet UTXO to pay its fee with, and two built against the
same wallet snapshot name the same one.

So a round **partitions the wallet** rather than serialising the work: one
funding UTXO each, and never the collateral. Two consequences for whoever
operates it:

- **A round collects from at most as many pools as the wallet has spare
  UTXOs.** Anything beyond that is deferred by name rather than built and
  rejected.
- **The count is self-sustaining.** Each collection consumes one funding UTXO
  and produces one change output, so a wallet that starts a round with *n*
  spare UTXOs ends with *n*. It is the shape of the float that matters and not
  its size — one large UTXO collects from one pool per round.

**A round reports what it submitted, and that is not yet what happened.** The
published figure is read back off the chain instead, from the transactions
themselves, so it rests on the ledger rather than on the job's intent and
anyone holding the same hashes derives the same total. That path also excludes
a creator's royalty claim, which moves the same pool the same way and would
otherwise be counted as platform income.

## Not here yet

Running the batcher in production: where it is hosted, how its key is held, and
what watches it. The loop, the fill and the reading are here and tested; the
operational half is a deployment decision the build plan tracks. Splash's
executor is unlicensed and is not used, so this is written rather than adopted.

The aggregator-facing price feed's wire format. Everything it is built from is
here — a pool's market state from its current UTXO, and a stream of trades with
the reserves after each one from the walk above. What remains is the shape an
aggregator wants those served in, and that should be settled against the
aggregator's own specification rather than inferred from third-party adapters,
which pairs naturally with applying to be listed.

Measured execution budgets for a collection's two scripts. The fill's are
simulated against a real script context; the collection's are reasoned from
them, and what a collection costs is pinned against a real built transaction
carrying those figures. Simulating them is what makes the cost figure final,
and it belongs with the same pass that re-measures the fill's.

## Build and test

Run Aiken from a WSL-native checkout inside a pseudo-TTY (see the repository
notes on why `/mnt/c` gives false results):

```
aiken check
aiken build
```
