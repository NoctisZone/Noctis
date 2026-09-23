// ============================================================================
// Noctis Zone — read SEVERAL Midnight wallet seeds' balances in one pass
// ============================================================================
// The singular `midnight-wallet-balance.mjs` reads one seed per process. The
// settings page shows eleven wallets, so it was spawning eleven processes, each
// paying Node startup, the wallet-sdk's WASM initialisation and its own
// indexer connection before doing any work — about two minutes in total, and
// only ever driven from a cron tick because a web request on this host cannot
// give the WASM reader enough virtual memory.
//
// Same derivation and same reader as the singular version, over one process
// and one subscription client. Addresses are still read sequentially: the
// indexer replays an address's whole history, and eleven at once against a
// shared public endpoint trades a client-side wait for a server-side one.
//
// Results come back keyed by the caller's own role names, so a partial failure
// names the wallet it belongs to instead of losing the whole batch. One
// unreachable address does not cost the other ten their answer.
//
// Input:  {"network":"preprod","indexerWsUrl":"wss://…",
//          "wallets":[{"role":"wallet_seed","seedHex":"<64 hex>"}, …]}
// Output: {"results":{"<role>":{"address":…,"nightAtomic":…,"dustCapacityAtomic":…}
//                     | {"error":"…"}}}
// ============================================================================

import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { getUnshieldedNightBalances } from '../indexer-client.js';

import { claimStdoutForResult } from './cli-io.js';

interface WalletInput {
  role: string;
  seedHex: string;
}

interface Input {
  network: 'undeployed' | 'preprod' | 'preview' | 'mainnet';
  indexerWsUrl: string;
  wallets: WalletInput[];
}

/** DUST capacity: 5 DUST per NIGHT (max), per the tokenomics. */
const DUST_PER_NIGHT_MAX = 5n;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Same derivation as the singular CLI: account 0, NightExternal, index 0. */
function addressFromSeed(seedHex: string, network: Input['network']): string {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error(`invalid seed (${JSON.stringify(hd)})`);
  const der = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.NightExternal] as const)
    .deriveKeysAt(0);
  hd.hdWallet.clear();
  if (der.type !== 'keysDerived') throw new Error(`key derivation failed (${JSON.stringify(der)})`);
  return PublicKey.fromKeyStore(createKeystore(der.keys[Roles.NightExternal], network as never)).address;
}

async function main(): Promise<void> {
  // Stdout carries the result and nothing else; what the SDK logs goes with the rest of the diagnostics.
  claimStdoutForResult();
  const input: Input = JSON.parse(await readStdin());
  if (!input.indexerWsUrl) throw new Error('indexerWsUrl is required.');
  if (!Array.isArray(input.wallets) || input.wallets.length === 0) {
    throw new Error('wallets must be a non-empty array of {role, seedHex}.');
  }

  const results: Record<string, unknown> = {};
  const derived: Array<{ role: string; address: string }> = [];

  // Derive first, so a malformed seed is reported against its own role and
  // never reaches the indexer as a bad address.
  for (const w of input.wallets) {
    if (!w?.role) throw new Error('every wallet needs a role.');
    if (!/^[0-9a-fA-F]{64}$/.test(w.seedHex ?? '')) {
      results[w.role] = { error: 'seedHex must be 32 bytes (64 hex chars).' };
      continue;
    }
    try {
      derived.push({ role: w.role, address: addressFromSeed(w.seedHex, input.network) });
    } catch (err) {
      results[w.role] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (derived.length > 0) {
    const balances = await getUnshieldedNightBalances(
      input.indexerWsUrl,
      derived.map((d) => d.address),
    );
    derived.forEach((d, i) => {
      const nightAtomic = balances[i]?.balance ?? 0n;
      results[d.role] = {
        address: d.address,
        nightAtomic: nightAtomic.toString(),
        dustCapacityAtomic: (nightAtomic * DUST_PER_NIGHT_MAX).toString(),
      };
    });
  }

  process.stdout.write(JSON.stringify({ results }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
