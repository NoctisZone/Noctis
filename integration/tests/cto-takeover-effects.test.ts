// cto-takeover-effects.test.ts
//
// A passed takeover, and a dissolve, applied to each contract that holds
// something of the creator's. The datums are the genesis builder's own for a
// Cardano Launch, and every transaction is run through the compiled validators
// (see ./support/takeover-chain.ts): the curve, the LP escrow, token metadata,
// vesting, and the venue pool with its redirect script as the applied record
// holds them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialToAddress, Data } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import {
  type CtoGovernanceDatumData,
  CtoGovernanceDatumSchema,
  type ProposalAnchorData,
} from '../cardano-cto-anchor-submitter.js';
import {
  planTakeoverEffects,
  type TakeoverEffectPlan,
  type TakeoverEffectsState,
  takeoverDirectionOf,
} from '../cto-takeover-effects.js';
import type { DatumUtxo } from '../cto-takeover-tx.js';
import type { PlanAssets } from '../mesh-curve-spend.js';
import { scriptHashOf } from '../reference-script.js';
import { buildGenesisDatums } from '../tier-a-genesis-datums.js';
import {
  type BondingCurveTierBDatumData,
  BondingCurveTierBDatumSchema,
  type LpEscrowDatumData,
  LpEscrowDatumSchema,
  type TokenMetadataDatumData,
  TokenMetadataDatumSchema,
  threadNftAssetName,
  type VestingDatumData,
  VestingDatumSchema,
  venueAssetName,
} from '../tier-a-schemas.js';
import { blake2b224Hex, VENUE_MAX_LQ_CAP, type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import {
  at,
  BLUEPRINT,
  buildEvaluated,
  datumCborAt,
  launchScript,
  onChain,
  referenced,
  referenceOutput,
  venueScript,
} from './support/takeover-chain.js';

const CURVE = launchScript('bonding_curve_tier_b.bonding_curve_tier_b.spend');
const GOVERNANCE = launchScript('cto_governance.cto_governance.spend');
const LP_ESCROW = launchScript('lp_escrow.lp_escrow.spend');
const METADATA = launchScript('token_metadata.token_metadata.spend');
const VESTING = launchScript('vesting.vesting.spend');
const POOL = venueScript('royalty_pool/pool.pool.spend');
const REDIRECT = venueScript('royalty_pool/redirect.redirect.withdraw');
const TREASURY_VH = scriptHashOf(venueScript('royalty_pool/treasury.treasury.withdraw'));
const GOVERNANCE_HASH = scriptHashOf(GOVERNANCE);

// The redirect is applied with the platform's thread NFT policy and the
// governance and escrow credentials it reads. The launch here uses that policy,
// and the pool tests place the records at those credentials.
const REDIRECT_PARAMS = Object.fromEntries(
  (
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'deployment', 'applied.json'),
        'utf8',
      ),
    ) as { validators: Array<{ title: string; parameters?: Array<{ title: string; value: string }> }> }
  ).validators
    .find((v) => v.title === 'royalty_pool/redirect.redirect.withdraw')
    ?.parameters?.map((p) => [p.title, p.value]) ?? [],
) as Record<string, string>;
const THREAD_POLICY = REDIRECT_PARAMS.thread_nft_policy as string;
const REDIRECT_GOVERNANCE_HASH = REDIRECT_PARAMS.cto_governance_cred as string;
const REDIRECT_ESCROW_HASH = REDIRECT_PARAMS.lp_escrow_cred as string;
const scriptAt = (hash: string) => credentialToAddress('Preprod', { type: 'Script', hash });

const CREATOR_PUB = 'c1'.repeat(32);
const COMMUNITY_PUB = 'c2'.repeat(32);
const CREATOR = blake2b224Hex(CREATOR_PUB);
const COMMUNITY = blake2b224Hex(COMMUNITY_PUB);
const FACTORY = '1e'.repeat(28);
const TOKEN_POLICY = 'bb'.repeat(28);

