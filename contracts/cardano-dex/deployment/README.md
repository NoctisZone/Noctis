# The applied venue scripts

`plutus.json` records what the compiler produces. For a validator that takes a
parameter, that is not the script anyone deploys: what deploys is the result of
applying the parameter, and those bytes exist only once someone applies it.
`applied.json` holds that result for the venue validators whose parameters
follow from the venue package alone, so the tooling can recognise the scripts
that actually go on chain.

Two of them need nothing decided, and are the same on every network:

| Validator | Parameter | Taken from |
|---|---|---|
| `royalty_withdraw_pool` | `withdraw_request_vh` | `withdraw_order`, which takes no parameters |
| `pool` | `royalty_withdraw_vh` | the line above |

The other three take values from outside the package — the platform's thread
NFT policy and payout key, the launch package's governance and escrow
validators, and the fee schedule — so their applied bytes belong to a
particular deployment rather than to the source. **They carry a `network` field
for that reason, and the two above do not.** A hash derived from the platform's
own keys is not portable, and an entry that does not say so invites being read
as though it were.

### The Preprod deployment (2026-09-10)

| Validator | Applied hash |
|---|---|
| `redirect` | `32c0b50e36e96f5475f9cfe505d64813d14421ef5036f163bd94df45` |
| `treasury` | `c85a51bc67a1bddbc0cf279c28bbde5a85cbba9d0a853080d4af34a4` |
| `pool_mint` — **the factory policy id** | `dca1616be3e58b4e20ffc4cebb6cde714fa0ddb9c3874c581f396c04` |

Two of its inputs are decisions rather than derivations, and are recorded as
such in each entry's `parameters`:

- **`max_treasury_fee` is `100`, equal to the deployed `treasury_fee` — DECIDED
  by the founder 2026-09-12, no longer a standing recommendation.** So the
  platform's own cut can be waived or reduced by the DAO arm and never raised.
  It matters more than it looks: `SetTreasuryFee` is bounded by this AND by the
  pool datum's `new_fee + royalty_fee < fee_num`, but that second bound works
  out near 98.9%, so this parameter is the only thing that really bounds what a
  pool can be made to pay.
- **`treasury_address` is a payment KEY HASH, not an address.** `treasury.ak`
  compares a payout against `VerificationKey(treasury_address)`, so a whole
  57-byte address is not a credential at all. It still applies cleanly and
  still produces a real, reachable script — 29 bytes larger, which is exactly
  the difference between the two — so nothing catches it except knowing.

## Reproducing it

Apply with Aiken, in the order the parameters chain, from a WSL-native checkout
inside a pseudo-TTY (see the package README for why `/mnt/c` gives false
results). Each parameter is a script hash, so each is CBOR `581c` followed by
the 28 bytes:

```
aiken blueprint apply -m royalty_pool/single_royalty_withdraw_pool \
  -v royalty_withdraw_pool -i plutus.json -o step1.json 581c<withdraw_order hash>

aiken blueprint apply -m royalty_pool/pool -v pool \
  -i step1.json -o step2.json 581c<royalty_withdraw_pool hash from step1>
```

Then check the result against a second implementation before trusting it —
`integration/tests/dex-applied-scripts.test.ts` re-derives every hash in this
file from its own recorded bytes with Mesh and compares, which is what makes an
applied hash evidence rather than a claim.

## Apply with Aiken, and only with Aiken

`aiken blueprint apply` and an SDK's own parameter helper do **not** agree.
Applying `withdraw_order`'s hash to `royalty_withdraw_pool` gives a 2,797-byte
script under Aiken and a 2,800-byte one under Mesh's `applyParamsToScript`, with
different hashes; the Mesh result also comes back already CBOR-wrapped, so
wrapping it again for hashing — which is correct for a blueprint's
`compiledCode` — produces a third answer. All three are well-formed scripts at
three real addresses, and no error is raised anywhere along the way. Only the
Aiken result is the script this repository's deployment order names.

So the rule is the same one the hashes file states for pointers: derive, never
reconcile. Apply with Aiken, carry the bytes, and let the tooling check that the
bytes and the hash agree before anything is spent.

## A constructor's list form is load-bearing

A `Credential` parameter can be written with an indefinite-length list
(`d87a9f…ff`) or a definite one (`d87a81…`). Both are well-formed CBOR, both
decode to the same `Data`, both apply without complaint — and **they produce
different scripts at different addresses.** Measured on `redirect`:

```
indefinite  32c0b50e36e96f5475f9cfe505d64813d14421ef5036f163bd94df45
definite    928f32f207504c279c112a4ffd395be33c40e4a21bfa36cf706671e7
```

**Use the indefinite form.** That is what Aiken's own `cbor.serialise` emits —
asked directly, by a test that serialises a `Credential` and compares — and
what Lucid Evolution emits for the same value, so the two implementations this
repository actually builds with agree. A probe that asserts the definite form
fails.

Two traps sat in the way of asking that question, and both look like a pass:
`aiken check -m` with a filter that matches nothing prints `0 errors` and no
check count, and a file whose module name is invalid (a leading underscore, for
instance) is skipped with a warning while the summary still reads clean. Give
any such probe a test that MUST fail, and confirm the check count moved.
