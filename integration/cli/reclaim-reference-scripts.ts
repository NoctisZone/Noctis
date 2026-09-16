// ============================================================================
// Noctis Zone — reclaim the deposits behind superseded reference scripts
// ============================================================================
// Every validator change strands the reference script published before it, and
// the deposit behind it — 56 ada for the linear curve curve, 73 for Cardano Launch. This
// spends the stranded ones back.
//
//   list      what the wallet holds, marked current or unrecognised
//   reclaim   spend the named ones back to the wallet
//
// **A script matching any validator a current build compiles to is refused,
// whatever is asked for.** Spending a reference script destroys it, and
// destroying a live one breaks every launch pointing at it, silently, with the
// transaction succeeding. The live set is derived from the compiled bytes of
// every package the platform builds, never taken from the caller.
//
// **And a script nobody named is left alone.** The wallet holds whatever has
// been published from it — now more than one package, and for a parameterised
// validator a script that appears in no blueprint at all, because its bytes
// come from applying a parameter rather than from compiling. Read the listing,
// then name the hashes to reclaim in `approveScriptHashes`. Anything refused
// is reported with the reason rather than dropped.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import { Blockfrost, Lucid } from '@lucid-evolution/lucid';
import {
  findReferenceScripts,
  reclaimable,
  reclaimableLovelace,
  refusedApprovals,
} from '../reference-script-reclaimer.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadDeployedValidators,
  parseJsonStdin,
  readStdin,
  requireField,
} from './cli-io.js';

declare const __dirname: string;

interface Input {
  action: 'list' | 'reclaim';
  network: 'preview' | 'preprod' | 'mainnet';
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /** The wallet that published them, and the only one that can spend them. */
  publisherMnemonic: string;
  /**
   * The script hashes to destroy, read off a `list` run. Nothing is spent
   * without this; a live hash named here is still refused.
   */
  approveScriptHashes?: string[];
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  const action = requireField(input, 'action');
  const network = CARDANO_NETWORK_MAP[requireField(input, 'network')];

  const lucid = await Lucid(
    new Blockfrost(requireField(input, 'blockfrostUrl'), requireField(input, 'blockfrostProjectId')),
    network,
  );
  lucid.selectWallet.fromSeed(requireField(input, 'publisherMnemonic'));
  const address = await lucid.wallet().address();
  const utxos = await lucid.wallet().getUtxos();

  // Lucid's UTXO shape, in the one the reclaimer reads.
  const asMesh = utxos.map((u) => ({
    input: { txHash: u.txHash, outputIndex: u.outputIndex },
    output: {
      address: u.address,
      amount: Object.entries(u.assets).map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
      ...(u.scriptRef ? { scriptRef: u.scriptRef.script } : {}),
    },
  }));

  const approved = input.approveScriptHashes ?? [];
  const found = findReferenceScripts(asMesh, loadDeployedValidators(__dirname));
  const stale = reclaimable(found, approved);
  const refused = refusedApprovals(found, approved);

  const summary = {
    address,
    referenceScripts: found.map((f) => ({
      utxo: `${f.txHash}#${f.outputIndex}`,
      lovelace: f.lovelace,
      scriptHash: f.scriptHash,
      status: f.isCurrent ? `CURRENT (${f.module})` : 'unrecognised — spent only if named',
    })),
    reclaimableLovelace: reclaimableLovelace(found, approved),
    reclaimableCount: stale.length,
    ...(refused.length ? { refused } : {}),
  };

  if (action === 'list') {
    process.stdout.write(JSON.stringify(jsonSafe(summary)));
    return;
  }

  if (stale.length === 0) {
    const message = approved.length
      ? 'Nothing to reclaim — see `refused` for why each named hash was not spent.'
      : 'Nothing to reclaim. Name the hashes to destroy in approveScriptHashes; a script is never spent for merely being unrecognised.';
    process.stdout.write(JSON.stringify(jsonSafe({ ...summary, message })));
    return;
  }

  const keys = new Set(stale.map((f) => `${f.txHash}#${f.outputIndex}`));
  const toSpend = utxos.filter((u) => keys.has(`${u.txHash}#${u.outputIndex}`));

  // No redeemer and no validator: these sit at the wallet's own address, so
  // this is an ordinary payment that happens to destroy the scripts it spends.
  const tx = await lucid.newTx().collectFrom(toSpend).complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  process.stdout.write(JSON.stringify(jsonSafe({ ...summary, txHash, reclaimed: stale.length })));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
