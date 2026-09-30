// ============================================================================
// Noctis Zone — register the venue's withdraw scripts (CLI)
// ============================================================================
// Registers the reward address of each named venue withdraw script, once per
// network, so the transactions that draw zero from it are accepted. Skips any
// the chain already has, so it is safe to run again. See
// venue-stake-registration.ts for why the deposit cannot be reclaimed.
//
// Input, one JSON object on stdin (never argv, which other processes can read):
//   network                 'preprod' | 'preview' | 'mainnet'
//   blockfrostProjectId
//   payerSkeyExtendedHex + payerAddress, or payerMnemonic
//   scripts                 any of 'royaltyWithdraw' | 'treasury' | 'redirect';
//                           default ['royaltyWithdraw']
//   dryRun                  price it without signing or submitting
//
// Output, one JSON object on stdout.
// ============================================================================

import { BlockfrostProvider, MeshWallet } from '@meshsdk/core';
import { KeyCurveSpendWallet } from '../key-curve-spend-wallet.js';
import type { CurveNetwork, CurveSpendWallet } from '../mesh-curve-spend.js';
import { MESH_NETWORK_ID } from '../reference-script.js';
import { VENUE_ROYALTY_WITHDRAW_TITLE } from '../venue-royalty-withdraw.js';
import { registerVenueStakeScripts } from '../venue-stake-registration.js';
import { jsonSafe, loadAppliedVenueValidator, parseJsonStdin, readStdin, requireField } from './cli-io.js';

declare const __dirname: string;

const SCRIPT_TITLES = {
  royaltyWithdraw: VENUE_ROYALTY_WITHDRAW_TITLE,
  treasury: 'royalty_pool/treasury.treasury.withdraw',
  redirect: 'royalty_pool/redirect.redirect.withdraw',
} as const;
type ScriptName = keyof typeof SCRIPT_TITLES;

interface Input {
  network: CurveNetwork;
  blockfrostProjectId: string;
  payerSkeyExtendedHex?: string;
  payerAddress?: string;
  payerMnemonic?: string;
  scripts?: ScriptName[];
  dryRun?: boolean;
}

const BLOCKFROST_BASE: Record<CurveNetwork, string> = {
  preview: 'https://cardano-preview.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
};

async function payerWallet(input: Input, provider: BlockfrostProvider): Promise<CurveSpendWallet> {
  if (input.payerSkeyExtendedHex || input.payerAddress) {
    return KeyCurveSpendWallet.forAddress({
      address: requireField(input, 'payerAddress'),
      privateKeyExtendedHex: requireField(input, 'payerSkeyExtendedHex'),
      provider,
    });
  }
  const mnemonic = requireField(input, 'payerMnemonic');
  return new MeshWallet({
    networkId: MESH_NETWORK_ID[input.network],
    fetcher: provider,
    submitter: provider,
    key: { type: 'mnemonic', words: mnemonic.trim().split(/\s+/) },
  }) as unknown as CurveSpendWallet;
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  const network = requireField(input, 'network');
  const projectId = requireField(input, 'blockfrostProjectId');
  const names = input.scripts?.length ? input.scripts : (['royaltyWithdraw'] as ScriptName[]);
  for (const name of names) {
    if (!(name in SCRIPT_TITLES))
      throw new Error(`Unknown script "${name}". Known: ${Object.keys(SCRIPT_TITLES).join(', ')}.`);
  }
  const scriptHashes = names.map((name) => loadAppliedVenueValidator(__dirname, SCRIPT_TITLES[name]).hash);

  const provider = new BlockfrostProvider(projectId);
  const result = await registerVenueStakeScripts({
    network,
    scriptHashes,
    wallet: await payerWallet(input, provider),
    provider,
    // A reward address the chain has never seen is a 404; one it has is
    // registered while `active` says so.
    isRegistered: async (rewardAddress) => {
      const res = await fetch(`${BLOCKFROST_BASE[network]}/accounts/${rewardAddress}`, {
        headers: { project_id: projectId },
      });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`Blockfrost answered ${res.status} for ${rewardAddress}.`);
      return ((await res.json()) as { active?: boolean }).active === true;
    },
    dryRun: input.dryRun ?? false,
  });
  process.stdout.write(JSON.stringify(jsonSafe({ scripts: names, scriptHashes, ...result })));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