const genesis = await buildGenesisDatums({
  blueprint: BLUEPRINT as never,
  network: 'preprod',
  tier: 'B',
  creatorPubKeyHashHex: CREATOR,
  governorPubKeyHashHex: '22'.repeat(28),
  bondPayoutPubKeyHashHex: '44'.repeat(28),
  tokenPolicyIdHex: TOKEN_POLICY,
  tokenBaseNameHex: Buffer.from('RESCUE').toString('hex'),
  tokenName: 'Rescue',
  tokenDescription: 'A launch its community took over.',
  threadNftPolicyIdHex: THREAD_POLICY,
  poolNftPolicyIdHex: FACTORY,
  basePrice: 3,
  maxPrice: 75,
  creatorAllocPct: 5,
  vestDays: 180,
  genesisTimestampMs: 1_785_000_000_000,
});
const LAUNCH = genesis.launchIdHex;
const TOKEN = TOKEN_POLICY + genesis.tokenAssetNameHex;
const thread = (role: Parameters<typeof threadNftAssetName>[0]) => THREAD_POLICY + threadNftAssetName(role, LAUNCH);

// -- records -----------------------------------------------------------------

function proposal(overrides: Partial<ProposalAnchorData>): ProposalAnchorData {
  return {
    proposal_type: 'SilenceLockTrigger',
    description_hash: '20'.repeat(32),
    proof_bundle_hash: '21'.repeat(32),
    yes_votes: 60_000_000n,
    no_votes: 10_000_000n,
    voter_count: 20n,
    creator_yes_votes: 0n,
    creator_no_votes: 0n,
    outcome: 'Passed',
    start_timestamp: 0n,
    end_timestamp: 1n,
    anchor_timestamp: 1n,
    execution_status: 'Executed',
    target_dex_credential: null,
    allocation_amount: 0n,
    allocation_recipient_hash: COMMUNITY,
    relayer_credential_hash: '23'.repeat(28),
    ...overrides,
  };
}

const TAKEN_OVER = proposal({});
const DISSOLVED = proposal({ proposal_type: 'DissolveCTOProposal', allocation_recipient_hash: '' });

let seq = 0x40;
function utxo<D>(address: string, assets: PlanAssets, datum: D): DatumUtxo<D> {
  seq += 1;
  return { txHash: seq.toString(16).padStart(2, '0').repeat(32), outputIndex: 0, address, assets, datum };
}

function governance(executed: ProposalAnchorData, address = at(GOVERNANCE)) {
  const base = Data.from(genesis.datums.ctoGovernance, CtoGovernanceDatumSchema);
  const takeover = executed.proposal_type === 'SilenceLockTrigger';
  const datum: CtoGovernanceDatumData = {
    ...base,
    cto_state: takeover ? 'CTOTriggered' : 'CTODissolved',
    community_wallet_hash: takeover ? COMMUNITY : '',
    active_proposal: executed,
    last_executed_proposal: executed,
    proposal_count: 1n,
  };
  return utxo(address, { lovelace: 5_000_000n, [thread('ctoGovernance')]: 1n }, datum);
}

/** The launch's contracts, each already on one side of the takeover. */
function contracts(taken: boolean, executed: ProposalAnchorData): TakeoverEffectsState {
  const community = taken ? COMMUNITY : '';
  const curve = Data.from(genesis.datums.bondingCurve, BondingCurveTierBDatumSchema);
  const escrow = Data.from(genesis.datums.lpEscrow, LpEscrowDatumSchema);
  const metadata = Data.from(genesis.datums.tokenMetadata, TokenMetadataDatumSchema);
  const vesting = Data.from(genesis.datums.vesting, VestingDatumSchema);
  return {
    governance: governance(executed),
    curve: utxo(at(CURVE), { lovelace: 42_000_000n, [thread('bondingCurveTierB')]: 1n }, {
      ...curve,
      curve_state: 'Graduated',
      cto_triggered: taken,
      community_pub_key_hash: community,
    } as BondingCurveTierBDatumData),
    lpEscrow: utxo(
      at(LP_ESCROW),
      { lovelace: 2_000_000n, [thread('lpEscrow')]: 1n, [FACTORY + venueAssetName('lq', LAUNCH)]: 1_000_000_000n },
      { ...escrow, cto_triggered: taken, community_wallet_hash: community } as LpEscrowDatumData,
    ),
    tokenMetadata: utxo(at(METADATA), { lovelace: 3_000_000n, [TOKEN_POLICY + genesis.referenceAssetNameHex]: 1n }, {
      ...metadata,
      extra: { ...metadata.extra, cto_triggered: taken, community_pub_key_hash: community },
    } as TokenMetadataDatumData),
    vesting: utxo(at(VESTING), { lovelace: 2_000_000n, [thread('vesting')]: 1n, [TOKEN]: vesting.token_allocation }, {
      ...vesting,
      vesting_state: taken ? 'CTOFrozen' : 'Vesting',
      cto_triggered: taken,
      community_treasury_wallet: taken ? COMMUNITY : '',
      vest_start_timestamp: 1_000_000n,
    } as VestingDatumData),
  };
}

