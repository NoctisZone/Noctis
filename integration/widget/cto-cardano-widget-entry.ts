// ============================================================================
// Noctis — takeover vote, Cardano steps: browser entry point
// ============================================================================
// webpack browser target (see ../webpack.widgets.config.cjs's
// cto-cardano-widget block), bundled to assets/js/cto-cardano-widget.bundle.js
// in the theme. The takeover-vote panel loads it on demand, when a holder
// opens a finished vote's Cardano steps: it carries Mesh, which voting on
// Midnight has no use for.
//
// Exposes window.NoctisCtoCardano. Every step is signed and paid for by the
// wallet the holder connects, usually the vote's proposer, never by the
// platform (cto-vote-steps.ts lists the steps). Recording a result posts the
// relayer bond, which comes back to the same key once the result settles.
// Everything it reads goes through the site's Blockfrost proxy.
//
// The ballot a result is recorded from comes from the Midnight bundle
// (window.NoctisCto.ballotForCardano), which reads it off Midnight; the page
// hands it across as it is.
// ============================================================================

import { getAddressDetails, type Network as LucidNetwork, type WalletApi } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { CtoGovernanceDatumData } from '../cardano-cto-anchor-submitter.js';
import { Cip30CurveSpendWallet } from '../cip30-curve-spend-wallet.js';
import type { AnchoredBallot } from '../cto-anchor-reference.js';
import {
  planDisposition,
  previewLpDisposition,
  readVestingTakeoverState,
  type VestingTakeoverPlan,
} from '../cto-disposition.js';
import { royaltyKeyAmong } from '../cto-royalty-key.js';
import {
  planTakeoverEffects,
  readTakeoverEffectsState,
  type TakeoverEffectPlan,
  takeoverDirectionOf,
} from '../cto-takeover-effects.js';
import {
  submitTakeoverTx,
  type TakeoverScriptRole,
  type TakeoverScriptSource,
  type TakeoverTxPlan,
} from '../cto-takeover-tx.js';
import {
  bondPayoutAddress,
  type GovernanceRecord,
  planClearResult,
  planExecuteResult,
  planExpireResult,
  planReclaimBond,
  planRecordResult,
  readVoteRecordState,
  type VoteStage,
  voteStage,
} from '../cto-vote-steps.js';
import type { CurveNetwork } from '../mesh-curve-spend.js';
import { MESH_NETWORK_ID, type ReferenceScriptPointer, scriptAddressOf, scriptHashOf } from '../reference-script.js';
import { meshBlockfrostProvider } from '../tier-b-curve-submitter.js';
import { readCoseKeyX } from '../venue-royalty-withdraw.js';
import { scriptRewardAddress } from '../venue-stake-registration.js';

export interface CtoCardanoWidgetConfig {
  /** The site's Blockfrost proxy route. */
  blockfrostUrl: string;
  /** A placeholder: the proxy adds the real key. See blockfrost-proxy.php. */
  blockfrostProjectId: string;
  network: LucidNetwork;
  /** Compiled code, read server-side from the launch blueprint and the venue's applied record. */
  scripts: {
    governance: string;
    curve: string;
    lpEscrow: string;
    tokenMetadata: string;
    vesting: string;
    stakingPool: string;
    venuePool?: string;
    redirect?: string;
  };
  /** Where the larger scripts are published, from the platform's settings. */
  references?: Partial<Record<'curve' | 'lpEscrow' | 'stakingPool' | 'venuePool', ReferenceScriptPointer>>;
}

export interface LaunchRef {
  launchIdHex: string;
  /** From the platform's own record of the launch, so every read is authenticated. */
  threadNftPolicyId: string;
}

const CURVE_NETWORK: Partial<Record<LucidNetwork, CurveNetwork>> = {
  Preview: 'preview',
  Preprod: 'preprod',
  Mainnet: 'mainnet',
};

let config: CtoCardanoWidgetConfig | null = null;

function requireConfigured(): { cfg: CtoCardanoWidgetConfig; network: CurveNetwork } {
  if (!config) throw new Error('NoctisCtoCardano.configure() must be called first.');
  const network = CURVE_NETWORK[config.network];
  if (!network) throw new Error(`Unknown network "${config.network}".`);
  return { cfg: config, network };
}

