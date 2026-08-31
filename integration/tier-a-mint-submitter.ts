// ============================================================================
// Noctis Zone — Cardano genesis mint, built with Lucid Evolution
// ============================================================================
// Builds the launch's genesis transaction: mints the launch token and its
// CIP-68 reference NFT under a per-launch one-shot Plutus policy, mints this
// launch's thread NFTs, and creates every genesis state UTXO with its inline
// datum.
//
// The token and the reference NFT are one pair under one policy id, carrying
// CIP-67 labels 333 and 100 over the same base name — that shared policy and
// name is how a wallet holding the token finds the metadata describing it.
// Minting them together is also what lets the policy stay one-shot: CIP-68
// revises metadata by spending the reference NFT, never by minting, so the
// supply can be fixed forever while the metadata stays revisable.
//
// WHY NOT ANVIL
// Anvil's transaction builder has no way to attach a Plutus minting script —
// the same limitation that sent custom-redeemer spends to Lucid Evolution
// elsewhere in this codebase. The launch token's policy is now a parameterized
// Plutus one-shot, so the mint has to move with it.
//
// WHAT MOVES WITH IT
// The one-shot's uniqueness comes from consuming a seed UTXO out of the
// creator's own wallet, so the launch token no longer needs a platform policy
// key at all: no policy-wallet signature, and no time-lock window. The
// governor signature is still required, but only for the thread NFTs, which
// are minted under the platform's own native signature policy.
//
// Returns UNSIGNED CBOR for the creator's wallet to sign, the same two-step
// build → sign → submit shape token-metadata-submitter.ts uses.
// ============================================================================

import type { Address, LucidEvolution, Network as LucidNetwork, Native, UTxO } from '@lucid-evolution/lucid';
import {
  applyDoubleCborEncoding,
  applyParamsToScript,
  Blockfrost,
  Constr,
  Data,
  Lucid,
  mintingPolicyToId,
  scriptFromNative,
} from '@lucid-evolution/lucid';
import {
  assertValidCip68BaseName,
  cip68FungibleAssetName,
  cip68ReferenceAssetName,
  type ThreadNftRole,
  threadNftAssetNames,
} from './tier-a-schemas.js';

/** One genesis state UTXO: where it goes, what datum it carries, what it holds. */
export interface GenesisOutput {
  address: Address;
  /** CBOR hex from the genesis datum builder. */
  datumCbor: string;
  /** Which thread NFT authenticates this UTXO. */
  role: ThreadNftRole;
  /** Minimum lovelace, computed by the genesis builder from this output's real size. */
  lovelace: bigint;
  /** Launch tokens held here, if any (the curve and vesting outputs). */
  launchTokens?: bigint;
  /** Set on the one output that holds the CIP-68 reference NFT — the
   *  token_metadata UTXO whose datum IS the launch's metadata. */
  holdsReferenceNft?: boolean;
}

export interface TierAMintParams {
  creatorAddress: Address;
  /** Where the launch fee goes. One destination: the platform runs a single
   *  wallet, so there is no split to divide or verify. */
  platformAddress: Address;
  platformLovelace: bigint;
  /** The ticker as a creator typed it, hex-encoded — the CIP-68 BASE name.
   *  The two on-chain names are derived from it: label 333 for the token,
   *  label 100 for the reference NFT. Never pass an already-labelled name. */
  tokenBaseNameHex: string;
  totalSupply: bigint;
  /** blake2b_256(policy_id ++ asset_name) — full 32 bytes. */
  launchIdHex: string;
  /** The platform's thread-NFT native policy: `{ type: 'sig', keyHash }`. */
  threadNftNativeScript: Native;
  genesisOutputs: GenesisOutput[];
}

export interface TierAMintSubmitterConfig {
  blockfrostUrl: string;
  blockfrostProjectId: string;
  network: LucidNetwork;
  /** launch_token_policy.ak's compiled CBOR, UNAPPLIED — before its seed and
   *  total_supply parameters are applied. */
  launchTokenPolicyCbor: string;
}

export class TierAMintSubmitter {
  private lucidPromise: Promise<LucidEvolution>;

