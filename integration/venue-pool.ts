// ============================================================================
// Noctis Zone — NoctisSwap: the pool a graduation opens
// ============================================================================
// The venue's factory (`contracts/cardano-dex/validators/royalty_pool/
// pool_mint.ak`) mints a launch's pool NFT and LQ token in the launch's own
// graduation transaction, and it does not accept whatever datum the submitter
// felt like writing: it rebuilds the pool's opening config from its OWN nine
// parameters and requires `cfg == expected`. Only three fields are the
// submitter's to choose — `pool_y`, `royalty_pub_key` and (by naming) the
// launch id — and even those are constrained, `pool_y` by elimination and
// `royalty_pub_key` by having to hash to the creator key the LP escrow already
// recorded at genesis.
//
// So the datum in this file is not "our idea of a pool". It is a
// reconstruction of the factory's `expected`, and it is only right if it is
// built from the parameters that factory was APPLIED with. That is why
// `readVenueFactoryParameters` reads them out of
// `contracts/cardano-dex/deployment/applied.json` — the same record the
// deployment order is derived from — rather than taking nine loose arguments
// a caller could get subtly wrong. A datum built from the deployed record
// cannot disagree with the deployed factory; a datum built from nine typed-in
// values can, and would fail at evaluation with nothing naming which field.
//
// Encoding notes, each verified against the venue blueprint's own
// `definitions` block rather than read off the Aiken source:
//   - `splash/plutus/Asset` is one constructor, `(policy, name)`.
//   - `dao_policy` is `List<cardano/address/StakeCredential>`, whose two
//     constructors are `Inline(Credential)` = 0 and `Pointer(…)` = 1. Lucid
//     spells the same two shapes `StakingHash` / `StakingPtr`, and the names
//     never travel on chain — only the constructor index and the positional
//     fields do — so its `StakingCredentialSchema` is reused rather than
//     re-declared. The factory writes two SCRIPT credentials, in a fixed
//     order: the treasury first, the governance redirect second.
//   - `MintAction` is `Create { launch_id, pool_out_ix, escrow_out_ix }` = 0,
//     `Burn` = 1. The two indices are positions in `self.outputs`, so the
//     transaction builder and this redeemer have to agree about output order
//     — see `tier-b-graduation-submitter.ts`, which checks the built
//     transaction rather than trusting the order it asked for.
// ============================================================================

import { Constr, Data, StakingCredentialSchema } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2.js';
import { VENUE_ROLES, venueAssetName } from './tier-a-schemas.js';

/** Fee numerators are expressed over this denominator — `pool_state.ak`'s
 *  `fee_den`, and Splash's convention before it. */
export const VENUE_FEE_DEN = 100_000n;

/**
 * `pool_state.ak`'s `max_lq_cap`: the whole LQ supply the factory mints, of
 * which the pool keeps `max_lq_cap - initial_lq` so that circulating
 * liquidity is derived from the pool's own balance rather than stored.
 *
 * It is `0x7fffffffffffffff` because that is the largest quantity a Cardano
 * mint field can carry — the value is a ceiling, not a round number, and
 * rounding it would silently change every pool's liquidity arithmetic.
 */
export const VENUE_MAX_LQ_CAP = 0x7fffffffffffffffn;

/** Splash's `Asset`: a policy id and an asset name, as one constructor. */
export const VenueAssetShape = Data.Object({
  policy: Data.Bytes(),
  name: Data.Bytes(),
});
export type VenueAssetData = Data.Static<typeof VenueAssetShape>;
export const VenueAssetSchema = VenueAssetShape as unknown as VenueAssetData;