function pool(royaltyPub: string, nonce = 3n): DatumUtxo<VenuePoolConfigData> {
  const config: VenuePoolConfigData = {
    pool_nft: { policy: FACTORY, name: venueAssetName('pool', LAUNCH) },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: TOKEN_POLICY, name: genesis.tokenAssetNameHex },
    pool_lq: { policy: FACTORY, name: venueAssetName('lq', LAUNCH) },
    fee_num: 99_900n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 25_000_000n,
    royalty_y: 0n,
    dao_policy: [
      { StakingHash: [{ ScriptCredential: [TREASURY_VH] }] },
      { StakingHash: [{ ScriptCredential: [scriptHashOf(REDIRECT)] }] },
    ],
    treasury_address: 'ee'.repeat(28),
    royalty_pub_key: royaltyPub,
    nonce,
  };
  return utxo(
    at(POOL),
    {
      lovelace: 30_025_000_000n,
      [TOKEN]: 200_000_000n,
      [FACTORY + venueAssetName('lq', LAUNCH)]: VENUE_MAX_LQ_CAP - 1_000_000_000n,
      [FACTORY + venueAssetName('pool', LAUNCH)]: 1n,
    },
    config,
  );
}

// -- the chain ---------------------------------------------------------------

const REFS = {
  curve: referenceOutput(CURVE, 0xd1),
  lpEscrow: referenceOutput(LP_ESCROW, 0xd2),
  venuePool: referenceOutput(POOL, 0xd3),
};
const SCRIPTS = {
  curve: referenced(CURVE, REFS.curve),
  lpEscrow: referenced(LP_ESCROW, REFS.lpEscrow),
  venuePool: referenced(POOL, REFS.venuePool),
  tokenMetadata: { compiledScriptCbor: METADATA },
  vesting: { compiledScriptCbor: VESTING },
  redirect: { compiledScriptCbor: REDIRECT },
};

function chain(state: TakeoverEffectsState) {
  const known = [...Object.values(REFS)];
  known.push(onChain(state.governance, Data.to(state.governance.datum, CtoGovernanceDatumSchema)));
  if (state.curve) known.push(onChain(state.curve, Data.to(state.curve.datum, BondingCurveTierBDatumSchema)));
  if (state.lpEscrow) known.push(onChain(state.lpEscrow, Data.to(state.lpEscrow.datum, LpEscrowDatumSchema)));
  if (state.tokenMetadata) {
    known.push(onChain(state.tokenMetadata, Data.to(state.tokenMetadata.datum, TokenMetadataDatumSchema)));
  }
  if (state.vesting) known.push(onChain(state.vesting, Data.to(state.vesting.datum, VestingDatumSchema)));
  if (state.venuePool) known.push(onChain(state.venuePool, Data.to(state.venuePool.datum, VenuePoolConfigSchema)));
  return known;
}

const build = (plan: TakeoverEffectPlan, state: TakeoverEffectsState) => buildEvaluated(plan, chain(state), SCRIPTS);
const datumOut = <D>(tx: string, schema: D, index = 0) => Data.from(datumCborAt(tx, index), schema);

/** The pool redirect's own records: at the credentials the applied redirect reads. */
function poolState(executed: ProposalAnchorData, royaltyPub: string): TakeoverEffectsState {
  const escrow = Data.from(genesis.datums.lpEscrow, LpEscrowDatumSchema);
  const taken = executed.proposal_type === 'SilenceLockTrigger';
  return {
    governance: governance(executed, scriptAt(REDIRECT_GOVERNANCE_HASH)),
    lpEscrow: utxo(scriptAt(REDIRECT_ESCROW_HASH), { lovelace: 2_000_000n, [thread('lpEscrow')]: 1n }, {
      ...escrow,
      cto_triggered: taken,
      community_wallet_hash: taken ? COMMUNITY : '',
      cto_governance_credential: { ScriptCredential: [REDIRECT_GOVERNANCE_HASH] },
    } as LpEscrowDatumData),
    venuePool: pool(royaltyPub),
  };
}

// -- tests -------------------------------------------------------------------

describe('which way the record moves the launch', () => {
  it('reads a takeover and a dissolve, and nothing else', () => {
    expect(takeoverDirectionOf(governance(TAKEN_OVER).datum)).toBe('takeover');
    expect(takeoverDirectionOf(governance(DISSOLVED).datum)).toBe('dissolve');
    expect(() => takeoverDirectionOf(governance(proposal({ proposal_type: 'VestingToTreasury' })).datum)).toThrow(
      /neither takes over nor dissolves/,
    );
  });
});

