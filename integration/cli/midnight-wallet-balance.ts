// ============================================================================
// Noctis Zone — read a Midnight wallet seed's live NIGHT balance (and a
// DUST-capacity figure derived from it). Lightweight: derives the address
// offline, then queries the public indexer for the unshielded NIGHT balance
// (getUnshieldedNightBalance — the SAME reliable path check-night-balance
// uses, NO facade/sync). DUST regenerates from held NIGHT over time and can't
// be read cheaply without a full facade sync, so we report the MAX DUST
// CAPACITY (heldNIGHT * 5 per the tokenomics), a meaningful upper bound, and
// flag it as such rather than pretending it's the exact spendable DUST.
//
// Input:  {"seedHex":"<64hex>","network":"preprod"|...,"indexerWsUrl":"wss://…"}
// Output: {"address":"…","nightAtomic":"<bigint>","dustCapacityAtomic":"<bigint>"}
// ============================================================================

import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { getUnshieldedNightBalance } from '../indexer-client.js';

import { claimStdoutForResult } from './cli-io.js';

interface Input {
  seedHex: string;
  network: 'undeployed' | 'preprod' | 'preview' | 'mainnet';
  indexerWsUrl: string;
}

// DUST capacity: 5 DUST per NIGHT (max), per the tokenomics (night_dust_ratio).
const DUST_PER_NIGHT_MAX = 5n;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  // Stdout carries the result and nothing else; what the SDK logs goes with the rest of the diagnostics.
  claimStdoutForResult();
  const input: Input = JSON.parse(await readStdin());
  if (!input.seedHex || !/^[0-9a-fA-F]{64}$/.test(input.seedHex)) {
    throw new Error('seedHex must be 32 bytes (64 hex chars).');
  }
  if (!input.indexerWsUrl) throw new Error('indexerWsUrl is required.');
  const seed = Buffer.from(input.seedHex, 'hex');

  const hd = HDWallet.fromSeed(seed);
  if (hd.type !== 'seedOk') throw new Error(`invalid seed (${JSON.stringify(hd)})`);
  const der = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.NightExternal] as const)
    .deriveKeysAt(0);
  hd.hdWallet.clear();
  if (der.type !== 'keysDerived') throw new Error(`key derivation failed (${JSON.stringify(der)})`);
  const keystore = createKeystore(der.keys[Roles.NightExternal], input.network as never);
  const address = PublicKey.fromKeyStore(keystore).address;

  const result = await getUnshieldedNightBalance(input.indexerWsUrl, address);
  const nightAtomic = result.balance ?? 0n;
  const dustCapacityAtomic = nightAtomic * DUST_PER_NIGHT_MAX;

  process.stdout.write(
    JSON.stringify({
      address,
      nightAtomic: nightAtomic.toString(),
      dustCapacityAtomic: dustCapacityAtomic.toString(),
    }),
  );
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