/** `splash/royalty_pool/single_royalty_pool/SingleRoyaltyPoolConfig`. */
export const VenuePoolConfigShape = Data.Object({
  pool_nft: VenueAssetShape,
  pool_x: VenueAssetShape,
  pool_y: VenueAssetShape,
  pool_lq: VenueAssetShape,
  fee_num: Data.Integer(),
  treasury_fee: Data.Integer(),
  royalty_fee: Data.Integer(),
  treasury_x: Data.Integer(),
  treasury_y: Data.Integer(),
  royalty_x: Data.Integer(),
  royalty_y: Data.Integer(),
  dao_policy: Data.Array(StakingCredentialSchema),
  treasury_address: Data.Bytes(),
  royalty_pub_key: Data.Bytes(),
  nonce: Data.Integer(),
});
export type VenuePoolConfigData = Data.Static<typeof VenuePoolConfigShape>;
export const VenuePoolConfigSchema = VenuePoolConfigShape as unknown as VenuePoolConfigData;

/** ADA, as the pool datum names it: the empty policy and the empty name. */
export const VENUE_ADA_ASSET: VenueAssetData = { policy: '', name: '' };

/**
 * The nine parameters `pool_mint` is applied with. Every one of them is
 * compiled into the factory's hash, so a pool minted under a factory carrying
 * different values is a different policy id entirely — which is exactly why
 * these are read from the deployment record rather than supplied.
 */
export interface VenueFactoryParameters {
  /** The platform's thread NFT policy, under which the escrow's NFT was minted. */
  threadNftPolicy: string;
  /** The pool validator; the minted pool output must sit at its bare address. */
  poolValidatorHash: string;
  /** The governance redirect script — the second `dao_policy` entry. */
  redirectValidatorHash: string;
  /** The treasury script — the first `dao_policy` entry. */
  treasuryValidatorHash: string;
  /** The platform's treasury wallet, as the datum carries it: raw bytes, hex. */
  treasuryAddressHex: string;
  feeNum: bigint;
  treasuryFee: bigint;
  royaltyFee: bigint;
  /** The LQ position every pool opens with, held by the launch's LP escrow. */
  initialLq: bigint;
}

/** One entry of `contracts/cardano-dex/deployment/applied.json`. */
export interface AppliedValidatorRecord {
  title: string;
  parameters: Array<{ title: string; value: string }>;
  compiledCode: string;
  hash: string;
}

/** The factory's title in both the blueprint and the deployment record. */
export const VENUE_FACTORY_TITLE = 'royalty_pool/pool_mint.pool_mint.mint';

/**
 * The order `pool_mint` takes its parameters in.
 *
 * A second copy of something the blueprint already states, so a test pins it
 * against the blueprint's own `parameters` list — that is the whole reason it
 * is a named export rather than a literal inside the reader below.
 */
export const VENUE_FACTORY_PARAMETER_ORDER = [
  'thread_nft_policy',
  'pool_vh',
  'redirect_vh',
  'treasury_vh',
  'treasury_address',
  'fee_num',
  'treasury_fee',
  'royalty_fee',
  'initial_lq',
] as const;

/**
 * The parameters `pool_mint` was applied with, from the deployment record.
 *
 * Names, order and count are all checked. `aiken blueprint apply` consumes
 * parameters positionally, so a record that lists eight, or lists nine in the
 * wrong order, produced a script that is not the one this reader describes —
 * and every pool datum built from it would be rejected by the factory it was
 * built for. Better to refuse here, naming the record, than to find out at
 * evaluation.
 */
export function readVenueFactoryParameters(record: AppliedValidatorRecord): VenueFactoryParameters {
  const expected = VENUE_FACTORY_PARAMETER_ORDER;
  const actual = record.parameters.map((p) => p.title);
  if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
    throw new Error(
      `${record.title} in the deployment record lists its parameters as [${actual.join(', ')}], but the ` +
        `factory takes [${expected.join(', ')}] in that order. Parameters are applied positionally, so a ` +
        'record that disagrees with the validator describes a script nobody deployed.',
    );
  }
  const value = (name: string) => {
    const found = record.parameters.find((p) => p.title === name);
    if (!found) throw new Error(`${record.title} records no value for ${name}.`);
    return found.value;
  };
  const asInt = (name: string) => {
    const raw = value(name);
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(`${record.title}'s ${name} is recorded as "${raw}", which is not a whole number.`);
    }
    return BigInt(raw);
  };
  return {
    threadNftPolicy: value('thread_nft_policy'),
    poolValidatorHash: value('pool_vh'),
    redirectValidatorHash: value('redirect_vh'),
    treasuryValidatorHash: value('treasury_vh'),
    treasuryAddressHex: value('treasury_address'),
    feeNum: asInt('fee_num'),
    treasuryFee: asInt('treasury_fee'),
    royaltyFee: asInt('royalty_fee'),
    initialLq: asInt('initial_lq'),
  };
}

