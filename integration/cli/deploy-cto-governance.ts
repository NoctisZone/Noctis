// ============================================================================
// Noctis Zone — deploy cto_governance.compact for one launch
// ============================================================================
// The same shape as deploy-eligibility-gate.ts: one JSON object on stdin
// (never argv — secrets travel by pipe), one JSON object on stdout.
//
// The contract carries 25 circuits, and a deploy naming every one exceeds the
// block's write budget (see local/DEPLOY_WRITE_BUDGET.md and the eligibility
// gate's two-phase deploy). Name the circuits to leave out in `deferCircuits`
// and deliver them afterwards with deliver-deferred-circuits
// (`contract: "cto_governance"`), signed by the same governor secret and
// launch id — the deploy signing key is derived from both, so a later process
// can reproduce it.
//
// Rehearsal note: `minPostGradDelay` is 90 days from `graduationTimestamp`,
// sealed at deploy. A Preprod rehearsal that wants to file a proposal today
// deploys with a graduation timestamp at least 90 days in the past — the
// same backdating the curve-expiry rehearsal used — and the SHIPPING
// validator is still what runs.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { type CtoGovernanceDeployInput, resolveCtoGovernanceDeployArgs } from '../cto-governance-deploy-args.js';
import { fromHex32 } from '../eligibility-gate-deploy-args.js';
import { describeError } from '../error-detail.js';
import { NoctisMidnightClient } from '../midnight-client.js';
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
import { jsonSafe, parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface Input extends SnapshotCliInput, CtoGovernanceDeployInput {
  network: MidnightNetwork;
  governorSecretHex: string;
  walletSeedHex: string;
  proofServerUrl: string;
  zkConfigBasePath: string;
  relayUrl?: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;
  deferCircuits?: string[];
  syncTimeoutMs?: number;
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());

  requireFieldsFalsy(input, [
    'network',
    'governorSecretHex',
    'walletSeedHex',
    'proofServerUrl',
    'zkConfigBasePath',
    'launchIdHex',
    'totalSupply',
    'graduationTimestamp',
    'creatorPubKeyHex',
    'breakGlassBondMin',
    'platformAddrHex',
    'attestorKeysHex',
    'attestThreshold',
  ]);

  // Resolved before anything is spent, so a bad argument is a message naming
  // the field rather than a refused deploy.
  const args = resolveCtoGovernanceDeployArgs(input);

  assertZkConfigMatchesBuild(input.zkConfigBasePath, 'cto_governance');
  await assertProofServerReachable(input.proofServerUrl);
  setNetworkId(input.network);

  const governorSecret = fromHex32(input.governorSecretHex, 'governorSecretHex');
  const walletSeed = fromHex32(input.walletSeedHex, 'walletSeedHex');

  const netDefaults =
    input.network === 'mainnet' ? undefined : defaultNetworkConfig(input.network, input.proofServerUrl);
  const relayUrl = input.relayUrl ?? netDefaults?.relayUrl;
  const indexerHttpUrl = input.indexerHttpUrl ?? netDefaults?.indexerHttpUrl;
  const indexerWsUrl = input.indexerWsUrl ?? netDefaults?.indexerWsUrl;
  if (!relayUrl || !indexerHttpUrl || !indexerWsUrl) {
    throw new Error(`relayUrl/indexerHttpUrl/indexerWsUrl must be supplied explicitly for network "${input.network}".`);
  }

  const serverWallet = await buildServerWallet(
    walletSeed,
    { network: input.network, relayUrl, provingServerUrl: input.proofServerUrl, indexerHttpUrl, indexerWsUrl },
    snapshotOptionsFrom(input, 'wallet_seed', (message) => process.stderr.write(`${message}\n`)),
  );

  try {
    process.stderr.write('waiting for the funding wallet to catch up to the chain head\n');
    const ready = await waitForWalletState(
      serverWallet.facade,
      (state) => state.isSynced && state.dust.balance(new Date()) > 0n,
      input.syncTimeoutMs ?? 900_000,
      'the funding wallet to reach the chain head with spendable DUST',
    );
    process.stderr.write(`caught up; spendable DUST ${ready.dust.balance(new Date())}\n`);

    const zkConfigProvider = new NodeZkConfigProvider(input.zkConfigBasePath);
    const providers: ContractProviders = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: 'noctis-deploy-cto-governance',
        signingKeyStoreName: 'noctis-deploy-cto-governance-signing',
        privateStoragePasswordProvider: ephemeralPrivateStatePassword(),
        accountId: `deploy-cto-governance-${input.launchIdHex}`,
        levelFactory: inMemoryLevelFactory(),
      }),
      publicDataProvider: indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(input.proofServerUrl, zkConfigProvider),
      walletProvider: serverWallet.walletProvider,
      midnightProvider: serverWallet.midnightProvider,
    };

    const client = new NoctisMidnightClient({ bytes: governorSecret }, { bytes: governorSecret });
    const record = await client.deployCtoGovernance(providers, args, input.deferCircuits ?? []);

    process.stdout.write(
      JSON.stringify(
        jsonSafe({
          ok: true,
          contractAddress: record.contractAddress,
          launchIdHex: input.launchIdHex,
          maxVoterCap: args.maxVoterCap.toString(),
          minVoterCount: args.minVoterCount.toString(),
          ...(record.pendingCircuits ? { pendingCircuits: record.pendingCircuits } : {}),
          note: record.pendingCircuits
            ? 'Record contractAddress against the launch as cto_governance_contract_address. This contract does ' +
              'not yet answer the circuits in pendingCircuits: deliver their verifier keys with ' +
              'deliver-deferred-circuits (contract: "cto_governance") using the same governor secret and launch id.'
            : 'Record contractAddress against the launch as cto_governance_contract_address.',
        }),
      ),
    );
  } finally {
    await serverWallet.shutdown();
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: describeError(err) }));
  process.exitCode = 1;
});
