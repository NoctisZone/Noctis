import type { ProofProvider, ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types';
import { describe, expect, it, vi } from 'vitest';
import { type WalletProvingSource, walletFirstProofProvider } from '../widget/midnight-proof-provider.js';

// The proof a provider returns stands in for the proven transaction, so each
// test can tell which prover made it.
const SERVER_PROOF = { madeBy: 'server' };
const WALLET_PROOF = { madeBy: 'wallet' };

const keyMaterial = { getZKIR: vi.fn(), getProverKey: vi.fn(), getVerifierKey: vi.fn() };
const zk = { asKeyMaterialProvider: () => keyMaterial } as unknown as ZKConfigProvider<string>;

function serverProvider() {
  return { proveTx: vi.fn(async () => SERVER_PROOF) } as unknown as ProofProvider & {
    proveTx: ReturnType<typeof vi.fn>;
  };
}

/** An unproven transaction that proves through whichever prover it is handed. */
function unprovenTx(walletProver: object, failWith?: Error) {
  return {
    prove: vi.fn(async (prover: object) => {
      if (prover !== walletProver) throw new Error('proved through an unexpected prover');
      if (failWith) throw failWith;
      return WALLET_PROOF;
    }),
  } as never;
}

describe('walletFirstProofProvider', () => {
  it('is the server provider itself when the wallet has no prover to offer', () => {
    const server = serverProvider();
    expect(walletFirstProofProvider({}, zk, server)).toBe(server);
  });

  it("proves through the wallet's prover when the wallet offers one", async () => {
    const prover = { check: vi.fn(), prove: vi.fn() };
    const wallet: WalletProvingSource = { getProvingProvider: vi.fn(async () => prover) };
    const server = serverProvider();
    const tx = unprovenTx(prover);

    await expect(walletFirstProofProvider(wallet, zk, server).proveTx(tx)).resolves.toBe(WALLET_PROOF);
    expect(server.proveTx).not.toHaveBeenCalled();
  });

  it('asks the wallet once, handing it the circuits through the ZK config provider', async () => {
    const prover = { check: vi.fn(), prove: vi.fn() };
    const getProvingProvider = vi.fn(async () => prover);
    const provider = walletFirstProofProvider({ getProvingProvider }, zk, serverProvider());

    await provider.proveTx(unprovenTx(prover));
    await provider.proveTx(unprovenTx(prover));
    expect(getProvingProvider).toHaveBeenCalledTimes(1);
    expect(getProvingProvider).toHaveBeenCalledWith(keyMaterial);
  });

  it('proves through the server when the wallet will not give a prover, and does not ask again', async () => {
    const getProvingProvider = vi.fn(async () => {
      throw new Error('not supported');
    });
    const server = serverProvider();
    const provider = walletFirstProofProvider({ getProvingProvider }, zk, server);

    await expect(provider.proveTx({} as never)).resolves.toBe(SERVER_PROOF);
    await expect(provider.proveTx({} as never)).resolves.toBe(SERVER_PROOF);
    expect(getProvingProvider).toHaveBeenCalledTimes(1);
  });

  it("proves through the server when a proof through the wallet's prover fails", async () => {
    const prover = { check: vi.fn(), prove: vi.fn() };
    const server = serverProvider();
    const provider = walletFirstProofProvider({ getProvingProvider: async () => prover }, zk, server);
    const tx = unprovenTx(prover, new Error('wallet prover failed'));

    await expect(provider.proveTx(tx, { timeout: 5 })).resolves.toBe(SERVER_PROOF);
    expect(server.proveTx).toHaveBeenCalledWith(tx, { timeout: 5 });
  });
});
