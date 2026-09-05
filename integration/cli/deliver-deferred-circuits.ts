// ============================================================================
// Noctis Zone — complete a gate deployed in phases
// ============================================================================
// A deploy writes the contract's whole state in one transaction — the
// constructor's ledger plus a verifier key per circuit — so a contract with
// many circuits arrives in phases. This delivers the rest, one maintenance
// update per circuit, and then reports what the contract holds.
//
// AUTHORITY
// Each update is signed by the maintenance authority the deploy sealed in,
// derived here from the same governor secret and launch id the deploy used. It
// is recomputed rather than stored, so nothing had to survive between the two.
// Supply the wrong secret or launch id and the derived key is simply a
// different key: the node rejects the update rather than applying it.
//
// RESUMABLE
// The plan is computed from what the chain actually holds, so a run that stops
// partway can simply be run again — already-delivered circuits are skipped
// rather than retried, and nothing is delivered twice.
//
// ORDER
// `circuits` is delivered in the order given, so the circuits a launch needs
// soonest can go first. Omit it to deliver everything still missing.
//
// Set NP_TX_COST=1 to have each transaction's real measured cost printed.
//
// Input (stdin JSON):
//   {
//     "network": "preprod" | "preview" | "undeployed",
//     "governorSecretHex": "<64 hex chars>",
//     "walletSeedHex": "<64 hex chars>",
//     "launchIdHex": "<64 hex chars>",
//     "contractAddress": "<contract address>",
//     "zkConfigBasePath": "<local fs path to compiled eligibility_gate ZK artifacts>",
//     "proofServerUrl": "http://...",
//     "circuits": ["recordDarkVeilSettlement", ...],   // optional
//     "verifyOnly": false                              // optional
//   }
// Output (stdout JSON): { ok, delivered[], verification[], complete } or { ok: false, error }
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { Contract as CtoGovernanceContract } from '../../contracts/midnight/compiled/cto_governance/contract/index.js';
import {
  ledger as decodeEligibilityGateLedger,
  Contract as EligibilityGateContract,
} from '../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import { fromHex32 } from '../eligibility-gate-deploy-args.js';
import { describeError } from '../error-detail.js';
import { compileCtoGovernance, compileEligibilityGate } from '../midnight-client.js';
import { deriveContractSigningKey, operationNames } from '../midnight-deploy-subset.js';
import { deliverCircuits, planCircuitDelivery, verifyDeliveredCircuits } from '../midnight-maintenance.js';
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

type DeployedContractKind = 'eligibility_gate' | 'cto_governance';

interface Input extends SnapshotCliInput {
  network: MidnightNetwork;
  governorSecretHex: string;
  walletSeedHex: string;
  /**
   * Which contract sits at the address. Defaults to the eligibility gate.
   * The governance contract publishes no launch id (its `launchId` ledger
   * field is sealed and unexported), so for it `launchIdHex` is REQUIRED —
   * the signing key is derived from it and cannot be recovered from chain.
   */
  contract?: DeployedContractKind;
  /** Optional for the gate: cross-checked against the id the contract itself publishes. */
  launchIdHex?: string;
  contractAddress: string;
  zkConfigBasePath: string;
  proofServerUrl: string;
  /** Deliver only these, in this order. Omit to deliver everything missing. */
  circuits?: string[];
  /** Report what the contract holds and change nothing. */
  verifyOnly?: boolean;
  relayUrl?: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;
  syncTimeoutMs?: number;
}

/**
 * A maintenance update inserts a verifier key; it does not run a circuit, so
 * nothing here ever evaluates a witness. These throw rather than returning a
 * placeholder, so a path that did evaluate one would say so instead of quietly
 * proceeding on an invented value.
 */
