// ============================================================================
// Noctis Zone — applying a takeover, or its dissolve, to a launch's contracts
// ============================================================================
// Executing a vote changes one record: the launch's governance UTXO. Every
// contract that holds something of the creator's then applies it to itself,
// in its own permissionless spend, citing that record as a reference input:
//
//   - the curve        redirects the creator fees still in it
//   - the LP escrow    hands migration authority and harvested fees over
//   - token metadata   hands the metadata signature over
//   - vesting          freezes the creator's schedule (cto-disposition.ts)
//   - the venue pool   rewrites its royalty key, through the venue's redirect
//                      script, so every future royalty is the community's
//
// A dissolve reverses each one. This module reads which of them the record's
// current state has not reached yet and plans a transaction for each; the
// builder in `cto-takeover-tx.ts` makes them. They are applied from the
// execution the record shows as its most recent, so they follow the vote
// directly.
//
// **The pool's new key is a public key, not a hash.** The redirect installs a
// key the community can sign royalty claims with, and only checks that it
// hashes to the wallet the vote named, so the key itself has to be supplied:
// the community wallet's for a takeover, the creator's for a dissolve.
// ============================================================================

import { Constr, Data } from '@lucid-evolution/lucid';
import { type CtoGovernanceDatumData, CtoGovernanceDatumSchema } from './cardano-cto-anchor-submitter.js';
import { planVestingFreeze, sameCredential, threadUnit } from './cto-disposition.js';
import { type DatumUtxo, REDIRECT_ACTION, readByUnit, type TakeoverTxPlan } from './cto-takeover-tx.js';
import {
  BONDING_CURVE_TIER_B_REDEEMER,
  LP_ESCROW_REDEEMER,
  TOKEN_METADATA_REDEEMER,
  VESTING_REDEEMER,
} from './redeemer-indices.js';
import {
  type BondingCurveTierBDatumData,
  BondingCurveTierBDatumSchema,
  cip68BaseName,
  cip68ReferenceAssetName,
  type LpEscrowDatumData,
  LpEscrowDatumSchema,
  type TokenMetadataDatumData,
  TokenMetadataDatumSchema,
  type VestingDatumData,
  VestingDatumSchema,
  venueAssetName,
} from './tier-a-schemas.js';
import { blake2b224Hex, type VenuePoolConfigData, VenuePoolConfigSchema } from './venue-pool.js';
import { VENUE_POOL_ACTION } from './venue-swap.js';

export type TakeoverEffect = 'curve' | 'lpEscrow' | 'tokenMetadata' | 'vesting' | 'poolRoyalty';
export const TAKEOVER_EFFECTS: readonly TakeoverEffect[] = [
  'curve',
  'lpEscrow',
  'tokenMetadata',
  'vesting',
  'poolRoyalty',
];
export type TakeoverDirection = 'takeover' | 'dissolve';

/** The governance record, and whichever of the launch's contracts were found. */
export interface TakeoverEffectsState {
  governance: DatumUtxo<CtoGovernanceDatumData>;
  curve?: DatumUtxo<BondingCurveTierBDatumData>;
  lpEscrow?: DatumUtxo<LpEscrowDatumData>;
  tokenMetadata?: DatumUtxo<TokenMetadataDatumData>;
  vesting?: DatumUtxo<VestingDatumData>;
  venuePool?: DatumUtxo<VenuePoolConfigData>;
}

export interface TakeoverEffectPlan extends TakeoverTxPlan {
  effect: TakeoverEffect;
  direction: TakeoverDirection;
}

export interface TakeoverEffectsPlan {
  direction: TakeoverDirection;
  /** One transaction per contract the record's state has not reached. */
  plans: TakeoverEffectPlan[];
  /** Contracts left as they are, and why: already applied, absent, or waiting on an input. */
  skipped: Array<{ effect: TakeoverEffect; reason: string }>;
}

