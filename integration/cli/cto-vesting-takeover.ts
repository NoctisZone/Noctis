// ============================================================================
// Noctis Zone — apply a takeover to a creator's vesting allocation (CLI)
// ============================================================================
// Two actions, both on vesting.ak, both carried out from the governance
// record's last executed vote. See cto-disposition.ts for what each one moves.
//
//   freeze    straight after the takeover executes: stops the creator's
//             schedule.
//   dispose   after the disposition vote executes: sends the frozen
//             allocation where that vote decided.
//
// Who pays, and who else signs:
//   - a freeze, a treasury disposition and a top-up of a running staking pool
//     need no one's signature: any funded wallet pays;
//   - a new staking pool, or a top-up of a pool whose budget ran dry, needs
//     the governor's: pay with the governor's key, or give it as
//     `governorSkeyExtendedHex`;
//   - moving the allocation into liquidity is paid by the community wallet
//     the takeover named, which also supplies the ADA the vote paired.
//
// Input, one JSON object on stdin (never argv, which other processes can read):
//   network                'preprod' | 'preview' | 'mainnet'
//   blockfrostProjectId
//   action                 'freeze' | 'dispose'
//   launchIdHex, threadNftPolicyId
//   payerSkeyExtendedHex + payerAddress, or payerMnemonic
//   governorSkeyExtendedHex   optional co-signer
//   references             { lpEscrow?, stakingPool?, venuePool? }: published
//                          reference pointers { txHash, outputIndex, scriptHash }
//   dryRun                 build and evaluate, sign nothing, submit nothing
//
// Output, one JSON object on stdout.
// ============================================================================

import { BlockfrostProvider, deserializeAddress, MeshWallet } from '@meshsdk/core';
import { buildEnterpriseAddress, deserializeTx } from '@meshsdk/core-cst';
import {
  buildVestingTakeover,
  type DispositionScriptRole,
  type DispositionScriptSource,
  planDisposition,
  planVestingFreeze,
  readVestingTakeoverState,
  submitVestingTakeover,
} from '../cto-disposition.js';
import { KeyCurveSpendWallet } from '../key-curve-spend-wallet.js';
import type { CurveNetwork, CurveSpendWallet, TxCoSigner } from '../mesh-curve-spend.js';
import { MESH_NETWORK_ID, type ReferenceScriptPointer, scriptAddressOf, scriptHashOf } from '../reference-script.js';
import {
  jsonSafe,
  loadAppliedVenueValidator,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireField,
} from './cli-io.js';

declare const __dirname: string;

interface Input {
  network: CurveNetwork;
  blockfrostProjectId: string;
  action: 'freeze' | 'dispose';
  launchIdHex: string;
  threadNftPolicyId: string;
  payerSkeyExtendedHex?: string;
  payerAddress?: string;
  payerMnemonic?: string;
  governorSkeyExtendedHex?: string;
  references?: Partial<Record<'lpEscrow' | 'stakingPool' | 'venuePool', ReferenceScriptPointer>>;
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
  if (action !== 'freeze' && action !== 'dispose') throw new Error(`action must be freeze or dispose, got ${action}.`);
  const networkId = MESH_NETWORK_ID[network];

  const blueprint = loadPlutusBlueprint(__dirname);
  const vesting = loadValidatorCbor(blueprint, 'vesting.vesting.spend');
  const governance = loadValidatorCbor(blueprint, 'cto_governance.cto_governance.spend');
  const lpEscrow = loadValidatorCbor(blueprint, 'lp_escrow.lp_escrow.spend');
  const stakingPool = loadValidatorCbor(blueprint, 'staking_pool.staking_pool.spend');
  const venuePool = loadAppliedVenueValidator(__dirname, 'royalty_pool/pool.pool.spend').compiledCode;

  const get = async (path: string) => {
    const res = await fetch(`${BLOCKFROST_BASE[network]}/${path}`, { headers: { project_id: projectId } });
    if (!res.ok) throw new Error(`Blockfrost answered ${res.status} for ${path.split('/')[0]}.`);
    return res.json();
  };
  const state = await readVestingTakeoverState(get, {
    launchIdHex: requireField(input, 'launchIdHex'),
    threadNftPolicyId: requireField(input, 'threadNftPolicyId'),
    addresses: {
      vesting: scriptAddressOf(vesting, networkId),
      governance: scriptAddressOf(governance, networkId),
      stakingPool: scriptAddressOf(stakingPool, networkId),
      lpEscrow: scriptAddressOf(lpEscrow, networkId),
      venuePool: scriptAddressOf(venuePool, networkId),
    },
  });
  const governanceScriptHash = scriptHashOf(governance);
  const plan =
    action === 'freeze'
      ? planVestingFreeze(state, { governanceScriptHash })
      : planDisposition(state, {
          governanceScriptHash,
          nowMs: Date.now(),
          stakingPoolAddress: scriptAddressOf(stakingPool, networkId),
        });

  const provider = new BlockfrostProvider(projectId);
  const wallet = await payerWallet(input, provider);
  const payerHash = deserializeAddress(await wallet.getChangeAddress()).pubKeyHash;

  // Every signature the plan declares has to come from somewhere before a fee
  // is spent on a transaction the node would refuse.
  const coSigners: TxCoSigner[] = [];
  for (const needed of plan.requiredSignerHashes) {
    if (needed === payerHash) continue;
    if (needed === state.vesting.datum.governor_pub_key_hash && input.governorSkeyExtendedHex) {
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
      needed === state.governance.datum.community_wallet_hash
        ? 'Moving the allocation into liquidity is paid and signed by the community wallet the takeover named. ' +
            'Pay with that wallet.'
        : "This needs the governor's signature: pay with the governor's key, or give governorSkeyExtendedHex.",
    );
  }

  const scripts: Partial<Record<DispositionScriptRole, DispositionScriptSource>> = {
    vesting: { compiledScriptCbor: vesting },
    lpEscrow: { compiledScriptCbor: lpEscrow, referenceScript: input.references?.lpEscrow },
    stakingPool: { compiledScriptCbor: stakingPool, referenceScript: input.references?.stakingPool },
    venuePool: { compiledScriptCbor: venuePool, referenceScript: input.references?.venuePool },
  };
  const config = { network, provider, scripts };
  const summary = {
    action: plan.action,
    moved: plan.moved,
    fundingLovelace: plan.fundingLovelace,
    lp: plan.lp,
    staking: plan.staking,
    requiredSigners: plan.requiredSignerHashes,
  };
  if (input.dryRun) {
    const unsigned = await buildVestingTakeover(plan, wallet, config);
    process.stdout.write(
      JSON.stringify(
        jsonSafe({
          ...summary,
          dryRun: true,
          feeLovelace: deserializeTx(unsigned).body().fee(),
          bytes: unsigned.length / 2,
        }),
      ),
    );
    return;
  }
  const txHash = await submitVestingTakeover(plan, wallet, config, coSigners);
  process.stdout.write(JSON.stringify(jsonSafe({ ...summary, txHash })));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