function reader(cfg: CtoCardanoWidgetConfig) {
  return async (path: string) => {
    const res = await fetch(`${cfg.blockfrostUrl}/${path}`);
    if (!res.ok) throw new Error(`The chain could not be read just now (${res.status}). Try again shortly.`);
    return res.json();
  };
}

function addresses(cfg: CtoCardanoWidgetConfig, network: CurveNetwork) {
  const at = (script: string) => scriptAddressOf(script, MESH_NETWORK_ID[network]);
  return {
    governance: at(cfg.scripts.governance),
    curve: at(cfg.scripts.curve),
    lpEscrow: at(cfg.scripts.lpEscrow),
    tokenMetadata: at(cfg.scripts.tokenMetadata),
    vesting: at(cfg.scripts.vesting),
    stakingPool: at(cfg.scripts.stakingPool),
    venuePool: cfg.scripts.venuePool ? at(cfg.scripts.venuePool) : '',
  };
}

function builderConfig(cfg: CtoCardanoWidgetConfig, network: CurveNetwork) {
  const refs = cfg.references ?? {};
  const scripts: Partial<Record<TakeoverScriptRole, TakeoverScriptSource>> = {
    governance: { compiledScriptCbor: cfg.scripts.governance },
    curve: { compiledScriptCbor: cfg.scripts.curve, referenceScript: refs.curve },
    lpEscrow: { compiledScriptCbor: cfg.scripts.lpEscrow, referenceScript: refs.lpEscrow },
    tokenMetadata: { compiledScriptCbor: cfg.scripts.tokenMetadata },
    vesting: { compiledScriptCbor: cfg.scripts.vesting },
    stakingPool: { compiledScriptCbor: cfg.scripts.stakingPool, referenceScript: refs.stakingPool },
    ...(cfg.scripts.venuePool
      ? { venuePool: { compiledScriptCbor: cfg.scripts.venuePool, referenceScript: refs.venuePool } }
      : {}),
    ...(cfg.scripts.redirect ? { redirect: { compiledScriptCbor: cfg.scripts.redirect } } : {}),
  };
  return { network, provider: meshBlockfrostProvider(cfg), scripts };
}

async function readRecord(launch: LaunchRef) {
  const { cfg, network } = requireConfigured();
  const a = addresses(cfg, network);
  return readVoteRecordState(reader(cfg), {
    ...launch,
    addresses: { governance: a.governance, lpEscrow: a.lpEscrow },
  });
}

async function paymentKeyHashOf(wallet: Cip30CurveSpendWallet): Promise<string> {
  const hash = getAddressDetails(await wallet.getChangeAddress()).paymentCredential?.hash;
  if (!hash) throw new Error('The connected wallet has no payment key.');
  return hash;
}

/** Plain values for the page: every amount and time as a decimal string. */
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function describeRecord(g: CtoGovernanceDatumData, stage: VoteStage) {
  const p = g.active_proposal;
  return plain({
    stage: { ...stage, proposal: undefined },
    ctoState: g.cto_state,
    communityWalletHash: g.community_wallet_hash,
    proposalCount: g.proposal_count,
    lastBallotEndMs: g.last_ballot_end_timestamp,
    lastExecuted: g.last_executed_proposal?.proposal_type ?? null,
    result: p
      ? {
          type: p.proposal_type,
          outcome: p.outcome,
          status: p.execution_status,
          startMs: p.start_timestamp,
          endMs: p.end_timestamp,
          recordedMs: p.anchor_timestamp,
          yesVotes: p.yes_votes,
          noVotes: p.no_votes,
          voterCount: p.voter_count,
          payeeHash: p.allocation_recipient_hash,
          amount: p.allocation_amount,
          relayerKeyHash: p.relayer_credential_hash,
        }
      : null,
  });
}

/** The key the pool's royalty moves to, if the connected wallet holds it: its public key, from `signData`. */
async function royaltyKeyFrom(api: WalletApi, expectedHash: string, launchIdHex: string): Promise<string | undefined> {
  const wallet = new Cip30CurveSpendWallet(api as never);
  if ((await paymentKeyHashOf(wallet)) !== expectedHash) return undefined;
  const message = `Noctis: this wallet's key receives launch ${launchIdHex}'s pool royalty.`;
  const signed = await api.signData(await api.getChangeAddress(), bytesToHex(new TextEncoder().encode(message)));
  const key = bytesToHex(readCoseKeyX(signed.key));
  return bytesToHex(blake2b(hexToBytes(key), { dkLen: 28 })) === expectedHash ? key : undefined;
}

