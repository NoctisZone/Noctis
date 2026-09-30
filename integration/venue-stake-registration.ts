// ============================================================================
// Noctis Zone — NoctisSwap: registering the venue's withdraw scripts
// ============================================================================
// Three venue validators run as withdraw scripts: the royalty-withdraw script
// a creator's claim draws on, the treasury script the platform's collection
// draws on, and the redirect a passed takeover draws on. Each runs because a
// transaction withdraws zero from its reward address, and the ledger refuses a
// withdrawal from a reward address that has not been registered. So each has
// to be registered once, on each network, before its first use.
//
// **The certificate is the legacy stake registration**, the one that needs no
// witness from the credential it registers. None of these scripts has a
// certificate handler, so the Conway registration, which asks the script to
// authorise it, would be refused. The same fact means the 2 ADA deposit cannot
// be reclaimed: deregistering would need the script to authorise that too.
//
// **The payment never spends a reference script**, for the same reason the
// creator's placements do not: the paying wallet may hold them.
// ============================================================================

import { credentialToRewardAddress } from '@lucid-evolution/lucid';
import { MeshTxBuilder } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import {
  type CurveNetwork,
  type CurveSpendProvider,
  type CurveSpendWallet,
  spendableForFees,
} from './mesh-curve-spend.js';

const LUCID_NETWORK = { preview: 'Preview', preprod: 'Preprod', mainnet: 'Mainnet' } as const;

/** The protocol's stake-key deposit, which each registration locks. */
export const STAKE_REGISTRATION_DEPOSIT_LOVELACE = 2_000_000n;

/** A script's reward address on a network. */
export function scriptRewardAddress(network: CurveNetwork, scriptHash: string): string {
  return credentialToRewardAddress(LUCID_NETWORK[network], { type: 'Script', hash: scriptHash });
}

export interface VenueStakeRegistrationResult {
  /** Reward addresses this transaction registers. */
  registering: string[];
  /** Reward addresses the chain already had registered, left alone. */
  alreadyRegistered: string[];
  /** Absent when nothing needed registering, or on a dry run. */
  txHash?: string;
  feeLovelace?: bigint;
  depositLovelace: bigint;
}

/**
 * Registers each script's reward address the chain does not already have, in
 * one transaction paid by `wallet`.
 *
 * Already-registered addresses are skipped rather than registered again,
 * which the ledger would refuse, so running this twice is harmless.
 */
export async function registerVenueStakeScripts(args: {
  network: CurveNetwork;
  scriptHashes: readonly string[];
  wallet: CurveSpendWallet;
  provider: CurveSpendProvider;
  isRegistered: (rewardAddress: string) => Promise<boolean>;
  dryRun?: boolean;
}): Promise<VenueStakeRegistrationResult> {
  const registering: string[] = [];
  const alreadyRegistered: string[] = [];
  for (const hash of args.scriptHashes) {
    const address = scriptRewardAddress(args.network, hash);
    if (await args.isRegistered(address)) alreadyRegistered.push(address);
    else registering.push(address);
  }
  if (registering.length === 0) {
    return { registering, alreadyRegistered, depositLovelace: 0n };
  }

  const tx = new MeshTxBuilder({ fetcher: args.provider as never, verbose: false });
  for (const address of registering) tx.registerStakeCertificate(address);
  tx.changeAddress(await args.wallet.getChangeAddress())
    .selectUtxosFrom(spendableForFees(await args.wallet.getUtxos()))
    .setNetwork(args.network);
  const unsigned = await tx.complete();
  const feeLovelace = deserializeTx(unsigned).body().fee();
  const depositLovelace = STAKE_REGISTRATION_DEPOSIT_LOVELACE * BigInt(registering.length);
  if (args.dryRun) {
    return { registering, alreadyRegistered, feeLovelace, depositLovelace };
  }
  const txHash = await args.wallet.submitTx(await args.wallet.signTx(unsigned));
  return { registering, alreadyRegistered, txHash, feeLovelace, depositLovelace };
}
