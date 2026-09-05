// ============================================================================
// Noctis Zone — Stage 3: publish a governor-computed allowlist root
// ============================================================================
// Stage 1 (intake) and Stage 2 (batch tree-building) are built in the
// WordPress plugin's darkveil-registration.php. This CLI is Stage 3: takes
// the pending root that Stage 2 already computed and actually submits
// updateAllowlistRoot(newRoot) on-chain — the piece that was missing
// entirely, since registerForDarkVeil cannot succeed against a root
// that was never published.
//
// Two DIFFERENT secrets are required, and they do not need to match:
//   - governorSecretHex — the Compact WITNESS secret (getGovernorSecret()),
//     checked IN-CIRCUIT against whatever governorKey was pinned when this
//     launch's eligibility_gate.compact instance was deployed. Get this
//     wrong and the call reverts with "Only governor can update allowlist
//     root" — it does not need to be able to pay for anything.
//   - walletSeedHex — a real Midnight HD wallet seed that PAYS the DUST
//     fee for this transaction (integration/midnight-server-wallet.ts).
//     Unrelated to the witness secret; any funded wallet works.
//
// See integration/midnight-server-wallet.ts's own header for the real,
// verified (against midnight-wallet:managing-test-wallets/wallet-sdk
// skills, stable channel only) construction pattern this CLI's wallet half
// relies on.
//
// HONEST SCOPE NOTE: not yet exercised against a live network — needs a
// real operated proof-server and locally-available compiled ZK
// artifacts (zkConfigBasePath below), neither provisioned yet. Same
// "code-complete, blocked on infra" status as widget/midnight-wallet-
// bridge.ts.
//
// Input (stdin JSON):
//   {
//     "network": "preprod" | "preview" | "undeployed",
//     "governorSecretHex": "<64 hex chars>",
//     "walletSeedHex": "<64 hex chars>",
//     "contractAddress": "<bech32m contract address>",
//     "newRootHex": "<64 hex chars>",
//     "zkConfigBasePath": "<local fs path to compiled eligibility_gate ZK artifacts>",
//     "proofServerUrl": "http://...",
//     "relayUrl": "wss://...",        // optional, defaults per network
//     "indexerHttpUrl": "https://...", // optional, defaults per network
//     "indexerWsUrl": "wss://..."      // optional, defaults per network
//   }
// Output (stdout JSON): { ok: true, txId, txHash, blockHeight } or { ok: false, error }
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { NoctisLaunchManager, NoctisMidnightClient } from '../midnight-client.js';
import {
  assertProofServerReachable,
  buildServerWallet,
  defaultNetworkConfig,
  type MidnightNetwork,
  type SnapshotCliInput,
  snapshotOptionsFrom,
  waitForWalletState,
} from '../midnight-server-wallet.js';
import { ephemeralPrivateStatePassword, inMemoryLevelFactory } from '../private-state-store.js';
import { assertZkConfigMatchesBuild } from '../zk-config-fingerprint.js';
import { parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface Input extends SnapshotCliInput {
  network: MidnightNetwork;
  governorSecretHex: string;
  walletSeedHex: string;
  contractAddress: string;
  newRootHex: string;
  zkConfigBasePath: string;
  proofServerUrl: string;
  relayUrl?: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;
  /**
   * How long to allow the governor wallet to reach the chain head. This call
   * pays a fee, so it proves a DUST spend, and a proof built against a stale
   * view of the chain is one the node refuses as invalid.
   */
  syncTimeoutMs?: number;
}

function fromHex(hex: string, label: string): Uint8Array {
  if (hex.length !== 64) {
    throw new Error(`${label}: expected 64 hex chars (32 bytes), got ${hex.length}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Input>(raw);

  requireFieldsFalsy(input, [
    'network',
    'governorSecretHex',
    'walletSeedHex',
    'contractAddress',
    'newRootHex',
    'zkConfigBasePath',
    'proofServerUrl',
  ]);

  // Before the wallet, the network, or anything that costs time: are these the
  // compiled artifacts this bundle was built for? The tree is not git-tracked,
  // so it is delivered by hand and can be absent or a generation behind while
  // every other check passes. Failing here names the artifacts; failing later
  // names a proof.
  assertZkConfigMatchesBuild(input.zkConfigBasePath, 'eligibility_gate');

  // Same principle: cheap checks before expensive ones.
  await assertProofServerReachable(input.proofServerUrl);

  setNetworkId(input.network);

  const governorSecret = fromHex(input.governorSecretHex, 'governorSecretHex');
  const walletSeed = fromHex(input.walletSeedHex, 'walletSeedHex');
  const newRoot = fromHex(input.newRootHex, 'newRootHex');

  const netDefaults =
    input.network === 'mainnet' ? undefined : defaultNetworkConfig(input.network, input.proofServerUrl);
  const networkConfig = {
    network: input.network,
    relayUrl: input.relayUrl ?? netDefaults?.relayUrl,
    provingServerUrl: input.proofServerUrl,
    indexerHttpUrl: input.indexerHttpUrl ?? netDefaults?.indexerHttpUrl,
    indexerWsUrl: input.indexerWsUrl ?? netDefaults?.indexerWsUrl,
  };
  if (!networkConfig.relayUrl || !networkConfig.indexerHttpUrl || !networkConfig.indexerWsUrl) {
    throw new Error(
      'relayUrl/indexerHttpUrl/indexerWsUrl must be supplied explicitly for network "mainnet" (no confirmed defaults exist yet).',
    );
  }

  // Resuming from a snapshot turns this from a full chain replay into a short
  // catch-up. Without one the wait below is the whole history.
  const serverWallet = await buildServerWallet(
    walletSeed,
    {
      network: networkConfig.network,
      relayUrl: networkConfig.relayUrl,
      provingServerUrl: networkConfig.provingServerUrl,
      indexerHttpUrl: networkConfig.indexerHttpUrl,
      indexerWsUrl: networkConfig.indexerWsUrl,
    },
    snapshotOptionsFrom(input, 'wallet_seed', (message) => process.stderr.write(`${message}\n`)),
  );

  try {
    // Publishing a root costs a fee, so it proves a DUST spend. Proved against
    // a view of the chain that has moved on, the node refuses it as an invalid
    // proof — a failure that names the proof rather than the staleness behind
    // it. Same wait the deploy makes, for the same reason.
    process.stderr.write('waiting for the governor wallet to catch up to the chain head\n');
    await waitForWalletState(
      serverWallet.facade,
      (state) => state.isSynced && state.dust.balance(new Date()) > 0n,
      input.syncTimeoutMs ?? 900_000,
      'the governor wallet to reach the chain head with spendable DUST',
    );

    const zkConfigProvider = new NodeZkConfigProvider(input.zkConfigBasePath);
    const providers: ContractProviders = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: 'noctis-governor-publish-allowlist-root',
        signingKeyStoreName: 'noctis-governor-publish-allowlist-root-signing',
        // One-shot CLI process — private state never needs to survive past
        // this call, so an in-memory store (never touches disk) is correct
        // here, unlike a real user session's persistent browser store.
        privateStoragePasswordProvider: ephemeralPrivateStatePassword(),
        accountId: `governor-allowlist-publish-${input.contractAddress}`,
        levelFactory: inMemoryLevelFactory(),
      }),
      publicDataProvider: indexerPublicDataProvider(networkConfig.indexerHttpUrl, networkConfig.indexerWsUrl),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(networkConfig.provingServerUrl, zkConfigProvider),
      walletProvider: serverWallet.walletProvider,
      midnightProvider: serverWallet.midnightProvider,
    };

    // Governor-only circuit — pass the governor secret as BOTH the user and
    // governor witness (matches NoctisMidnightClient's own documented
    // default, since no user-side circuit is being called here).
    const client = new NoctisMidnightClient({ bytes: governorSecret });
    // Empty/zero placeholders for the user-witness triple
    // (merkleProof/buyNonce/registrationNonce) — connectEligibilityGate
    // requires concrete values for every declared witness even though
    // updateAllowlistRoot never reads them.
    await client.connectEligibilityGate(providers, input.contractAddress, [], new Uint8Array(32));

    const manager = new NoctisLaunchManager(client);
    // ONE attestor's call. The root moves only once the threshold is met by
    // distinct attestors inside the expiry window, so a single run of this CLI
    // is expected NOT to change it — run it again as the second attestor.
    const currentTimestampSeconds = BigInt(Math.floor(Date.now() / 1000));
    const result = await manager.updateAllowlistRoot(newRoot, currentTimestampSeconds);

    process.stdout.write(
      JSON.stringify({
        ok: true,
        txId: result.public.txId,
        txHash: result.public.txHash,
        blockHeight: result.public.blockHeight,
      }),
    );
  } finally {
    await serverWallet.shutdown();
  }
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exitCode = 1;
});
