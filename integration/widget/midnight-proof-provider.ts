// ============================================================================
// Noctis — the proof provider a browser Midnight action proves through
// ============================================================================
// A connected wallet that implements the DApp connector's getProvingProvider
// proves with whatever its user chose in that wallet. Any other wallet proves
// through the platform's proof server, as before. Both paths end in the same
// call, `unprovenTx.prove(provider, CostModel.initialCostModel())`: Midnight.js's
// proof-server provider makes it with its HTTP prover, and createProofProvider
// makes it with the wallet's, so the transaction a buyer or voter signs has the
// same shape either way.
//
// The wallet's prover is asked for once, the first time a proof is needed.
// When the wallet will not give one, or a proof through it fails, that proof is
// made through the server instead: a wallet that lists the method but cannot
// serve it costs one retry, not the action.
// ============================================================================

import type { KeyMaterialProvider, ProvingProvider as WalletProvingProvider } from '@midnight-ntwrk/dapp-connector-api';
import { createProofProvider, type ProofProvider, type ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types';

/** The one connector method this reads. Optional: only some wallets implement it. */
export interface WalletProvingSource {
  getProvingProvider?: (keyMaterialProvider: KeyMaterialProvider) => Promise<WalletProvingProvider>;
}

/**
 * A proof provider that proves through the wallet when the wallet offers a prover, and through
 * `server` otherwise or whenever the wallet's prover fails.
 *
 * @param wallet - the connected wallet API.
 * @param zkConfigProvider - where the circuits' keys and ZKIR are fetched from; the wallet's prover
 *   reads them through it.
 * @param server - the platform's proof-server provider.
 */
export function walletFirstProofProvider(
  wallet: WalletProvingSource,
  zkConfigProvider: ZKConfigProvider<string>,
  server: ProofProvider,
): ProofProvider {
  const getProvingProvider = wallet.getProvingProvider;
  if (typeof getProvingProvider !== 'function') return server;

  let fromWallet: Promise<ProofProvider | null> | null = null;
  const walletProvider = (): Promise<ProofProvider | null> => {
    fromWallet ??= getProvingProvider
      .call(wallet, zkConfigProvider.asKeyMaterialProvider())
      .then((proving) => createProofProvider(proving))
      .catch(() => null);
    return fromWallet;
  };

  return {
    async proveTx(unprovenTx, proveTxConfig) {
      const viaWallet = await walletProvider();
      if (viaWallet) {
        try {
          return await viaWallet.proveTx(unprovenTx, proveTxConfig);
        } catch {
          // Proved through the server below.
        }
      }
      return server.proveTx(unprovenTx, proveTxConfig);
    },
  };
}
