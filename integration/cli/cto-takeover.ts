// ============================================================================
// Noctis Zone — apply a community takeover to a launch's contracts (CLI)
// ============================================================================
// Executing a vote changes the launch's governance record; each contract then
// applies it in a transaction of its own. See cto-takeover-effects.ts and
// cto-disposition.ts for what each one moves.
//
//   apply     after a takeover, or a dissolve, executes: every contract the
//             record's state has not reached yet, one transaction each —
//             the curve, the LP escrow, token metadata, vesting, and the
//             pool's royalty key. Run it straight after the vote executes,
//             and again until it reports nothing left to apply.
//   dispose   after the disposition vote executes: sends the frozen
//             allocation where that vote decided.
//
// Who pays, and who else signs:
//   - `apply`, a treasury disposition and a top-up of a running staking pool
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
//   action                 'apply' | 'dispose'
//   launchIdHex, threadNftPolicyId
//   payerSkeyExtendedHex + payerAddress, or payerMnemonic
//   governorSkeyExtendedHex   optional co-signer
//   royaltyPubKeyHex       apply only: the key the pool's royalty moves to —
//                          the community wallet's public key on a takeover,
//                          the creator's on a dissolve. Without it the pool is
//                          reported and left.
//   references             published reference pointers { txHash,
//                          outputIndex, scriptHash }, keyed curve, lpEscrow,
//                          stakingPool, venuePool
//   dryRun                 build and evaluate, sign nothing, submit nothing
//
// Output, one JSON object on stdout.
// ============================================================================

