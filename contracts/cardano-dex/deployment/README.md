# The applied venue scripts

`plutus.json` records what the compiler produces. For a validator that takes a
parameter, that is not the script anyone deploys: what deploys is the result of
applying the parameter, and those bytes exist only once someone applies it.
`applied.json` holds that result for the venue validators whose parameters
follow from the venue package alone, so the tooling can recognise the scripts
that actually go on chain.

Two of the nine are in it, and they are the two that need nothing decided:

| Validator | Parameter | Taken from |
|---|---|---|
| `royalty_withdraw_pool` | `withdraw_request_vh` | `withdraw_order`, which takes no parameters |
| `pool` | `royalty_withdraw_vh` | the line above |

The other three take values from outside the package — the platform's thread
NFT policy and payout key, the launch package's governance and escrow
validators, and the fee schedule — so their applied bytes belong to a
particular deployment rather than to the source, and are derived when those are
chosen.

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
