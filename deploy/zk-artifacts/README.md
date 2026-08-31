# Noctis ZK Artifact Host — Deployment Config

Deployment config and real, measured sizing data for the static file host
serving `{zkBaseUrl}/keys/{circuitId}.prover`,
`{zkBaseUrl}/keys/{circuitId}.verifier`, `{zkBaseUrl}/zkir/{circuitId}.bzkir`
— the path convention `midnight-wallet-bridge.ts`'s `configure()` expects at
`midnightZk.zkBaseUrl` (confirmed real).

**Status: real sizing data now measured (2026-07-22), hosting not yet
provisioned.** This was originally expected to be "a 5-minute local check,
not an open research question," and that turned out to be right — it just
hadn't been done yet against every contract, only `eligibility_gate` (sitting in
`contracts/midnight/compiled_realzk/`, untracked, from an earlier session).
This pass ran a real, non-`--skip-zk` `compact compile` against all 8 PSMs to
close that gap for real.

## The real command

```bash
# Must run under WSL (or any real Linux/macOS shell) — on Windows, a bare
# `compact` on PATH resolves to system32\compact.exe (NTFS file compression),
# not the Midnight Compact CLI. contracts/midnight/package.json's own
# `compile` script already guards against this exact mistake.
cd contracts/midnight
compact compile <contract>.compact compiled_realzk/<contract>
# NOT --skip-zk — that flag skips PLONK prover/verifier key generation
# entirely (an earlier 1.2MB/116-circuit ZKIR-only figure came from --skip-zk
# and excludes the artifacts that actually matter for sizing this host).
```

Run once per `.compact` file — there is no single `compile-all` entry point
today; `package.json`'s `compile` script loops the 8 files with `--skip-zk`
for the fast dev-time typecheck path, not this one.

## Real measured sizes (2026-07-22, this session — all 8 PSMs, complete)

| Contract | Circuits | Total size |
|---|---|---|
| `bonding_curve.compact` | 34 | 100 MB |
| `staking_pool.compact` | 6 | 85 MB |
| `eligibility_gate.compact` | 20 | 80 MB |
| `cto_governance.compact` | 19 | 60 MB |
| `lp_escrow.compact` | 11 | 27 MB |
| `creator_escrow.compact` | 14 | 20 MB |
| `vesting.compact` | 9 | 14 MB |
| `treasury.compact` | 7 | 6.5 MB |
| **Platform total** | **120** | **~393 MB** |

Measured via WSL (real Compact CLI 0.5.1, not `--skip-zk`) against a scratch
copy of `contracts/midnight/` at `~/noctis-zk-measure/midnight/` — real
compile, not an extrapolation. Wall time for the full 8-contract run: under
3 minutes total (dominated by `bonding_curve`'s 68s and `staking_pool`'s 57s;
the other 6 ran in 5-43s each). The `compiled_realzk/` output directories
this produced are gitignored (large regenerable binaries, not source — see
`.gitignore`) and currently live only in that WSL scratch path plus the
pre-existing `contracts/midnight/compiled_realzk/eligibility_gate/` — rerun
the command above (once per contract) to regenerate them for a real upload.

**Per-circuit shape (consistent across all 8 contracts):** verifier keys are
uniformly tiny (4 KB each — negligible for hosting/bandwidth purposes). ZKIR
files (`.bzkir`) are 1-4 KB each. Almost all size lives in `.prover` keys,
and within those, one specific circuit shape dominates: any circuit built
around a 20-level Merkle-proof fold costs **37 MB**, regardless of which
contract it's in — `eligibility_gate.registerForDarkVeil`,
`bonding_curve.registerForDarkVeil`, and (newly found this pass)
`staking_pool.claimRewards` **and** `staking_pool.proveStake` all land at
exactly this size, which is why `staking_pool` (only 6 circuits) still ranks
2nd-largest overall — two of its six circuits are Merkle-membership proofs
(the governor-attested stake-snapshot design: `proveStake` proves
membership in the published stake root, `claimRewards` proves membership in
the published reward root). This matches an earlier independent finding that a
20-level Merkle fold is the single most compute-expensive circuit shape in
the suite; the size figure now confirms it's also consistently the largest,
across every contract that uses the pattern. Every other circuit's prover
key falls in a 24 KB–5 MB band depending on how much Merkle/hash work it
does.

## Sizing conclusion