async function registered(get: (path: string) => Promise<unknown>, rewardAddress: string): Promise<boolean> {
  try {
    const account = (await get(`accounts/${rewardAddress}`)) as { registered?: boolean; active?: boolean };
    return account.registered ?? account.active === true;
  } catch (err) {
    if (/\b404\b/.test(String(err))) return false;
    throw err;
  }
}

const NoctisCtoCardano = {
  configure(cfg: CtoCardanoWidgetConfig): void {
    config = cfg;
  },

  /** Where the launch's governance record stands, and the step that comes next. */
  async status(launch: LaunchRef & { nowMs?: number }) {
    const state = await readRecord(launch);
    const stage = voteStage(state.record.datum, BigInt(launch.nowMs ?? Date.now()));
    return describeRecord(state.record.datum, stage);
  },

  /**
   * Records a settled ballot's result, posting the relayer bond from the
   * connected wallet. The bond returns to that wallet's key when the result
   * settles, unless the result is voided as false within 24 hours.
   */
  async record(
    launch: LaunchRef & { proposalIdHex: string; ballot: AnchoredBallot; walletApi: WalletApi; bondLovelace?: string },
  ): Promise<{ txHash: string }> {
    const { cfg, network } = requireConfigured();
    const state = await readRecord(launch);
    const wallet = new Cip30CurveSpendWallet(launch.walletApi as never);
    const plan = planRecordResult(state, launch.proposalIdHex, launch.ballot, {
      nowMs: BigInt(Date.now()),
      relayerKeyHash: await paymentKeyHashOf(wallet),
      ...(launch.bondLovelace ? { bondLovelace: BigInt(launch.bondLovelace) } : {}),
    });
    const { txHash } = await submitTakeoverTx(plan, wallet, builderConfig(cfg, network));
    return { txHash };
  },

  /** Executes a passed result, marks an unexecuted one expired, reclaims the bond, or clears the record: whichever is next. */
  async settle(launch: LaunchRef & { walletApi: WalletApi }): Promise<{ step: string; txHash: string }> {
    const { cfg, network } = requireConfigured();
    const { record } = await readRecord(launch);
    const wallet = new Cip30CurveSpendWallet(launch.walletApi as never);
    const plan = await planNextSettlement(record, wallet, network);
    const { txHash } = await submitTakeoverTx(plan, wallet, builderConfig(cfg, network));
    return { step: plan.action, txHash };
  },

  /**
   * Applies an executed takeover, or dissolve, to each of the launch's
   * contracts it has not reached yet, one transaction each. The pool's
   * royalty moves to a public key whose hash is the wallet it moves to: one of
   * `royaltyKeys` (the site's known keys for the launch), or else the
   * connected wallet's own, when it is that wallet.
   */
  async apply(launch: LaunchRef & { walletApi: WalletApi; royaltyKeys?: readonly string[] }) {
    const { cfg, network } = requireConfigured();
    const get = reader(cfg);
    const a = addresses(cfg, network);
    if (!cfg.scripts.venuePool) throw new Error('The venue is not configured on this site.');
    const state = await readTakeoverEffectsState(get, { ...launch, addresses: a });
    const direction = takeoverDirectionOf(state.governance.datum);
    // A takeover installs the community wallet's key; a dissolve puts back the
    // creator's, the one the escrow pays fees to.
    const target =
      direction === 'takeover'
        ? state.governance.datum.community_wallet_hash
        : state.lpEscrow?.datum.fee_recipient_pub_key_hash;
    const royaltyPubKeyHex = target
      ? (royaltyKeyAmong(launch.royaltyKeys ?? [], target) ??
        (await royaltyKeyFrom(launch.walletApi, target, launch.launchIdHex)))
      : undefined;
    const planned = planTakeoverEffects(state, {
      governanceScriptHash: scriptHashOf(cfg.scripts.governance),
      royaltyPubKeyHex,
    });
    const skipped = [...planned.skipped];
    let plans: TakeoverEffectPlan[] = planned.plans;
    if (cfg.scripts.redirect && plans.some((p) => p.withdrawal)) {
      const redirect = scriptRewardAddress(network, scriptHashOf(cfg.scripts.redirect));
      if (!(await registered(get, redirect))) {
        plans = plans.filter((p) => !p.withdrawal);
        skipped.push({ effect: 'poolRoyalty', reason: 'the venue has not registered its redirect script yet' });
      }
    }
    const wallet = new Cip30CurveSpendWallet(launch.walletApi as never);
    const builder = builderConfig(cfg, network);
    const spent = new Set<string>();
    const applied: Array<{ effect: string; txHash?: string; error?: string }> = [];
    for (const plan of plans) {
      try {
        const { txHash, fundingInputs } = await submitTakeoverTx(plan, wallet, builder, [], { excludeInputs: spent });
        for (const k of fundingInputs) spent.add(k);
        applied.push({ effect: plan.effect, txHash });
      } catch (err) {
        applied.push({ effect: plan.effect, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return plain({ direction, applied, skipped });
  },

  /**
   * What a vote to pair the frozen allocation into the pool with this much ADA
   * would do, read from the chain now and worked out with the arithmetic the
   * disposition itself runs. Read only: nothing is built or signed, and no
   * wallet is asked.
   */
  async lpPreview(launch: LaunchRef & { lovelace: string }) {
    const { cfg, network } = requireConfigured();
    const a = addresses(cfg, network);
    if (!a.venuePool) throw new Error('The venue is not configured on this site.');
    const state = await readVestingTakeoverState(reader(cfg), {
      ...launch,
      addresses: { vesting: a.vesting, governance: a.governance, lpEscrow: a.lpEscrow, venuePool: a.venuePool },
    });
    return plain(previewLpDisposition(state, BigInt(launch.lovelace)));
  },

  /**
   * Carries out a disposition vote: sends the frozen allocation where the vote
   * decided. Pairing it into the pool is paid and signed by the community
   * wallet; opening a new staking pool, or topping up one whose budget ran
   * dry, also needs the platform's governor key, which this page cannot supply.
   */
  async dispose(launch: LaunchRef & { walletApi: WalletApi }) {
    const { cfg, network } = requireConfigured();
    const a = addresses(cfg, network);
    const state = await readVestingTakeoverState(reader(cfg), {
      ...launch,
      addresses: {
        vesting: a.vesting,
        governance: a.governance,
        stakingPool: a.stakingPool,
        lpEscrow: a.lpEscrow,
        venuePool: a.venuePool,
      },
    });
    const plan: VestingTakeoverPlan = planDisposition(state, {
      governanceScriptHash: scriptHashOf(cfg.scripts.governance),
      nowMs: Date.now(),
      stakingPoolAddress: a.stakingPool,
    });
    const wallet = new Cip30CurveSpendWallet(launch.walletApi as never);
    const payer = await paymentKeyHashOf(wallet);
    const governor = state.vesting.datum.governor_pub_key_hash;
    for (const needed of plan.requiredSignerHashes) {
      if (needed === payer) continue;
      throw new Error(
        needed === governor
          ? "This destination is minted under the platform's governor key, which signs it; this page cannot."
          : 'Pairing the allocation into the pool is paid and signed by the community wallet the takeover named. ' +
              'Connect that wallet.',
      );
    }
    const { txHash } = await submitTakeoverTx(plan, wallet, builderConfig(cfg, network));
    return plain({ action: plan.action, moved: plan.moved, txHash });
  },
};

async function planNextSettlement(
  record: GovernanceRecord,
  wallet: Cip30CurveSpendWallet,
  network: CurveNetwork,
): Promise<TakeoverTxPlan> {
  const nowMs = BigInt(Date.now());
  const stage = voteStage(record.datum, nowMs);
  switch (stage.next) {
    case 'execute':
      return planExecuteResult(record, nowMs);
    case 'expire':
      return planExpireResult(record, nowMs);
    case 'reclaim':
      return planReclaimBond(
        record,
        bondPayoutAddress(
          network,
          stage.kind === 'settled' ? stage.relayerKeyHash : '',
          await wallet.getChangeAddress(),
        ),
      );
    case 'clear':
      return planClearResult(record);
    default:
      // Throws the reason the record is waiting.
      return planExecuteResult(record, nowMs);
  }
}

declare global {
  interface Window {
    NoctisCtoCardano: typeof NoctisCtoCardano;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisCtoCardano = NoctisCtoCardano;
  window.dispatchEvent(new CustomEvent('noctis-cto-cardano-ready'));
}

export default NoctisCtoCardano;