export interface OpeningPoolDatumInput {
  /** The launch's 32-byte id, hex. Both minted names are derived from it. */
  launchIdHex: string;
  /** The factory's own policy id — the hash of the APPLIED factory. */
  factoryPolicyId: string;
  /** The launch token: this is `pool_y`, the pool's non-ADA reserve. */
  tokenPolicyIdHex: string;
  tokenAssetNameHex: string;
  /**
   * The creator's fee-recipient PUBLIC KEY, not its hash. The factory checks
   * `blake2b_224(royalty_pub_key)` against the hash the LP escrow recorded at
   * genesis, so the key itself has to be supplied and cannot be recovered
   * from the escrow.
   */
  royaltyPubKeyHex: string;
}

/**
 * The pool's opening datum, rebuilt exactly as the factory's `expected` is.
 *
 * Every counter opens at zero and the nonce opens at zero: a pool that opened
 * with a treasury or royalty balance would be claiming fees nobody paid, and
 * one that opened at a non-zero nonce would have a history it never had.
 */
export function openingPoolDatum(params: VenueFactoryParameters, input: OpeningPoolDatumInput): VenuePoolConfigData {
  return {
    pool_nft: { policy: input.factoryPolicyId, name: venueAssetName('pool', input.launchIdHex) },
    pool_x: VENUE_ADA_ASSET,
    pool_y: { policy: input.tokenPolicyIdHex, name: input.tokenAssetNameHex },
    pool_lq: { policy: input.factoryPolicyId, name: venueAssetName('lq', input.launchIdHex) },
    fee_num: params.feeNum,
    treasury_fee: params.treasuryFee,
    royalty_fee: params.royaltyFee,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 0n,
    royalty_y: 0n,
    // Treasury first, redirect second — the pool reads its treasury authority
    // from entry 0 and its governance authority from entry 1, so the order is
    // load-bearing rather than cosmetic.
    dao_policy: [
      { StakingHash: [{ ScriptCredential: [params.treasuryValidatorHash] }] },
      { StakingHash: [{ ScriptCredential: [params.redirectValidatorHash] }] },
    ],
    treasury_address: params.treasuryAddressHex,
    royalty_pub_key: input.royaltyPubKeyHex,
    nonce: 0n,
  };
}

/** blake2b-224 of a hex string, hex — the hash the factory takes of the
 *  creator's key before comparing it with the escrow's record. */
export function blake2b224Hex(hex: string): string {
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  return Buffer.from(blake2b(bytes, { dkLen: 28 })).toString('hex');
}

/** `MintAction.Create` — the two integers are output indices, not counts. */
export function venueCreateRedeemer(launchIdHex: string, poolOutIx: number, escrowOutIx: number): Constr<Data> {
  return new Constr(0, [launchIdHex, BigInt(poolOutIx), BigInt(escrowOutIx)]);
}

/** What the factory mints in a graduation: one pool NFT, the whole LQ supply. */
export function venueMintedAssets(launchIdHex: string): Array<{ assetNameHex: string; quantity: bigint }> {
  return [
    { assetNameHex: venueAssetName('pool', launchIdHex), quantity: 1n },
    { assetNameHex: venueAssetName('lq', launchIdHex), quantity: VENUE_MAX_LQ_CAP },
  ];
}

export { VENUE_ROLES, venueAssetName };