import { deserializeAddress, MeshWallet } from '@meshsdk/core';
import { buildEnterpriseAddress, deserializeTx } from '@meshsdk/core-cst';
import { planDisposition, readVestingTakeoverState, type VestingTakeoverPlan } from '../cto-disposition.js';
import { planTakeoverEffects, readTakeoverEffectsState, type TakeoverEffectPlan } from '../cto-takeover-effects.js';
import {
  buildTakeoverTx,
  submitTakeoverTx,
  type TakeoverScriptRole,
  type TakeoverScriptSource,
  type TakeoverTxPlan,
} from '../cto-takeover-tx.js';
import { KeyCurveSpendWallet } from '../key-curve-spend-wallet.js';
import { type MeshChainProvider, meshCardanoProvider } from '../mesh-cardano-provider.js';
import type { CurveNetwork, CurveSpendWallet, TxCoSigner } from '../mesh-curve-spend.js';
import { MESH_NETWORK_ID, type ReferenceScriptPointer, scriptAddressOf, scriptHashOf } from '../reference-script.js';
import { scriptRewardAddress } from '../venue-stake-registration.js';
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
  action: 'apply' | 'dispose';
  launchIdHex: string;
  threadNftPolicyId: string;
  payerSkeyExtendedHex?: string;
  payerAddress?: string;
  payerMnemonic?: string;
  governorSkeyExtendedHex?: string;
  royaltyPubKeyHex?: string;
  references?: Partial<Record<'curve' | 'lpEscrow' | 'stakingPool' | 'venuePool', ReferenceScriptPointer>>;
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
  if (action !== 'apply' && action !== 'dispose') throw new Error(`action must be apply or dispose, got ${action}.`);
  const launchIdHex = requireField(input, 'launchIdHex');
  const threadNftPolicyId = requireField(input, 'threadNftPolicyId');
  const networkId = MESH_NETWORK_ID[network];

  const blueprint = loadPlutusBlueprint(__dirname);
  const code = {
    curve: loadValidatorCbor(blueprint, 'bonding_curve_tier_b.bonding_curve_tier_b.spend'),
    governance: loadValidatorCbor(blueprint, 'cto_governance.cto_governance.spend'),
    lpEscrow: loadValidatorCbor(blueprint, 'lp_escrow.lp_escrow.spend'),
    tokenMetadata: loadValidatorCbor(blueprint, 'token_metadata.token_metadata.spend'),
    vesting: loadValidatorCbor(blueprint, 'vesting.vesting.spend'),
    stakingPool: loadValidatorCbor(blueprint, 'staking_pool.staking_pool.spend'),
    venuePool: loadAppliedVenueValidator(__dirname, 'royalty_pool/pool.pool.spend').compiledCode,
    redirect: loadAppliedVenueValidator(__dirname, 'royalty_pool/redirect.redirect.withdraw').compiledCode,
  };
  const address = (script: string) => scriptAddressOf(script, networkId);
  const governanceScriptHash = scriptHashOf(code.governance);

  const get = async (path: string) => {
    const res = await fetch(`${BLOCKFROST_BASE[network]}/${path}`, { headers: { project_id: projectId } });
    if (!res.ok) throw new Error(`Blockfrost answered ${res.status} for ${path.split('/')[0]}.`);
    return res.json();
  };

  const skipped: Array<{ effect: string; reason: string }> = [];
  let plans: TakeoverTxPlan[];
  let governor = '';
  let community = '';
  if (action === 'apply') {
    const state = await readTakeoverEffectsState(get, {
      launchIdHex,
      threadNftPolicyId,
      addresses: {
        governance: address(code.governance),
        curve: address(code.curve),
        lpEscrow: address(code.lpEscrow),
        tokenMetadata: address(code.tokenMetadata),
        vesting: address(code.vesting),
        venuePool: address(code.venuePool),
      },
    });
    const planned = planTakeoverEffects(state, { governanceScriptHash, royaltyPubKeyHex: input.royaltyPubKeyHex });
    skipped.push(...planned.skipped);
    plans = planned.plans;
    // A withdraw-zero from a reward address the chain has never registered is
    // refused, so the pool waits until the redirect is registered.
    const redirectAddress = scriptRewardAddress(network, scriptHashOf(code.redirect));
    if (plans.some((p) => p.withdrawal) && !(await registered(get, redirectAddress))) {
      plans = plans.filter((p) => !p.withdrawal);
      skipped.push({
        effect: 'poolRoyalty',
        reason: `the venue redirect's reward address ${redirectAddress} is not registered; register it with register-venue-scripts`,
      });
    }
  } else {
    const state = await readVestingTakeoverState(get, {
      launchIdHex,
      threadNftPolicyId,
      addresses: {
        vesting: address(code.vesting),
        governance: address(code.governance),
        stakingPool: address(code.stakingPool),
        lpEscrow: address(code.lpEscrow),
        venuePool: address(code.venuePool),
      },
    });
    governor = state.vesting.datum.governor_pub_key_hash;
    community = state.governance.datum.community_wallet_hash;
    plans = [
      planDisposition(state, {
        governanceScriptHash,
        nowMs: Date.now(),
        stakingPoolAddress: address(code.stakingPool),
      }),
    ];
  }

  const provider = meshCardanoProvider(projectId);
  const wallet = await payerWallet(input, provider);
  const payerHash = deserializeAddress(await wallet.getChangeAddress()).pubKeyHash;

  const refs = input.references ?? {};
  const scripts: Partial<Record<TakeoverScriptRole, TakeoverScriptSource>> = {
    curve: { compiledScriptCbor: code.curve, referenceScript: refs.curve },
    lpEscrow: { compiledScriptCbor: code.lpEscrow, referenceScript: refs.lpEscrow },
    tokenMetadata: { compiledScriptCbor: code.tokenMetadata },
    vesting: { compiledScriptCbor: code.vesting },
    stakingPool: { compiledScriptCbor: code.stakingPool, referenceScript: refs.stakingPool },
    venuePool: { compiledScriptCbor: code.venuePool, referenceScript: refs.venuePool },
    redirect: { compiledScriptCbor: code.redirect },
  };
  const config = { network, provider, scripts };

  const results: Record<string, unknown>[] = [];
  const spent = new Set<string>();
  for (const plan of plans) {
    const summary: Record<string, unknown> = {
      action: plan.action,
      requiredSigners: plan.requiredSignerHashes,
      fundingLovelace: plan.fundingLovelace,
      ...('moved' in plan
        ? {
            moved: (plan as VestingTakeoverPlan).moved,
            lp: (plan as VestingTakeoverPlan).lp,
            staking: (plan as VestingTakeoverPlan).staking,
          }
        : {}),
    };
    try {
      // Every signature the plan declares has to come from somewhere before a
      // fee is spent on a transaction the node would refuse.
      const coSigners: TxCoSigner[] = [];
      for (const needed of plan.requiredSignerHashes) {
        if (needed === payerHash) continue;
        if (needed === governor && input.governorSkeyExtendedHex) {
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
          needed === community
            ? 'Moving the allocation into liquidity is paid and signed by the community wallet the takeover ' +
                'named. Pay with that wallet.'
            : "This needs the governor's signature: pay with the governor's key, or give governorSkeyExtendedHex.",
        );
      }
      if (input.dryRun) {
        const { txHex } = await buildTakeoverTx(plan, wallet, config);
        results.push({
          ...summary,
          dryRun: true,
          feeLovelace: deserializeTx(txHex).body().fee(),
          bytes: txHex.length / 2,
        });
        continue;
      }
      // Each transaction pays from outputs the ones before it in this run left
      // alone, since the chain has not indexed their change yet.
      const { txHash, fundingInputs } = await submitTakeoverTx(plan, wallet, config, coSigners, {
        excludeInputs: spent,
      });
      for (const k of fundingInputs) spent.add(k);
      results.push({ ...summary, txHash });
    } catch (err) {
      results.push({ ...summary, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const effects = (p: TakeoverTxPlan) => (p as TakeoverEffectPlan).effect;
  process.stdout.write(
    JSON.stringify(
      jsonSafe({
        action,
        applied: results,
        skipped,
        ...(action === 'apply' ? { planned: plans.map(effects) } : {}),
      }),
    ),
  );
  if (results.some((r) => 'error' in r)) process.exitCode = 1;
}

/** Whether the chain has registered this reward address. */
async function registered(get: (path: string) => Promise<unknown>, rewardAddress: string): Promise<boolean> {
  try {
    const account = (await get(`accounts/${rewardAddress}`)) as { registered?: boolean; active?: boolean };
    return account.registered ?? account.active === true;
  } catch (err) {
    if (/\b404\b/.test(String(err))) return false;
    throw err;
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