  constructor(private config: TierAMintSubmitterConfig) {
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  /**
   * Phase 1 — choose the seed UTXO and derive this launch's policy id.
   *
   * MUST run before the genesis datums are built. The policy id now depends on
   * which UTXO seeds the one-shot, and `launch_id` is
   * `blake2b_256(policy_id ++ asset_name)`, so neither the launch id nor any
   * datum embedding it can be computed until the seed is fixed. Under the old
   * native policy the id was known up front and this ordering did not exist.
   *
   * Split out rather than done inside the build so the dependency is explicit:
   * a caller cannot accidentally build datums against a policy id that the
   * builder then invalidates by picking a different seed.
   */
  async resolveSeedAndPolicy(
    creatorAddress: Address,
    totalSupply: bigint,
  ): Promise<{
    seedUtxo: UTxO;
    policyId: string;
    appliedPolicyCbor: string;
  }> {
    const lucid = await this.lucidPromise;
    const creatorUtxos = await lucid.utxosAt(creatorAddress);
    if (creatorUtxos.length === 0) {
      throw new Error(
        `No UTXOs at creator address ${creatorAddress} — the genesis mint is funded by, and seeded from, the creator's own wallet.`,
      );
    }
    // Any real UTXO the creator controls works: it is consumed either way, and
    // consuming it is the entire uniqueness argument. Picking the largest keeps
    // coin selection simple on a wallet holding many small UTXOs.
    const seedUtxo = creatorUtxos.reduce((a, b) => (b.assets.lovelace > a.assets.lovelace ? b : a));
    const appliedPolicyCbor = applyParamsToScript(
      applyDoubleCborEncoding(this.config.launchTokenPolicyCbor),
      // A real Constr, NOT Data.to(...). applyParamsToScript takes Data
      // values; Data.to returns CBOR *hex*, which is then applied as a
      // ByteArray rather than as the OutputReference constructor the policy
      // is parameterized on — the script is built, but with the wrong
      // parameter shape, and traps at run time.
      [new Constr(0, [seedUtxo.txHash, BigInt(seedUtxo.outputIndex)]), totalSupply],
    );
    return {
      seedUtxo,
      policyId: mintingPolicyToId({ type: 'PlutusV3', script: appliedPolicyCbor }),
      appliedPolicyCbor,
    };
  }

  /**
   * Phase 2 — build the unsigned genesis transaction.
   *
   * Takes the seed and applied policy from `resolveSeedAndPolicy`, so the
   * datums in `genesisOutputs` are guaranteed to have been built against the
   * same policy id this transaction actually mints under.
   */
  async buildGenesisMint(
    params: TierAMintParams & { seedUtxo: UTxO; appliedPolicyCbor: string },
  ): Promise<{ unsignedTxCbor: string; policyId: string }> {
    const lucid = await this.lucidPromise;
    const creatorUtxos = await lucid.utxosAt(params.creatorAddress);
    lucid.selectWallet.fromAddress(params.creatorAddress, creatorUtxos);

    const seedUtxo = params.seedUtxo;
    const launchPolicy = { type: 'PlutusV3' as const, script: params.appliedPolicyCbor };
    const policyId = mintingPolicyToId(launchPolicy);
    // Fails here rather than on-chain: the label costs 4 of the 32 bytes an
    // asset name has, so a ticker the wizard accepted can still be too long
    // once labelled.
    assertValidCip68BaseName(params.tokenBaseNameHex);
    const launchUnit = policyId + cip68FungibleAssetName(params.tokenBaseNameHex);
    const referenceUnit = policyId + cip68ReferenceAssetName(params.tokenBaseNameHex);

    const threadScript = scriptFromNative(params.threadNftNativeScript);
    const threadPolicyId = mintingPolicyToId(threadScript);
    const names = threadNftAssetNames(params.launchIdHex);
    const threadUnit = (role: ThreadNftRole) => threadPolicyId + names[role];

    let tx = lucid
      .newTx()
      // The seed must be an input or the policy cannot succeed. Named
      // explicitly rather than left to coin selection, which is free to skip it.
      .collectFrom([seedUtxo])
      // Both halves of the CIP-68 pair in one call — the policy requires
      // exactly these two assets and nothing else.
      .mintAssets({ [launchUnit]: params.totalSupply, [referenceUnit]: 1n }, Data.void())
      .attach.MintingPolicy(launchPolicy);

    // Thread NFTs: one per genesis output, under the platform's native policy.
    // Minted in the same transaction so a launch cannot exist in a state where
    // its state UTXOs are unauthenticated.
    const threadMint: Record<string, bigint> = {};
    for (const out of params.genesisOutputs) {
      if (!out.holdsReferenceNft) threadMint[threadUnit(out.role)] = 1n;
    }
    tx = tx.mintAssets(threadMint).attach.MintingPolicy(threadScript);

    // Launch fee — one output, one destination.
    tx = tx.pay.ToAddress(params.platformAddress, { lovelace: params.platformLovelace });

    for (const out of params.genesisOutputs) {
      const assets: Record<string, bigint> = { lovelace: out.lovelace };
      // The token_metadata output is authenticated by the reference NFT
      // itself rather than by a thread NFT — CIP-68 already gives it a
      // unique per-launch token under the launch's own policy, so a second
      // one would be redundant.
      if (out.holdsReferenceNft) {
        assets[referenceUnit] = 1n;
      } else {
        assets[threadUnit(out.role)] = 1n;
      }
      if (out.launchTokens && out.launchTokens > 0n) assets[launchUnit] = out.launchTokens;
      tx = tx.pay.ToContract(out.address, { kind: 'inline', value: out.datumCbor }, assets);
    }

    const built = await tx.addSigner(params.creatorAddress).complete();

    return { unsignedTxCbor: built.toCBOR(), policyId };
  }
}
