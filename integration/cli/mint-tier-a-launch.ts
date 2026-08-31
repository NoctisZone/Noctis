// ============================================================================
// Noctis Zone — Cardano genesis mint
// ============================================================================
// Builds the launch's genesis transaction and returns it UNSIGNED, for the
// creator's own browser wallet to sign. Same two-step build → sign → submit
// shape the rest of this project uses.
//
// WHY THE THREE STEPS ARE IN ONE PROCESS
// The order below is forced by the data, not by preference:
//
//   1. the launch token's policy id depends on which creator UTXO seeds the
//      one-shot, so it cannot be known before a seed is chosen;
//   2. launch_id is blake2b_256(policy_id ++ asset_name), so no genesis datum
//      can be built until that policy id exists;
//   3. the mint transaction has to place those exact datums.
//
// Splitting these across processes would mean passing a seed between them and
// trusting each side to pick the same one. Doing it in one pass makes it
// impossible for the datums to describe a different policy than the one the
// transaction actually mints under.
//
// WHY NOT ANVIL
// Anvil's transaction builder cannot attach a Plutus minting script — the same
// limitation that sent custom-redeemer spends to Lucid Evolution elsewhere in
// this codebase.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout
// (bigints stringified) or { error }.
// ============================================================================

import { mintingPolicyToId, scriptFromNative } from '@lucid-evolution/lucid';
import { type BuildGenesisDatumsInput, buildGenesisDatums } from '../tier-a-genesis-datums.js';
import { type GenesisOutput, TierAMintSubmitter } from '../tier-a-mint-submitter.js';
import type { ThreadNftRole } from '../tier-a-schemas.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireFieldsStrict,
} from './cli-io.js';

declare const __dirname: string;

interface Input extends Omit<BuildGenesisDatumsInput, 'tokenPolicyIdHex'> {
  blockfrostProjectId: string;
  blockfrostUrl: string;

  /** The creator's own wallet: it funds the mint, seeds the one-shot, and signs. */
  creatorAddress: string;

  /** Where the launch fee splits go. */
  platformAddress: string;
  platformLovelace: number;

  /** The platform's thread-NFT native policy is `sig(keyHash)` — the governor's. */
  governorKeyHashHex: string;
}

/**
 * Which validator each genesis output belongs to. `tokenMetadata` is deliberately
 * absent: it is authenticated by the CIP-68 reference NFT rather than a thread
 * NFT, since the launch's own policy already gives it a unique per-launch token.
 */
