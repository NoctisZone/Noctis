// ============================================================================
// Noctis Zone — carry a finished takeover vote through on Cardano (CLI)
// ============================================================================
// The steps cto-vote-steps.ts plans, for a wallet that is not in a browser:
//
//   record    a finalized ballot's result, posting the relayer bond from the
//             payer, whose key the bond returns to. The ballot is what
//             `cto-governance-action`'s `ballot` action prints for the
//             proposal.
//   settle    whichever step the record is waiting for: execute a passed
//             result, mark one that went unexecuted expired, pay the bond
//             back to the payer, or clear the settled result.
//
// The governance script launches were minted with before 2026-09-30 takes a
// result its own way. `earlierScript` records on it (cto-vote-steps.ts's
// anchorWritesCooldown and windowFromStoredWidth) and clears with the
// governor's signature, which `governorSkeyExtendedHex` supplies.
//
// Input, one JSON object on stdin (never argv, which other processes can read):
//   network                'preprod' | 'preview' | 'mainnet'
//   blockfrostProjectId
//   action                 'record' | 'settle'
//   launchIdHex, threadNftPolicyId
//   payerSkeyExtendedHex + payerAddress, or payerMnemonic
//   proposalIdHex, ballot  record only
//   bondLovelace           record only; defaults to the validator's floor
//   earlierScript          see above
//   governorSkeyExtendedHex  settle on the earlier script, when the next step is a clear
//   dryRun                 build and evaluate, sign nothing, submit nothing
//
// Output, one JSON object on stdout.
// ============================================================================

import { deserializeAddress, MeshWallet } from '@meshsdk/core';
import { buildEnterpriseAddress, deserializeTx } from '@meshsdk/core-cst';
import { type AnchoredBallotJson, anchoredBallotFromJson } from '../cto-anchor-reference.js';
import { buildTakeoverTx, submitTakeoverTx, type TakeoverTxPlan } from '../cto-takeover-tx.js';
import {
  bondPayoutAddress,
  planClearResult,
  planExecuteResult,
  planExpireResult,
  planReclaimBond,
  planRecordResult,
  readVoteRecordState,
  voteStage,
} from '../cto-vote-steps.js';
import { KeyCurveSpendWallet } from '../key-curve-spend-wallet.js';
import { type MeshChainProvider, meshCardanoProvider } from '../mesh-cardano-provider.js';
import type { CurveNetwork, CurveSpendWallet, TxCoSigner } from '../mesh-curve-spend.js';
import { MESH_NETWORK_ID, scriptAddressOf } from '../reference-script.js';
import { jsonSafe, loadPlutusBlueprint, loadValidatorCbor, parseJsonStdin, readStdin, requireField } from './cli-io.js';

declare const __dirname: string;

interface Input {
  network: CurveNetwork;
  blockfrostProjectId: string;
  action: 'record' | 'settle';
  launchIdHex: string;
  threadNftPolicyId: string;
  payerSkeyExtendedHex?: string;
  payerAddress?: string;
  payerMnemonic?: string;
  proposalIdHex?: string;
  ballot?: AnchoredBallotJson;
  bondLovelace?: string;
  earlierScript?: boolean;
  governorSkeyExtendedHex?: string;
  dryRun?: boolean;
}

const BLOCKFROST_BASE: Record<CurveNetwork, string> = {
  preview: 'https://cardano-preview.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
};