describe('applying a takeover', () => {
  it("plans the curve, the escrow, the metadata and the creator's schedule, each accepted by its validator", async () => {
    const state = contracts(false, TAKEN_OVER);
    const { direction, plans, skipped } = planTakeoverEffects(state, { governanceScriptHash: GOVERNANCE_HASH });
    expect(direction).toBe('takeover');
    expect(plans.map((p) => p.effect)).toEqual(['curve', 'lpEscrow', 'tokenMetadata', 'vesting']);
    expect(skipped).toEqual([{ effect: 'poolRoyalty', reason: 'not found' }]);
    for (const plan of plans) await build(plan, state);

    const [curve, escrow, metadata, vesting] = plans as [TakeoverEffectPlan, ...TakeoverEffectPlan[]];
    expect(datumOut(await build(curve, state), BondingCurveTierBDatumSchema)).toMatchObject({
      cto_triggered: true,
      community_pub_key_hash: COMMUNITY,
    });
    expect(datumOut(await build(escrow as TakeoverEffectPlan, state), LpEscrowDatumSchema)).toMatchObject({
      cto_triggered: true,
      community_wallet_hash: COMMUNITY,
    });
    expect(datumOut(await build(metadata as TakeoverEffectPlan, state), TokenMetadataDatumSchema).extra).toMatchObject({
      cto_triggered: true,
      community_pub_key_hash: COMMUNITY,
    });
    expect(datumOut(await build(vesting as TakeoverEffectPlan, state), VestingDatumSchema).vesting_state).toBe(
      'CTOFrozen',
    );
  });

  it('plans nothing for what the takeover already reached', () => {
    const { plans, skipped } = planTakeoverEffects(contracts(true, TAKEN_OVER), {
      governanceScriptHash: GOVERNANCE_HASH,
    });
    expect(plans).toEqual([]);
    expect(skipped.filter((s) => s.reason === 'already taken over').map((s) => s.effect)).toEqual([
      'curve',
      'lpEscrow',
      'tokenMetadata',
      'vesting',
    ]);
  });

  it('leaves a schedule that never started, since there is nothing running to freeze', () => {
    const state = contracts(false, TAKEN_OVER);
    if (!state.vesting) throw new Error('no vesting');
    state.vesting.datum = { ...state.vesting.datum, vesting_state: 'NotStarted' };
    const { plans, skipped } = planTakeoverEffects(state, { governanceScriptHash: GOVERNANCE_HASH });
    expect(plans.map((p) => p.effect)).not.toContain('vesting');
    expect(skipped).toContainEqual({ effect: 'vesting', reason: expect.stringMatching(/NotStarted/) });
  });

  it("rewrites the pool's royalty key to the community wallet's, through the venue redirect", async () => {
    const state = poolState(TAKEN_OVER, CREATOR_PUB);
    const { plans } = planTakeoverEffects(state, {
      governanceScriptHash: REDIRECT_GOVERNANCE_HASH,
      royaltyPubKeyHex: COMMUNITY_PUB,
    });
    const redirect = plans.find((p) => p.effect === 'poolRoyalty');
    if (!redirect) throw new Error('no pool plan');
    const tx = await build(redirect, state);
    expect(datumOut(tx, VenuePoolConfigSchema)).toMatchObject({ royalty_pub_key: COMMUNITY_PUB, nonce: 4n });
  });

  it("reports the pool, rather than guessing, without the community wallet's public key", () => {
    const { plans, skipped } = planTakeoverEffects(poolState(TAKEN_OVER, CREATOR_PUB), {
      governanceScriptHash: REDIRECT_GOVERNANCE_HASH,
    });
    expect(plans.map((p) => p.effect)).not.toContain('poolRoyalty');
    expect(skipped).toContainEqual({ effect: 'poolRoyalty', reason: expect.stringMatching(/public key/) });
  });

  it('refuses a royalty key that is not the community wallet the takeover named', () => {
    expect(() =>
      planTakeoverEffects(poolState(TAKEN_OVER, CREATOR_PUB), {
        governanceScriptHash: REDIRECT_GOVERNANCE_HASH,
        royaltyPubKeyHex: 'c3'.repeat(32),
      }),
    ).toThrow(/not to/);
  });
});

