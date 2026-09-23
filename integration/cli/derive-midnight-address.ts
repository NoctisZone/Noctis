// ============================================================================
// Noctis Zone — derive the fundable Midnight (unshielded) address from a
// 32-byte wallet seed. Pure key derivation — NO facade, NO providers, NO sync
// (so it works offline, without the proof-server/indexer being reachable).
//
// Reuses the EXACT same HD derivation buildServerWallet() uses (account 0,
// NightExternal role, deriveKeysAt(0) -> createKeystore). PublicKey.fromKeyStore
// already exposes the bech32m `.address` (and `.addressHex`) directly — this is
// the address the DUST-paying wallet seed must be funded at (send NIGHT here).
//
// Input:  {"seedHex": "<64 hex>", "network": "preprod"|"preview"|"mainnet"|"undeployed"}  on stdin
// Output: {"address": "<bech32m>", "addressHex": "<hex>", "publicKeyHex": "<hex>"}  on stdout
// ============================================================================

import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

import { claimStdoutForResult } from './cli-io.js';

interface Input {
  seedHex: string;
  network: 'undeployed' | 'preprod' | 'preview' | 'mainnet';
}

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
  const pk = PublicKey.fromKeyStore(keystore);

  const pubKeyHex = Buffer.from(pk.publicKey as unknown as Uint8Array).toString('hex');
  process.stdout.write(
    JSON.stringify({
      address: pk.address,
      addressHex: pk.addressHex,
      publicKeyHex: pubKeyHex,
    }),
  );
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