async function payerWallet(input: Input, provider: MeshChainProvider): Promise<CurveSpendWallet> {
  if (input.payerSkeyExtendedHex || input.payerAddress) {
    return KeyCurveSpendWallet.forAddress({
      address: requireField(input, 'payerAddress'),
      privateKeyExtendedHex: requireField(input, 'payerSkeyExtendedHex'),
      provider,
    });
  }
  const mnemonic = requireField(input, 'payerMnemonic');
  const wallet = new MeshWallet({
    networkId: MESH_NETWORK_ID[input.network],
    fetcher: provider,
    submitter: provider,
    key: { type: 'mnemonic', words: mnemonic.trim().split(/\s+/) },
  });
  await wallet.init();
  return wallet as unknown as CurveSpendWallet;
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  const network = requireField(input, 'network');
  const projectId = requireField(input, 'blockfrostProjectId');
  const action = requireField(input, 'action');
  if (action !== 'record' && action !== 'settle') throw new Error(`action must be record or settle, got ${action}.`);
  const networkId = MESH_NETWORK_ID[network];

  const blueprint = loadPlutusBlueprint(__dirname);
  const governance = loadValidatorCbor(blueprint, 'cto_governance.cto_governance.spend');
  const lpEscrow = loadValidatorCbor(blueprint, 'lp_escrow.lp_escrow.spend');

  const get = async (path: string) => {
    const res = await fetch(`${BLOCKFROST_BASE[network]}/${path}`, { headers: { project_id: projectId } });
    if (!res.ok) throw new Error(`Blockfrost answered ${res.status} for ${path.split('/')[0]}.`);
    return res.json();
  };
  const state = await readVoteRecordState(get, {
    launchIdHex: requireField(input, 'launchIdHex'),
    threadNftPolicyId: requireField(input, 'threadNftPolicyId'),
    addresses: { governance: scriptAddressOf(governance, networkId), lpEscrow: scriptAddressOf(lpEscrow, networkId) },
  });

  const provider = meshCardanoProvider(projectId);
  const wallet = await payerWallet(input, provider);
  const payerAddress = await wallet.getChangeAddress();
  const payerHash = deserializeAddress(payerAddress).pubKeyHash;
  const nowMs = BigInt(Date.now());
  const earlier = input.earlierScript === true;

  let plan: TakeoverTxPlan;
  if (action === 'record') {
    plan = planRecordResult(state, requireField(input, 'proposalIdHex'), anchoredBallotFromJson(input.ballot), {
      nowMs,
      relayerKeyHash: payerHash,
      ...(input.bondLovelace ? { bondLovelace: BigInt(input.bondLovelace) } : {}),
      anchorWritesCooldown: earlier,
      windowFromStoredWidth: earlier,
    });
  } else {
    const stage = voteStage(state.record.datum, nowMs);
    switch (stage.next) {
      case 'execute':
        plan = planExecuteResult(state.record, nowMs);
        break;
      case 'expire':
        plan = planExpireResult(state.record, nowMs);
        break;
      case 'reclaim':
        plan = planReclaimBond(
          state.record,
          bondPayoutAddress(network, stage.kind === 'settled' ? stage.relayerKeyHash : '', payerAddress),
        );
        break;
      case 'clear':
        plan = planClearResult(state.record, { governorSigns: earlier });
        break;
      default:
        // Throws the reason the record is waiting.
        plan = planExecuteResult(state.record, nowMs);
    }
  }

  // Every signature the plan declares has to come from somewhere before a fee
  // is spent on a transaction the node would refuse.
  const coSigners: TxCoSigner[] = [];
  for (const needed of plan.requiredSignerHashes) {
    if (needed === payerHash) continue;
    if (needed === state.record.datum.governor_credential_hash && input.governorSkeyExtendedHex) {
      coSigners.push(
        await KeyCurveSpendWallet.forAddress({
          address: buildEnterpriseAddress(networkId, needed as never)
            .toAddress()
            .toBech32(),
          privateKeyExtendedHex: input.governorSkeyExtendedHex,
          provider,
        }),
      );
      continue;
    }
    throw new Error(
      "This step needs the governor's signature: pay with the governor's key, or give governorSkeyExtendedHex.",
    );
  }

  const config = { network, provider, scripts: { governance: { compiledScriptCbor: governance } } };
  const summary = {
    action: plan.action,
    requiredSigners: plan.requiredSignerHashes,
    fundingLovelace: plan.fundingLovelace,
  };
  if (input.dryRun) {
    const { txHex } = await buildTakeoverTx(plan, wallet, config);
    process.stdout.write(
      JSON.stringify(
        jsonSafe({ ...summary, dryRun: true, feeLovelace: deserializeTx(txHex).body().fee(), bytes: txHex.length / 2 }),
      ),
    );
    return;
  }
  const { txHash } = await submitTakeoverTx(plan, wallet, config, coSigners);
  process.stdout.write(JSON.stringify(jsonSafe({ ...summary, txHash })));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