/** Which way the record's most recent executed vote moves the launch. */
export function takeoverDirectionOf(g: CtoGovernanceDatumData): TakeoverDirection {
  const executed = g.last_executed_proposal;
  if (executed?.outcome !== 'Passed' || executed.execution_status !== 'Executed') {
    throw new Error('The governance record shows no passed, executed vote to apply.');
  }
  if (executed.proposal_type === 'SilenceLockTrigger') {
    if (g.cto_state !== 'CTOTriggered' || g.community_wallet_hash === '') {
      throw new Error('The record no longer shows the takeover holding, so there is nothing to apply for it.');
    }
    if (g.community_wallet_hash !== executed.allocation_recipient_hash) {
      throw new Error("The record's community wallet is not the one the takeover named.");
    }
    return 'takeover';
  }
  if (executed.proposal_type === 'DissolveCTOProposal') return 'dissolve';
  throw new Error(
    `The record's most recent executed vote is ${executed.proposal_type}, which neither takes over nor dissolves.`,
  );
}

/** The governance record's own NFT and launch, checked the way each contract checks them. */
function recordIsTheLaunchs(
  state: TakeoverEffectsState,
  launch: { launch_id: string; thread_nft_policy: string },
  credential: VestingDatumData['cto_governance_credential'],
  governanceScriptHash: string,
  what: string,
): void {
  if (!sameCredential(credential, governanceScriptHash)) {
    throw new Error(`The ${what} names a different governance script than the record's.`);
  }
  if (launch.launch_id !== state.governance.datum.launch_id) {
    throw new Error(`The ${what} belongs to a different launch than the record.`);
  }
  if (state.governance.assets[threadUnit(launch.thread_nft_policy, 'ctoGovernance', launch.launch_id)] !== 1n) {
    throw new Error("The governance output does not carry this launch's governance NFT.");
  }
}

/** A spend that rewrites one datum and moves no value. */
function datumOnly(
  effect: TakeoverEffect,
  direction: TakeoverDirection,
  role: TakeoverEffectPlan['spends'][number]['role'],
  utxo: DatumUtxo<unknown>,
  redeemerCbor: string,
  nextDatumCbor: string,
  state: TakeoverEffectsState,
): TakeoverEffectPlan {
  return {
    effect,
    direction,
    action: `${direction}:${effect}`,
    spends: [{ role, utxo, redeemer: { cbor: redeemerCbor } }],
    referenceInputs: [state.governance],
    outputs: [{ address: utxo.address, assets: utxo.assets, datumCbor: nextDatumCbor }],
    requiredSignerHashes: [],
    fundingLovelace: 0n,
  };
}

/**
 * Everything the record's most recent executed vote has not yet reached.
 *
 * `royaltyPubKeyHex` is the key the pool's royalty moves to: the community
 * wallet's on a takeover, the creator's on a dissolve. Without it the pool is
 * reported, not planned.
 */