const UNUSED_WITNESSES = {
  getUserSecret: () => {
    throw new Error('A maintenance update runs no circuit, so no witness should be evaluated.');
  },
  getMerkleProof: () => {
    throw new Error('A maintenance update runs no circuit, so no witness should be evaluated.');
  },
  getRegistrantMerkleProof: () => {
    throw new Error('A maintenance update runs no circuit, so no witness should be evaluated.');
  },
  getGovernorSecret: () => {
    throw new Error('A maintenance update runs no circuit, so no witness should be evaluated.');
  },
  getBuyNonce: () => {
    throw new Error('A maintenance update runs no circuit, so no witness should be evaluated.');
  },
} as never;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Every circuit this build defines, read off the compiled contract rather than
 * a list kept alongside it — a hand-kept list is one that can disagree with
 * the contract it describes.
 */
function definedCircuits(kind: DeployedContractKind): string[] {
  // `provableCircuits` is the set that gets a verifier key, and the same list
  // the SDK's own contract executable reads — so this is the source the deploy
  // uses rather than a restatement of it that could drift.
  const contract =
    kind === 'cto_governance'
      ? new CtoGovernanceContract(UNUSED_WITNESSES)
      : new EligibilityGateContract(UNUSED_WITNESSES);
  return Object.keys(contract.provableCircuits).sort();
}