const OUTPUT_ROLES: Record<string, ThreadNftRole> = {
  bondingCurve: 'bondingCurve',
  vesting: 'vesting',
  lpEscrow: 'lpEscrow',
  ctoGovernance: 'ctoGovernance',
  stakingPool: 'stakingPool',
  zkAnchor: 'zkAnchor',
};

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Input>(raw);

  requireFieldsStrict(input, [
    'blockfrostProjectId',
    'blockfrostUrl',
    'creatorAddress',
    'platformAddress',
    'platformLovelace',
    'governorKeyHashHex',
  ]);

  // The datums name a thread-NFT policy and the transaction mints under one.
  // If those disagree, every state UTXO carries a token its own validator
  // rejects — and nothing surfaces it until the first spend, long after the
  // mint succeeded. Derived and compared here rather than trusted.
  const threadPolicyId = mintingPolicyToId(scriptFromNative({ type: 'sig', keyHash: input.governorKeyHashHex }));
  if (threadPolicyId !== input.threadNftPolicyIdHex) {
    throw new Error(
      `threadNftPolicyIdHex (${input.threadNftPolicyIdHex}) is not the policy the governor key ${input.governorKeyHashHex} mints under (${threadPolicyId}).`,
    );
  }

  const blueprint = loadPlutusBlueprint(__dirname);
  const submitter = new TierAMintSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    launchTokenPolicyCbor: loadValidatorCbor(blueprint, 'launch_token_policy.launch_token_policy.mint'),
  });

  const totalSupply = BigInt(input.totalSupply ?? 1_000_000_000);

  // 1. Seed and policy.
  const { seedUtxo, policyId, appliedPolicyCbor } = await submitter.resolveSeedAndPolicy(
    input.creatorAddress,
    totalSupply,
  );

  // 2. Genesis datums, against that policy id.
  const genesis = await buildGenesisDatums({ ...input, tokenPolicyIdHex: policyId });

  // 3. The outputs, in a fixed order so a caller reading the built transaction
  //    can match each one to its validator. The curve holds the sellable supply
  //    plus the LP and staking reserves; vesting holds the creator allocation;
  //    the rest hold min-ADA and their datum only.
  const curveRole: ThreadNftRole = genesis.tier === 'B' ? 'bondingCurveTierB' : 'bondingCurve';
  const outputs: GenesisOutput[] = [
    {
      address: genesis.addresses.bondingCurve,
      datumCbor: genesis.datums.bondingCurve,
      role: curveRole,
      lovelace: BigInt(genesis.minLovelace.bondingCurve as string),
      launchTokens: BigInt(
        genesis.supplySplit.curveSupply +
          genesis.supplySplit.lpReserveTokens +
          genesis.supplySplit.stakingReserveTokens,
      ),
    },
    {
      address: genesis.addresses.vesting,
      datumCbor: genesis.datums.vesting,
      role: OUTPUT_ROLES.vesting,
      lovelace: BigInt(genesis.minLovelace.vesting as string),
      launchTokens: BigInt(genesis.supplySplit.creatorAllocTokens),
    },
    {
      address: genesis.addresses.lpEscrow,
      datumCbor: genesis.datums.lpEscrow,
      role: OUTPUT_ROLES.lpEscrow,
      lovelace: BigInt(genesis.minLovelace.lpEscrow as string),
    },
    {
      address: genesis.addresses.ctoGovernance,
      datumCbor: genesis.datums.ctoGovernance,
      role: OUTPUT_ROLES.ctoGovernance,
      lovelace: BigInt(genesis.minLovelace.ctoGovernance as string),
    },
    {
      address: genesis.addresses.zkAnchor,
      datumCbor: genesis.datums.zkAnchor,
      role: OUTPUT_ROLES.zkAnchor,
      lovelace: BigInt(genesis.minLovelace.zkAnchor as string),
    },
    // The CIP-68 reference NFT's own UTXO. Its datum IS the launch's metadata,
    // and this is the only transaction that can ever create it — the one-shot
    // policy mints the pair here or not at all.
    {
      address: genesis.addresses.tokenMetadata,
      datumCbor: genesis.datums.tokenMetadata,
      role: OUTPUT_ROLES.ctoGovernance, // unused; the reference NFT authenticates this one
      lovelace: BigInt(genesis.minLovelace.tokenMetadata as string),
      holdsReferenceNft: true,
    },
  ];

  // Only when the creator opted in — otherwise there is no pool to create.
  if (genesis.datums.stakingPool && genesis.minLovelace.stakingPool) {
    outputs.splice(4, 0, {
      address: genesis.addresses.stakingPool,
      datumCbor: genesis.datums.stakingPool,
      role: OUTPUT_ROLES.stakingPool,
      lovelace: BigInt(genesis.minLovelace.stakingPool),
    });
  }

  // 4. The transaction.
  const { unsignedTxCbor } = await submitter.buildGenesisMint({
    creatorAddress: input.creatorAddress,
    platformAddress: input.platformAddress,
    platformLovelace: BigInt(input.platformLovelace),
    tokenBaseNameHex: input.tokenBaseNameHex,
    totalSupply,
    launchIdHex: genesis.launchIdHex,
    threadNftNativeScript: { type: 'sig', keyHash: input.governorKeyHashHex },
    genesisOutputs: outputs,
    seedUtxo,
    appliedPolicyCbor,
  });

  process.stdout.write(
    JSON.stringify(
      jsonSafe({
        transaction: unsignedTxCbor,
        policyId,
        launchIdHex: genesis.launchIdHex,
        tokenAssetNameHex: genesis.tokenAssetNameHex,
        referenceAssetNameHex: genesis.referenceAssetNameHex,
        seedUtxo: { txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex },
        addresses: genesis.addresses,
        supplySplit: genesis.supplySplit,
        bondingCurveScriptHash: genesis.bondingCurveScriptHash,
        ctoGovernanceScriptHash: genesis.ctoGovernanceScriptHash,
        minLovelace: genesis.minLovelace,
      }),
    ),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
