#!/bin/bash
# Compiles all 8 Compact PSMs to compiled/. Shared by package.json's
# `compile` script and vitest.config.ts's globalSetup, so the same
# Windows-compact.exe safety check and contract list only live in one
# place.
set -e

if ! compact --version 2>&1 | grep -qE '^compact [0-9]'; then
  echo 'ERROR: `compact` does not resolve to the real Midnight Compact CLI.' >&2
  echo 'On Windows, the native `compact` on PATH is system32\compact.exe (a file-compression tool), not the Compact compiler.' >&2
  echo 'Run this via WSL, where the real CLI is installed (see midnight-tooling:install-cli), or fix PATH ordering so the real `compact` resolves first.' >&2
  exit 1
fi

# The toolchain version and the LANGUAGE version it speaks are two different
# numbers, and only the second is what these contracts declare. Compiling with a
# toolchain outside the pin fails with `language version X mismatch`, which names
# the language version and not the toolchain that brought it — so check here and
# say which version to install.
PIN="$(grep -vE '^[[:space:]]*(#|$)' "$(dirname "$0")/../compact-toolchain.txt" | tail -1 | tr -d '[:space:]')"
GOT="$(compact compile --version 2>/dev/null | tr -d '[:space:]')"
if [ -n "$PIN" ] && [ "$PIN" != "$GOT" ]; then
  echo "ERROR: Compact compiler is ${GOT:-unknown} but this project pins $PIN." >&2
  echo "Run: compact update $PIN" >&2
  exit 1
fi

for f in bonding_curve eligibility_gate treasury creator_escrow vesting lp_escrow cto_governance staking_pool; do
  compact compile --skip-zk "$f.compact" "compiled/$f"
done