export function planTakeoverEffects(
  state: TakeoverEffectsState,
  opts: { governanceScriptHash: string; royaltyPubKeyHex?: string },
): TakeoverEffectsPlan {
  const g = state.governance.datum;
  const direction = takeoverDirectionOf(g);
  const takeover = direction === 'takeover';
  const community = g.community_wallet_hash;
  const plans: TakeoverEffectPlan[] = [];
  const skipped: TakeoverEffectsPlan['skipped'] = [];
  const done = (effect: TakeoverEffect) =>
    skipped.push({ effect, reason: takeover ? 'already taken over' : 'already returned to the creator' });

  const curve = state.curve;
  if (!curve) skipped.push({ effect: 'curve', reason: 'not found' });
  else {
    const c = curve.datum;
    recordIsTheLaunchs(state, c, c.cto_governance_credential, opts.governanceScriptHash, 'curve');
    if (c.cto_triggered === takeover) done('curve');
    else {
      const next: BondingCurveTierBDatumData = takeover
        ? { ...c, cto_triggered: true, community_pub_key_hash: community }
        : { ...c, cto_triggered: false, community_pub_key_hash: '' };
      const redeemer = takeover
        ? new Constr(BONDING_CURVE_TIER_B_REDEEMER.TriggerCTO, [community])
        : new Constr(BONDING_CURVE_TIER_B_REDEEMER.DissolveCTO, []);
      plans.push(
        datumOnly(
          'curve',
          direction,
          'curve',
          curve,
          Data.to(redeemer),
          Data.to(next, BondingCurveTierBDatumSchema),
          state,
        ),
      );
    }
  }

  const escrow = state.lpEscrow;
  if (!escrow) skipped.push({ effect: 'lpEscrow', reason: 'not found' });
  else {
    const e = escrow.datum;
    recordIsTheLaunchs(state, e, e.cto_governance_credential, opts.governanceScriptHash, 'LP escrow');
    if (e.cto_triggered === takeover) done('lpEscrow');
    else {
      const next: LpEscrowDatumData = takeover
        ? { ...e, cto_triggered: true, community_wallet_hash: community }
        : { ...e, cto_triggered: false, community_wallet_hash: '' };
      const redeemer = takeover
        ? new Constr(LP_ESCROW_REDEEMER.TriggerCTO, [community])
        : new Constr(LP_ESCROW_REDEEMER.DissolveCTO, []);
      plans.push(
        datumOnly(
          'lpEscrow',
          direction,
          'lpEscrow',
          escrow,
          Data.to(redeemer),
          Data.to(next, LpEscrowDatumSchema),
          state,
        ),
      );
    }
  }

  const metadata = state.tokenMetadata;
  if (!metadata) skipped.push({ effect: 'tokenMetadata', reason: 'not found' });
  else {
    const x = metadata.datum.extra;
    recordIsTheLaunchs(state, x, x.cto_governance_credential, opts.governanceScriptHash, 'token metadata');
    if (x.cto_triggered === takeover) done('tokenMetadata');
    else {
      const next: TokenMetadataDatumData = {
        ...metadata.datum,
        extra: takeover
          ? { ...x, cto_triggered: true, community_pub_key_hash: community }
          : { ...x, cto_triggered: false, community_pub_key_hash: '' },
      };
      const redeemer = takeover
        ? new Constr(TOKEN_METADATA_REDEEMER.TriggerCTO, [community])
        : new Constr(TOKEN_METADATA_REDEEMER.DissolveCTO, []);
      plans.push(
        datumOnly(
          'tokenMetadata',
          direction,
          'tokenMetadata',
          metadata,
          Data.to(redeemer),
          Data.to(next, TokenMetadataDatumSchema),
          state,
        ),
      );
    }
  }

  const vesting = state.vesting;
  if (!vesting) skipped.push({ effect: 'vesting', reason: 'not found' });
  else {
    const v = vesting.datum;
    recordIsTheLaunchs(state, v, v.cto_governance_credential, opts.governanceScriptHash, 'vesting');
    if (takeover) {
      if (v.cto_triggered) done('vesting');
      else if (v.vesting_state !== 'Vesting') {
        skipped.push({
          effect: 'vesting',
          reason: `vesting is ${v.vesting_state}; only a schedule that has started is frozen`,
        });
      } else {
        const freeze = planVestingFreeze(
          { vesting, governance: state.governance },
          { governanceScriptHash: opts.governanceScriptHash },
        );
        plans.push({ ...freeze, effect: 'vesting', direction, action: 'takeover:vesting' });
      }
    } else if (!v.cto_triggered) done('vesting');
    else if (v.vesting_state !== 'CTOFrozen') {
      skipped.push({ effect: 'vesting', reason: `vesting is ${v.vesting_state}, and a disposition is final` });
    } else {
      const next: VestingDatumData = { ...v, cto_triggered: false, vesting_state: 'Vesting' };
      plans.push(
        datumOnly(
          'vesting',
          direction,
          'vesting',
          vesting,
          Data.to(new Constr(VESTING_REDEEMER.DissolveCTO, [])),
          Data.to(next, VestingDatumSchema),
          state,
        ),
      );
    }
  }

  const pool = state.venuePool;
  if (!pool) skipped.push({ effect: 'poolRoyalty', reason: 'not found' });
  else {
    const cfg = pool.datum;
    // A dissolve returns the royalty to the creator the escrow records, and the
    // redirect reads that from the escrow itself.
    const target = takeover ? community : escrow?.datum.fee_recipient_pub_key_hash;
    if (!target) {
      skipped.push({ effect: 'poolRoyalty', reason: "the LP escrow, which records the creator's key, was not found" });
    } else if (blake2b224Hex(cfg.royalty_pub_key) === target) {
      done('poolRoyalty');
    } else if (!opts.royaltyPubKeyHex) {
      skipped.push({
        effect: 'poolRoyalty',
        reason: `needs the ${takeover ? 'community wallet' : 'creator'}'s public key, which hashes to ${target}`,
      });
    } else if (blake2b224Hex(opts.royaltyPubKeyHex) !== target) {
      throw new Error(
        `The royalty key given hashes to ${blake2b224Hex(opts.royaltyPubKeyHex)}, not to ${target}, ` +
          `the ${takeover ? 'community wallet the takeover named' : "creator's key the LP escrow records"}.`,
      );
    } else {
      const next: VenuePoolConfigData = { ...cfg, royalty_pub_key: opts.royaltyPubKeyHex, nonce: cfg.nonce + 1n };
      plans.push({
        effect: 'poolRoyalty',
        direction,
        action: `${direction}:poolRoyalty`,
        spends: [{ role: 'venuePool', utxo: pool, redeemer: { venuePoolAction: VENUE_POOL_ACTION.RedirectRoyalty } }],
        referenceInputs: takeover || !escrow ? [state.governance] : [state.governance, escrow],
        outputs: [{ address: pool.address, assets: pool.assets, datumCbor: Data.to(next, VenuePoolConfigSchema) }],
        withdrawal: {
          role: 'redirect',
          redirectAction: takeover ? REDIRECT_ACTION.Takeover : REDIRECT_ACTION.Dissolve,
        },
        requiredSignerHashes: [],
        fundingLovelace: 0n,
      });
    }
  }

  return { direction, plans, skipped };
}

