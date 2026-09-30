// venue-stake-registration.test.ts
//
// Registering the venue's withdraw scripts: the certificate that needs no
// witness, only for what the chain does not already have, paid without
// touching a reference script.

import { credentialToAddress } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import {
  registerVenueStakeScripts,
  STAKE_REGISTRATION_DEPOSIT_LOVELACE,
  scriptRewardAddress,
} from '../venue-stake-registration.js';

const PAYER = credentialToAddress('Preprod', { type: 'Key', hash: '12'.repeat(28) });
const ROYALTY = 'b6cad7695efd5dcac9eb21a96c846a136057f718c4e6120482afcc9a';
const TREASURY = 'c85a51bc67a1bddbc0cf279c28bbde5a85cbba9d0a853080d4af34a4';

function wallet(): CurveSpendWallet & { signTx: ReturnType<typeof vi.fn>; submitTx: ReturnType<typeof vi.fn> } {
  const utxos: MeshUTxO[] = [
    {
      input: { txHash: 'd1'.repeat(32), outputIndex: 0 },
      output: { address: PAYER, amount: [{ unit: 'lovelace', quantity: '30000000' }] },
    },
    {
      input: { txHash: 'd2'.repeat(32), outputIndex: 0 },
      output: { address: PAYER, amount: [{ unit: 'lovelace', quantity: '900000000' }], scriptRef: '82025901' },
    },
  ];
  return {
    getChangeAddress: vi.fn().mockResolvedValue(PAYER),
    getUtxos: vi.fn().mockResolvedValue(utxos),
    getCollateral: vi.fn(),
    signTx: vi.fn(async (hex: string) => hex),
    submitTx: vi.fn(async () => 'registered-tx'),
  };
}

const provider = { fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS) };

describe('registering the venue withdraw scripts', () => {
  it('derives the reward address a withdraw draws from', () => {
    expect(scriptRewardAddress('preprod', ROYALTY)).toBe(
      'stake_test17zmv44mftm74mjkfavs6jmyydgfkq4lhrrzwvysys2huexsl52mn9',
    );
  });

  it('registers only what the chain does not have, with the certificate that needs no witness', async () => {
    const w = wallet();
    const registered = new Set([scriptRewardAddress('preprod', TREASURY)]);
    const result = await registerVenueStakeScripts({
      network: 'preprod',
      scriptHashes: [ROYALTY, TREASURY],
      wallet: w,
      provider,
      isRegistered: async (address) => registered.has(address),
    });
    expect(result.registering).toEqual([scriptRewardAddress('preprod', ROYALTY)]);
    expect(result.alreadyRegistered).toEqual([scriptRewardAddress('preprod', TREASURY)]);
    expect(result.txHash).toBe('registered-tx');
    expect(result.depositLovelace).toBe(STAKE_REGISTRATION_DEPOSIT_LOVELACE);

    const tx = deserializeTx(w.signTx.mock.calls[0]?.[0] as string);
    const certs = tx.body().certs()?.toCore() ?? [];
    expect(certs).toHaveLength(1);
    // The legacy registration: no deposit field, and so no witness from the script.
    expect(certs[0]?.__typename).toBe('StakeRegistrationCertificate');
    expect(tx.witnessSet().redeemers()).toBeUndefined();
    // Paid from the plain output, never the one carrying a reference script.
    expect(
      tx
        .body()
        .inputs()
        .toCore()
        .map((i) => i.txId),
    ).toEqual(['d1'.repeat(32)]);
  });

  it('builds nothing when everything is registered already', async () => {
    const w = wallet();
    const result = await registerVenueStakeScripts({
      network: 'preprod',
      scriptHashes: [ROYALTY],
      wallet: w,
      provider,
      isRegistered: async () => true,
    });
    expect(result).toEqual({
      registering: [],
      alreadyRegistered: [scriptRewardAddress('preprod', ROYALTY)],
      depositLovelace: 0n,
    });
    expect(w.signTx).not.toHaveBeenCalled();
  });

  it('prices a dry run without signing or submitting', async () => {
    const w = wallet();
    const result = await registerVenueStakeScripts({
      network: 'preprod',
      scriptHashes: [ROYALTY],
      wallet: w,
      provider,
      isRegistered: async () => false,
      dryRun: true,
    });
    expect(result.feeLovelace).toBeGreaterThan(0n);
    expect(result.txHash).toBeUndefined();
    expect(w.signTx).not.toHaveBeenCalled();
    expect(w.submitTx).not.toHaveBeenCalled();
  });
});