describe('applying a dissolve', () => {
  it('returns the curve, the escrow, the metadata and the schedule to the creator', async () => {
    const state = contracts(true, DISSOLVED);
    const { direction, plans } = planTakeoverEffects(state, { governanceScriptHash: GOVERNANCE_HASH });
    expect(direction).toBe('dissolve');
    expect(plans.map((p) => p.effect)).toEqual(['curve', 'lpEscrow', 'tokenMetadata', 'vesting']);
    for (const plan of plans) await build(plan, state);
    const vesting = plans.find((p) => p.effect === 'vesting') as TakeoverEffectPlan;
    expect(datumOut(await build(vesting, state), VestingDatumSchema)).toMatchObject({
      vesting_state: 'Vesting',
      cto_triggered: false,
    });
  });

  it('leaves an allocation a vote already disposed of', () => {
    const state = contracts(true, DISSOLVED);
    if (!state.vesting) throw new Error('no vesting');
    state.vesting.datum = { ...state.vesting.datum, vesting_state: 'Disposed' };
    const { plans, skipped } = planTakeoverEffects(state, { governanceScriptHash: GOVERNANCE_HASH });
    expect(plans.map((p) => p.effect)).not.toContain('vesting');
    expect(skipped).toContainEqual({ effect: 'vesting', reason: expect.stringMatching(/final/) });
  });

  it("returns the pool's royalty key to the creator the escrow records", async () => {
    const state = poolState(DISSOLVED, COMMUNITY_PUB);
    const { plans } = planTakeoverEffects(state, {
      governanceScriptHash: REDIRECT_GOVERNANCE_HASH,
      royaltyPubKeyHex: CREATOR_PUB,
    });
    const redirect = plans.find((p) => p.effect === 'poolRoyalty');
    if (!redirect) throw new Error('no pool plan');
    expect(redirect.referenceInputs).toHaveLength(2);
    const tx = await build(redirect, state);
    expect(datumOut(tx, VenuePoolConfigSchema).royalty_pub_key).toBe(CREATOR_PUB);
  });
});

// Each is a transaction the validators accepted above with ONE thing changed.
describe('the validators refuse each effect with one thing changed', () => {
  const refused = /evaluation failed/i;
  function tamper<D>(plan: TakeoverEffectPlan, schema: D, change: (d: D) => D) {
    const out = plan.outputs[0];
    if (!out) throw new Error('no output');
    // The schema objects are Lucid's own; the cast only widens the generic.
    out.datumCbor = Data.to(change(Data.from(out.datumCbor, schema)) as never, schema);
  }
  const takeoverPlan = (state: TakeoverEffectsState, effect: string) => {
    const plan = planTakeoverEffects(state, { governanceScriptHash: GOVERNANCE_HASH }).plans.find(
      (p) => p.effect === effect,
    );
    if (!plan) throw new Error(`no ${effect} plan`);
    return plan;
  };

  it('a curve that records a wallet the vote did not name', async () => {
    const state = contracts(false, TAKEN_OVER);
    const plan = takeoverPlan(state, 'curve');
    tamper(plan, BondingCurveTierBDatumSchema, (d) => ({ ...d, community_pub_key_hash: '66'.repeat(28) }));
    await expect(build(plan, state)).rejects.toThrow(refused);
  });

  it('an escrow left untriggered', async () => {
    const state = contracts(false, TAKEN_OVER);
    const plan = takeoverPlan(state, 'lpEscrow');
    tamper(plan, LpEscrowDatumSchema, (d) => ({ ...d, cto_triggered: false }));
    await expect(build(plan, state)).rejects.toThrow(refused);
  });

  it('metadata that also bumps its revision', async () => {
    const state = contracts(false, TAKEN_OVER);
    const plan = takeoverPlan(state, 'tokenMetadata');
    tamper(plan, TokenMetadataDatumSchema, (d) => ({
      ...d,
      extra: { ...d.extra, metadata_revision: d.extra.metadata_revision + 1n },
    }));
    await expect(build(plan, state)).rejects.toThrow(refused);
  });

  it('a pool redirect that does not advance the nonce', async () => {
    const state = poolState(TAKEN_OVER, CREATOR_PUB);
    const plan = planTakeoverEffects(state, {
      governanceScriptHash: REDIRECT_GOVERNANCE_HASH,
      royaltyPubKeyHex: COMMUNITY_PUB,
    }).plans.find((p) => p.effect === 'poolRoyalty') as TakeoverEffectPlan;
    tamper(plan, VenuePoolConfigSchema, (d) => ({ ...d, nonce: d.nonce - 1n }));
    await expect(build(plan, state)).rejects.toThrow(refused);
  });
});