**~393 MB across all 8 PSMs, real and complete — not an estimate.** This
closes the original "which host tier do we need" open question for good:
it uses under 4% of Cloudflare R2's 10 GB free tier, with wide headroom for
any future contract growth. Any of the previously-considered hosting options
(R2, GitHub Pages, the existing WordPress host) works comfortably at this
size — the decision comes down to operational fit (egress cost model, CORS
control, existing pipeline reuse), not capacity.

## Recommended host: Cloudflare R2

Matches the original research recommendation, now backed by real numbers
rather than an estimate:

- **10 GB free tier** — the measured + projected total fits with wide margin.
- **Zero egress fees** — relevant specifically because `zkBaseUrl` config
  fetches happen on every DarkVeil registration/buy, not once like a
  docs page. A per-request bandwidth bill would scale with platform usage;
  R2 doesn't have one.
- **Real, configurable CORS** — needed since the widget bundle fetches these
  files via browser `fetch()` from the WordPress origin, a different origin
  than the R2 bucket.
- **S3-compatible API** — works with any existing S3 tooling (`aws s3 sync`,
  `rclone`, etc.), no Cloudflare-specific SDK required for a one-way static
  upload.

### Provisioning runbook

1. **Create the R2 bucket** (Cloudflare dashboard → R2 → Create bucket, e.g. `noctis-zk-artifacts`), or via `wrangler`:
   ```bash
   wrangler r2 bucket create noctis-zk-artifacts
   ```
2. **Enable public access** for the bucket (R2 → bucket → Settings → Public Access → Allow Access, or attach a custom domain — a custom domain is preferable for a stable `zkBaseUrl` that doesn't depend on Cloudflare's own `r2.dev` subdomain, which is rate-limited and explicitly not meant for production traffic).
3. **Set CORS policy** — the widget's browser-side `fetch()` needs the WordPress origin allowed:
   ```json
   [
     {
       "AllowedOrigins": ["https://noctis.zone"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
4. **Upload artifacts**, preserving the `keys/`/`zkir/` path structure per circuit, for every contract the widget actually needs at runtime (Cardano Launch needs `eligibility_gate`; Midnight Launch, once unblocked, needs `bonding_curve`/`treasury`/`creator_escrow`/`vesting`/`lp_escrow`/`cto_governance`/`staking_pool`):
   ```bash
   aws s3 sync contracts/midnight/compiled_realzk/eligibility_gate/keys/ \
     s3://noctis-zk-artifacts/eligibility_gate/keys/ \
     --endpoint-url https://<account-id>.r2.cloudflarestorage.com
   aws s3 sync contracts/midnight/compiled_realzk/eligibility_gate/zkir/ \
     s3://noctis-zk-artifacts/eligibility_gate/zkir/ \
     --endpoint-url https://<account-id>.r2.cloudflarestorage.com
   # repeat per contract
   ```
   (Requires an R2 API token with read/write scope, configured as the AWS CLI's access key/secret for this profile — R2's S3-compatible endpoint accepts standard AWS CLI auth.)
5. **Verify public GET + CORS for real**, not just "upload succeeded":
   ```bash
   curl -sf -H "Origin: https://noctis.zone" -I \
     https://<public-r2-domain>/eligibility_gate/keys/registerForDarkVeil.prover
   # confirm: 200, Access-Control-Allow-Origin present, Content-Length matches the real 37MB file
   ```
6. **Wire the URL into the widget config** — `midnightZk.zkBaseUrl` in `integration/widget/midnight-wallet-bridge.ts`'s `configure()` call, and the matching `midnight_zk_config_base_path` Settings field.
7. **End-to-end smoke test**: load a real DarkVeil registration page, confirm the browser network tab shows a real `.prover`/`.verifier`/`.bzkir` fetch against the R2 URL succeeding, then confirm the resulting proof is accepted end-to-end by the proof server. This is the step that actually closes out this deployment — measuring sizes and provisioning a bucket are necessary but not sufficient.

### Fallback options (if R2 access isn't available)

- **GitHub Pages** — near-zero effort since Noctis already runs a GH Pages pipeline (`build-docs.py`); confirmed to serve `Access-Control-Allow-Origin: *` on GET/HEAD with no preflight. Soft ~1 GB repo / 100 GB-month bandwidth ceiling is comfortably clear of the measured totals above, but CORS/behavior isn't tunable if that ever becomes a problem.
- **The existing WordPress host** — plain static files under the theme/plugin, no CDN required to start. Simplest possible fallback, worth using only if both of the above are unavailable, since it puts ZK-artifact bandwidth on the same host serving the rest of the site.