function compiledFor(kind: DeployedContractKind) {
  return kind === 'cto_governance' ? compileCtoGovernance(UNUSED_WITNESSES) : compileEligibilityGate(UNUSED_WITNESSES);
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());

  requireFieldsFalsy(input, [
    'network',
    'governorSecretHex',
    'walletSeedHex',
    'contractAddress',
    'zkConfigBasePath',
    'proofServerUrl',
  ]);

  // Cheap checks before expensive ones: the artifacts are delivered by hand and
  // can be a generation behind while everything else passes, and a proof server
  // that is not there costs minutes to discover once proving has started.
  assertZkConfigMatchesBuild(input.zkConfigBasePath);
  await assertProofServerReachable(input.proofServerUrl);

  setNetworkId(input.network);

  const governorSecret = fromHex32(input.governorSecretHex, 'governorSecretHex');
  const walletSeed = fromHex32(input.walletSeedHex, 'walletSeedHex');
  // Optional: the contract publishes its own, and this is only cross-checked
  // against it. Supplying it is a way to assert which launch is being
  // completed, not a way to decide it.
  const kind: DeployedContractKind = input.contract ?? 'eligibility_gate';
  if (kind !== 'eligibility_gate' && kind !== 'cto_governance') {
    throw new Error(`contract must be "eligibility_gate" or "cto_governance", got ${JSON.stringify(input.contract)}.`);
  }
  if (kind === 'cto_governance' && !input.launchIdHex) {
    throw new Error('launchIdHex is required for cto_governance: the contract publishes no launch id to read it from.');
  }
  const launchId = input.launchIdHex ? fromHex32(input.launchIdHex, 'launchIdHex') : undefined;

  const netDefaults =
    input.network === 'mainnet' ? undefined : defaultNetworkConfig(input.network, input.proofServerUrl);
  const relayUrl = input.relayUrl ?? netDefaults?.relayUrl;
  const indexerHttpUrl = input.indexerHttpUrl ?? netDefaults?.indexerHttpUrl;
  const indexerWsUrl = input.indexerWsUrl ?? netDefaults?.indexerWsUrl;
  if (!relayUrl || !indexerHttpUrl || !indexerWsUrl) {
    throw new Error(
      'relayUrl/indexerHttpUrl/indexerWsUrl must be supplied explicitly for network "mainnet" (no confirmed defaults exist yet).',
    );
  }

  const expected = definedCircuits(kind);

  const serverWallet = await buildServerWallet(
    walletSeed,
    { network: input.network, relayUrl, provingServerUrl: input.proofServerUrl, indexerHttpUrl, indexerWsUrl },
    snapshotOptionsFrom(input, 'wallet_seed', (message) => process.stderr.write(`${message}\n`)),
  );

  try {
    // Every update spends a fee, so it proves a DUST spend. Proved against a
    // view of the chain that has moved on, the node refuses it as an invalid
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
    const privateStateProvider = levelPrivateStateProvider({
      privateStateStoreName: 'noctis-deliver-deferred-circuits',
      signingKeyStoreName: 'noctis-deliver-deferred-circuits-signing',
      privateStoragePasswordProvider: ephemeralPrivateStatePassword(),
      accountId: `governor-deliver-${input.contractAddress}`,
      levelFactory: inMemoryLevelFactory(),
    });
    const providers: ContractProviders = {
      privateStateProvider,
      publicDataProvider: indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(input.proofServerUrl, zkConfigProvider),
      walletProvider: serverWallet.walletProvider,
      midnightProvider: serverWallet.midnightProvider,
    };

    const contractState = await providers.publicDataProvider.queryContractState(input.contractAddress);
    if (contractState === null) {
      throw new Error(`No contract found at ${input.contractAddress}. Check the address and the network.`);
    }

    // The launch id comes from the contract's own published certificate, which
    // is written from the id sealed at construction and can only ever be that
    // id. Half the authority is derived from it, so taking it from the chain
    // rather than from an argument means it cannot be given wrongly.
    let signingLaunchId: Uint8Array;
    if (kind === 'eligibility_gate') {
      const onChainLaunchId = decodeEligibilityGateLedger(contractState.data).fairLaunchCert.launchId;
      if (launchId && !bytesEqual(launchId, onChainLaunchId)) {
        throw new Error(
          `launchIdHex does not match the launch this contract was sealed to (${toHex(onChainLaunchId)}). ` +
            'Either the address or the launch id belongs to a different launch.',
        );
      }
      signingLaunchId = onChainLaunchId;
    } else {
      // Refused above when absent, so this is the caller's word: the same id
      // the deploy was given, or the derived key will not match and the
      // update is refused by the chain rather than by us.
      signingLaunchId = launchId as Uint8Array;
    }

    // The authority the deploy sealed in, recomputed from the governor secret
    // and that launch id. The store is in memory and dies with this process,
    // which is exactly why this key is derived rather than sampled.
    await privateStateProvider.setSigningKey(
      input.contractAddress,
      deriveContractSigningKey(governorSecret, signingLaunchId),
    );

    const plan = planCircuitDelivery(operationNames(contractState), expected);

    if (plan.unexpected.length > 0) {
      throw new Error(
        `The deployed contract carries circuits this build does not define (${plan.unexpected.join(', ')}), ` +
          'so the two disagree about what this contract is. Delivering against it would complete a contract ' +
          'that is not the one in this source tree.',
      );
    }

    // Deliver what was asked for, but only what is genuinely still missing —
    // so naming an already-delivered circuit is a no-op rather than an error.
    const requested = input.circuits ?? plan.missing;
    const unknown = requested.filter((name) => !expected.includes(name));
    if (unknown.length > 0) {
      throw new Error(
        `This contract has no circuit named ${unknown.join(', ')}. Its circuits are: ${expected.join(', ')}.`,
      );
    }
    const toDeliver = input.verifyOnly ? [] : requested.filter((name) => plan.missing.includes(name));

    process.stderr.write(
      `${plan.present.length} of ${expected.length} circuits on chain; ${plan.missing.length} missing; delivering ${toDeliver.length}\n`,
    );

    const compiled = compiledFor(kind);

    const delivered = await deliverCircuits(providers, compiled, input.contractAddress, toDeliver, {
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });

    // Re-read from chain rather than reporting what was submitted: the point of
    // this step is what the contract holds, not what we believe we sent it.
    const verification = await verifyDeliveredCircuits(providers, input.contractAddress, expected);
    const complete = verification.every((result) => result.present && result.keyMatches);

    process.stdout.write(
      JSON.stringify(
        jsonSafe({
          ok: true,
          contractAddress: input.contractAddress,
          delivered,
          verification,
          complete,
          stillMissing: verification.filter((r) => !r.present).map((r) => r.circuitId),
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