/**
 * Reads the governance record and every contract a takeover reaches, each by
 * the NFT that authenticates it. The metadata output is found by the CIP-68
 * reference NFT of the launch token that vesting or the curve names.
 */
export async function readTakeoverEffectsState(
  get: (path: string) => Promise<unknown>,
  args: {
    launchIdHex: string;
    threadNftPolicyId: string;
    addresses: {
      governance: string;
      curve: string;
      lpEscrow: string;
      tokenMetadata: string;
      vesting: string;
      venuePool: string;
    };
  },
): Promise<TakeoverEffectsState> {
  const { launchIdHex: id, threadNftPolicyId: policy, addresses } = args;
  const governance = await readByUnit(
    get,
    addresses.governance,
    threadUnit(policy, 'ctoGovernance', id),
    CtoGovernanceDatumSchema,
    'governance',
  );
  if (!governance) throw new Error("This launch's governance record could not be found.");
  const state: TakeoverEffectsState = { governance };
  state.curve = await readByUnit(
    get,
    addresses.curve,
    threadUnit(policy, 'bondingCurveTierB', id),
    BondingCurveTierBDatumSchema,
    'curve',
  );
  state.lpEscrow = await readByUnit(
    get,
    addresses.lpEscrow,
    threadUnit(policy, 'lpEscrow', id),
    LpEscrowDatumSchema,
    'LP escrow',
  );
  state.vesting = await readByUnit(
    get,
    addresses.vesting,
    threadUnit(policy, 'vesting', id),
    VestingDatumSchema,
    'vesting',
  );
  const token = state.vesting?.datum ?? state.curve?.datum;
  if (token) {
    state.tokenMetadata = await readByUnit(
      get,
      addresses.tokenMetadata,
      token.token_policy_id + cip68ReferenceAssetName(cip68BaseName(token.token_asset_name)),
      TokenMetadataDatumSchema,
      'token metadata',
    );
  }
  if (state.lpEscrow) {
    state.venuePool = await readByUnit(
      get,
      addresses.venuePool,
      state.lpEscrow.datum.lp_token_policy_id + venueAssetName('pool', id),
      VenuePoolConfigSchema,
      'pool',
    );
  }
  return state;
}
