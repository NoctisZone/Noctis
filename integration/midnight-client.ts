// ============================================================================
// Noctis Zone — Midnight SDK Wrapper
// ============================================================================
// Wraps @midnight-ntwrk/midnight-js-contracts to provide a typed API for:
//   1. Deploying / reconnecting to all 8 Noctis PSM contracts
//   2. Calling circuit methods with the real, positional-argument `.callTx` API
//   3. Sequential cross-PSM operations (NOT atomic — see the note below)
//   4. Persisting/restoring contract addresses across sessions
//
// This is a rewrite against the REAL SDK, replacing an earlier version that
// was built against a fictional API shape (`sdk.deploy()`,
// `contract.call(name, argsRecord)`, `sdk.createMergedTransaction()` — none
// of which exist on any @midnight-ntwrk package). Verified against installed
// type declarations for:
//   @midnight-ntwrk/compact-js@2.5.1
//   @midnight-ntwrk/midnight-js-contracts@4.1.1
//   @midnight-ntwrk/midnight-js-protocol@4.1.1
//   @midnight-ntwrk/midnight-js-types@4.1.1
// — the last stable (pre-beta) release line, chosen because it depends on
// exactly compact-runtime@0.16.0 / onchain-runtime-v3@3.0.0, matching the
// compiler toolchain (compactc 0.31.1) the rest of this repo is built
// against. The 5.0.0-beta.4 line depends on release-candidate packages
// (compact-runtime@0.18.0-rc.1) that no publicly installable compactc
// version currently produces output for (`compact list` tops out at
// 0.31.1).
//
// `.callTx` IS NOT PER-CIRCUIT TYPE-CHECKED (see compact-adapter.ts's header
// for why — a real, confirmed limitation in this SDK version pairing, not a
// mistake here). Every `.callTx.<circuit>(...)` call below was verified by
// hand against that PSM's real compiled signature
// (contracts/midnight/compiled/<psm>/contract/index.d.ts) — get the
// argument order/count/types wrong here and TypeScript will NOT catch it.
//
// NO CROSS-PSM ATOMICITY: the real SDK's only transaction-batching
// primitive, `withContractScopedTransaction<C, PCK>`, is parameterized by a
// SINGLE contract type `C` — it batches multiple circuit calls against ONE
// contract, not calls across different contract types. There is no
// `createMergedTransaction()` or equivalent spanning multiple PSMs in the
// public API of midnight-js-contracts@4.1.1. Every "merged" operation below
// (buy + cap check, graduation, CTO execution, cancellation) is therefore a
// SEQUENCE of independent transactions, not one atomic transaction. This
// confirms CLAUDE.md's default (10-minute settlement window between
// DarkVeil close and public curve open) is still the operative assumption,
// not a conservative placeholder that real tooling has since superseded.
// ============================================================================

import * as CompiledContractOps from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { type ContractProviders, deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { Contract as BondingCurveContract } from '../contracts/midnight/compiled/bonding_curve/contract/index.js';
import { Contract as CreatorEscrowContract } from '../contracts/midnight/compiled/creator_escrow/contract/index.js';
import { Contract as CtoGovernanceContract } from '../contracts/midnight/compiled/cto_governance/contract/index.js';
import {
  Contract as EligibilityGateContract,
  type FairLaunchCert,
  type LaunchPhase,
} from '../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import { Contract as LpEscrowContract } from '../contracts/midnight/compiled/lp_escrow/contract/index.js';
import { Contract as TreasuryContract } from '../contracts/midnight/compiled/treasury/contract/index.js';
import { Contract as VestingContract } from '../contracts/midnight/compiled/vesting/contract/index.js';
import {
  type BondingCurveWitnesses,
  bondingCurveWitnesses,
  type CreatorEscrowWitnesses,
  type CtoGovernanceWitnesses,
  creatorEscrowWitnesses,
  ctoGovernanceWitnesses,
  DOMAINS,
  deriveUserPublicKey,
  type EligibilityGateWitnesses,
  eligibilityGateWitnesses,
  type LpEscrowWitnesses,
  lpEscrowWitnesses,
  type MerkleProofEntry,
  type PrivateState,
  type TreasuryWitnesses,
  treasuryWitnesses,
  type UserSecretKey,
  type VestingWitnesses,
  vestingWitnesses,
} from '../contracts/midnight/witnesses.js';
import { asEffectContract } from './compact-adapter.js';
import { buyCost, type CurveParams } from './curve-pricing.js';
import { deferCircuitsForDeploy, deriveContractSigningKey } from './midnight-deploy-subset.js';
import { type DarkVeilSnapshot, readDarkVeilSnapshot, readEligibilityGateLedger } from './midnight-public-state.js';

// ============================================================================
// PER-PSM COMPILED CONTRACT FACTORIES
// ============================================================================
// Each factory takes the real witness object for that PSM (built per-call
// from the caller's own secret keys — never shared, never baked into a
// module-level constant) and returns a ready-to-deploy/-find
// `CompiledContract`. Every witnesses.ts factory now returns the real
// `(context) => [privateState, value]` tuple shape (fixed 2026-07-09 —
// previously returned bare `() => value` getters, which never matched any
// compiled contract's actual `Witnesses<PS>` type).

const COMPILED_ASSETS_ROOT = '../contracts/midnight/compiled';

/**
 * @param deferCircuits Circuits the DEPLOY should leave out, to be added
 * afterwards by maintenance update. Only ever pass this when deploying — every
 * other use needs the whole contract, or the deferred circuits are unreachable.
 */
export function compileEligibilityGate(witnesses: EligibilityGateWitnesses, deferCircuits: readonly string[] = []) {
  const contract =
    deferCircuits.length === 0
      ? EligibilityGateContract
      : deferCircuitsForDeploy(EligibilityGateContract, deferCircuits).contract;
  return CompiledContractOps.make('eligibility_gate', asEffectContract<PrivateState>(contract)).pipe(
    CompiledContractOps.withWitnesses(witnesses),
    CompiledContractOps.withCompiledFileAssets(`${COMPILED_ASSETS_ROOT}/eligibility_gate`),
  );
}

function compileBondingCurve(witnesses: BondingCurveWitnesses) {
  return CompiledContractOps.make('bonding_curve', asEffectContract<PrivateState>(BondingCurveContract)).pipe(
    CompiledContractOps.withWitnesses(witnesses),
    CompiledContractOps.withCompiledFileAssets(`${COMPILED_ASSETS_ROOT}/bonding_curve`),
  );
}

function compileCreatorEscrow(witnesses: CreatorEscrowWitnesses) {
  return CompiledContractOps.make('creator_escrow', asEffectContract<PrivateState>(CreatorEscrowContract)).pipe(
    CompiledContractOps.withWitnesses(witnesses),
    CompiledContractOps.withCompiledFileAssets(`${COMPILED_ASSETS_ROOT}/creator_escrow`),
  );
}

function compileVesting(witnesses: VestingWitnesses) {
  return CompiledContractOps.make('vesting', asEffectContract<PrivateState>(VestingContract)).pipe(
    CompiledContractOps.withWitnesses(witnesses),
    CompiledContractOps.withCompiledFileAssets(`${COMPILED_ASSETS_ROOT}/vesting`),
  );
}

function compileLpEscrow(witnesses: LpEscrowWitnesses) {
  return CompiledContractOps.make('lp_escrow', asEffectContract<PrivateState>(LpEscrowContract)).pipe(
    CompiledContractOps.withWitnesses(witnesses),
    CompiledContractOps.withCompiledFileAssets(`${COMPILED_ASSETS_ROOT}/lp_escrow`),
  );
}

function compileTreasury(witnesses: TreasuryWitnesses) {
  return CompiledContractOps.make('treasury', asEffectContract<PrivateState>(TreasuryContract)).pipe(
    CompiledContractOps.withWitnesses(witnesses),
    CompiledContractOps.withCompiledFileAssets(`${COMPILED_ASSETS_ROOT}/treasury`),
  );
}

function compileCtoGovernance(witnesses: CtoGovernanceWitnesses) {
  return CompiledContractOps.make('cto_governance', asEffectContract<PrivateState>(CtoGovernanceContract)).pipe(
    CompiledContractOps.withWitnesses(witnesses),
    CompiledContractOps.withCompiledFileAssets(`${COMPILED_ASSETS_ROOT}/cto_governance`),
  );
}

// ============================================================================
// TYPES
// ============================================================================

// `.callTx` is not per-circuit typed regardless of which concrete PSM class
// backs a handle (see compact-adapter.ts) — every handle below is
// structurally the same shape. Kept as separate named fields on the client
// (rather than one indexed map) purely for call-site clarity about which
// PSM a handle belongs to.
type PsmHandle = Awaited<ReturnType<typeof deployContract>> | Awaited<ReturnType<typeof findDeployedContract>>;

/** What we persist across sessions per PSM — enough to reconnect via findDeployedContract. */
export interface PsmRecord {
  contractAddress: string;
  deployedAt: number; // POSIX timestamp
  /**
   * Circuits the deploy left out, still to be added by maintenance update.
   * Present and non-empty means the contract on chain cannot yet answer a call
   * to these — whoever holds this record needs to know that before relying on
   * one. Absent or empty means the contract carries its whole circuit set.
   */
  pendingCircuits?: string[];
}

export interface NoctisDeployments {
  eligibilityGate: PsmRecord | null;
  bondingCurve: PsmRecord | null;
  creatorEscrow: PsmRecord | null;
  vesting: PsmRecord | null;
  lpEscrow: PsmRecord | null;
  treasury: PsmRecord | null;
  ctoGovernance: PsmRecord | null;
}

function toRecord(handle: PsmHandle, pendingCircuits: readonly string[] = []): PsmRecord {
  return {
    contractAddress: String(handle.deployTxData.public.contractAddress),
    deployedAt: Math.floor(Date.now() / 1000),
    ...(pendingCircuits.length > 0 ? { pendingCircuits: [...pendingCircuits] } : {}),
  };
}

// ============================================================================
// MIDNIGHT SDK WRAPPER
// ============================================================================

/**
 * Real, typed wrapper around @midnight-ntwrk/midnight-js-contracts for
 * Noctis PSM operations. One instance per launch for six of the seven
 * PSMs (each of those belongs to exactly one launch — Noctis does not
 * share their deployments across launches). `treasury` is the one
 * exception: per treasury.compact's own header, it is a single shared pool
 * across ALL launches and BOTH currencies — connect the SAME already-
 * deployed treasury instance (via `connectTreasury`) for every launch
 * rather than deploying a fresh one each time.
 *
 * Phase 2 security-audit fix (2026-07-11): darkveil.compact retired as a
 * standalone deployment — its logic is merged into `eligibilityGate`
 * (Cardano Launch) and was already merged into `bondingCurve` (Midnight Launch).
 * There is no separate `darkveil` field anymore; every DarkVeil-related
 * circuit call in NoctisLaunchManager below now routes through whichever
 * of `eligibilityGate`/`bondingCurve` is connected for a given launch.
 */
export class NoctisMidnightClient {
  private userSecretKey: UserSecretKey;
  private governorSecretKey: UserSecretKey;

  /**
   * Kept from whichever providers this client was last deployed or connected
   * with, so published ledger fields can be read straight off the indexer.
   * Reading public state needs no wallet, no proof server and no transaction —
   * see integration/midnight-public-state.ts.
   */
  private publicDataProvider: PublicDataProvider | null = null;

  eligibilityGate: PsmHandle | null = null;
  bondingCurve: PsmHandle | null = null;
  creatorEscrow: PsmHandle | null = null;
  vesting: PsmHandle | null = null;
  lpEscrow: PsmHandle | null = null;
  treasury: PsmHandle | null = null;
  ctoGovernance: PsmHandle | null = null;

  constructor(userSecretKey: UserSecretKey, governorSecretKey?: UserSecretKey) {
    this.userSecretKey = userSecretKey;
    this.governorSecretKey = governorSecretKey ?? userSecretKey;
  }

  /**
   * The caller's public key for ONE launch, derived the same way the
   * eligibility gate / merged Midnight Launch bonding curve circuit expects it,
   * using the real `persistentHash`-based derivation under the unified
   * post-merge domain (`'noctis:user:pk:v1'`).
   *
   * `launchId` must be the 32 bytes the target contract was deployed with:
   * identity is scoped per launch, so the same secret yields a different key
   * for every launch, and a key derived under the wrong one matches nothing
   * on-chain. It is a parameter rather than constructor state because
   * `treasury` is shared across launches while the other six PSMs are not —
   * see this class's own header.
   */
  callerPublicKeyFor(launchId: Uint8Array): Uint8Array {
    return deriveUserPublicKey(this.userSecretKey, DOMAINS.ELIGIBILITY_USER, launchId).bytes;
  }

  /**
   * Records the public data provider on the way past, so published ledger
   * fields stay readable for as long as this client is connected. Returns the
   * providers untouched — it sits in the argument position of every deploy and
   * connect call rather than being a step each one has to remember to make.
   */
  private remembering(providers: ContractProviders): ContractProviders {
    this.publicDataProvider = providers.publicDataProvider;
    return providers;
  }

  /**
   * The provider used to read published state, and the address of whichever
   * DarkVeil-bearing contract is connected.
   *
   * @throws if no such contract is connected, naming both fields checked.
   */
  darkVeilPublicRead(): { publicDataProvider: PublicDataProvider; contractAddress: string } {
    const handle = this.eligibilityGate ?? this.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    if (!this.publicDataProvider) {
      throw new Error('No public data provider is available — this client was connected without one.');
    }
    return {
      publicDataProvider: this.publicDataProvider,
      contractAddress: String(handle.deployTxData.public.contractAddress),
    };
  }

  /** True when a Cardano Launch eligibility gate is the connected DarkVeil contract. */
  isTierB(): boolean {
    return this.eligibilityGate !== null;
  }

  // --- Eligibility Gate (Cardano Launch — merged with DarkVeil, Phase 2 2026-07-11) ---
  //
  // Security-audit fix: eligibility_gate.compact absorbed darkveil.compact's
  // circuits and ledger state (mirrors the Midnight Launch merge) so
  // claimRatioBondRefund can read a registrant's real DarkVeil purchase
  // total — Compact has no cross-contract call to do that across two
  // separate deployments. deployDarkVeil/connectDarkVeil are gone; this
  // single deploy now covers both registration AND private buying for
  // Cardano Launch.

  async deployEligibilityGate(
    providers: ContractProviders,
    args: {
      launchId: Uint8Array;
      allowlistRoot: Uint8Array;
      totalSupply: bigint;
      maxWalletPercent: bigint;
      bondAmount: bigint;
      walletCap: bigint;
      dvAllocation: bigint;
      dvPrice: bigint;
      allowlistSize: bigint;
      registrationCloseTime: bigint;
      // Minimum absolute registrant count required before startBuying()
      // will allow the Registration -> Buying transition. CLAUDE.md:
      // MIN_DV_PARTICIPANTS = 15.
      minDvParticipants: bigint;
      // Creator's identity under this contract's own domain (see
      // packages/zk-proofs/src/eligibility-gate.ts's deriveUserPublicKey)
      // — blocks the creator from registering, revealing a DarkVeil buy,
      // or (formerly) buying on the public curve.
      creatorPubKey: Uint8Array;
      // Real unshielded addresses (not derived identities) the
      // forfeited portion of a ratio-based bond refund is split 60/40 to.
      /** One platform wallet: the treasury/ops split is gone here, so a
       *  forfeited bond has a single destination. */
      platformAddr: Uint8Array;
      /**
       * The three keys that may attest this contract's allowlist root, and how
       * many it takes. Each contract carries its own set — nothing here can
       * read another contract's ledger, so a shared one is not possible.
       *
       * Three DISTINCT holders, or the threshold is decorative: the contract
       * rejects duplicate keys but cannot tell one person holding two of them
       * from two people.
       */
      allowlistAttestorKeys: [Uint8Array, Uint8Array, Uint8Array];
      allowlistThreshold: bigint;
    },
    merkleProof: MerkleProofEntry[],
    buyNonce: Uint8Array,
    /**
     * Circuits this deploy leaves out, added afterwards by maintenance update.
     * A deploy writes the whole contract state at once and a block caps the
     * bytes written in it, so this is how a contract whose verifier keys total
     * more than that budget reaches the chain intact.
     *
     * The returned record names them, and names the signing key's owner, so a
     * caller cannot complete the deploy without knowing what is outstanding.
     */
    deferCircuits: readonly string[] = [],
  ): Promise<PsmRecord> {
    const witnesses = eligibilityGateWitnesses(this.userSecretKey, merkleProof, buyNonce, this.governorSecretKey);
    const compiled = compileEligibilityGate(witnesses, deferCircuits);
    const deployed = await deployContract(this.remembering(providers), {
      // Derived rather than sampled, so the authority that can complete this
      // deploy survives the process that started it — see
      // deriveContractSigningKey.
      signingKey: deriveContractSigningKey(this.governorSecretKey.bytes, args.launchId),
      compiledContract: compiled,
      args: [
        args.launchId,
        args.allowlistRoot,
        args.totalSupply,
        args.maxWalletPercent,
        args.bondAmount,
        args.walletCap,
        args.dvAllocation,
        args.dvPrice,
        args.allowlistSize,
        args.registrationCloseTime,
        args.minDvParticipants,
        args.creatorPubKey,
        args.platformAddr,
        args.allowlistAttestorKeys[0],
        args.allowlistAttestorKeys[1],
        args.allowlistAttestorKeys[2],
        args.allowlistThreshold,
      ],
    });
    this.eligibilityGate = deployed;
    return toRecord(deployed, deferCircuits);
  }

  async connectEligibilityGate(
    providers: ContractProviders,
    contractAddress: string,
    merkleProof: MerkleProofEntry[],
    buyNonce: Uint8Array,
    /**
     * Membership in the REGISTRANT tree, which `submitBuyCommit` verifies
     * against the root published at `startBuying`. A different tree from the
     * allowlist, published at a different time — so a caller submitting a buy
     * commitment must supply it. Omitted, the witness falls back to the
     * allowlist proof, which verifies against the wrong root.
     */
    registrantProof?: MerkleProofEntry[],
  ): Promise<void> {
    const witnesses = eligibilityGateWitnesses(
      this.userSecretKey,
      merkleProof,
      buyNonce,
      this.governorSecretKey,
      registrantProof,
    );
    const compiled = compileEligibilityGate(witnesses);
    // NO `privateStateId` HERE, DELIBERATELY. This contract's private state is
    // `undefined` — every witness closes over its secret rather than
    // accumulating state across calls (see witnesses.ts's `PrivateState`) — and
    // the SDK branches on whether the KEY is present, not on its value. Given
    // the key, it fetches the stored private state and asserts it is defined,
    // which `undefined` can never satisfy: the call fails with "No private
    // state found" no matter what was stored or how persistent the store is.
    // Omitting it selects the SDK's own path for contracts that have no private
    // state, which is what this one is.
    this.eligibilityGate = await findDeployedContract(this.remembering(providers), {
      compiledContract: compiled,
      contractAddress,
    });
  }

  // --- Bonding Curve (Midnight Launch only, NIGHT-denominated) ---
  // Cardano Launch's public bonding curve moved to Cardano/Aiken
  // (contracts/cardano/bonding_curve_tier_b.ak) and is deployed/called
  // through the Cardano tx-building path, not this Midnight client.
  //
  // Fix (2026-07-10, extended same day): this is now the MERGED
  // eligibility_gate + darkveil + bonding_curve contract for Midnight Launch (see
  // bonding_curve.compact's file header — a 3-way merge). The constructor
  // and witnesses take all three halves' requirements — there is no
  // separate eligibilityGateAddr any more, since it's the same contract,
  // not a cross-contract reference. For Midnight Launch, this single deployment is
  // what registerForDarkVeil/checkAndUpdateCap/claimBondRefund/
  // submitBuyCommit/revealBuyCommit/etc. all get called against — Midnight Launch
  // has no separate eligibilityGate or darkveil deployment at all (those
  // client fields stay reserved for Cardano Launch, which still deploys both
  // standalone).

  async deployBondingCurve(
    providers: ContractProviders,
    args: {
      launchId: Uint8Array;
      allowlistRoot: Uint8Array;
      totalSupply: bigint;
      maxWalletPercent: bigint;
      bondAmount: bigint;
      walletCap: bigint;
      basePrice: bigint;
      maxPrice: bigint;
      curveSupply: bigint;
      dvAllocation: bigint;
      dvPrice: bigint;
      allowlistSize: bigint;
      registrationCloseTime: bigint;
      // Minimum absolute registrant count required before startBuying()
      // will allow the Registration -> Buying transition. CLAUDE.md:
      // MIN_DV_PARTICIPANTS = 15.
      minDvParticipants: bigint;
      // Creator's identity under this merged contract's unified
      // domain (see packages/zk-proofs/src/eligibility-gate.ts's
      // deriveUserPublicKey) — blocks the creator from registering,
      // revealing a DarkVeil buy, or buying on the public curve.
      creatorPubKey: Uint8Array;
      // Real unshielded addresses (not derived identities) forfeited
      // DarkVeil bond NIGHT is split 60/40 to via claimRatioBondRefund.
      /** One platform wallet. */
      platformAddr: Uint8Array;
      // Design requirement: real unshielded payout addresses
      // withdrawFees/graduateLp pay out to — distinct from creatorPubKey
      // (an auth identity, not a payment destination). Both required by
      // the current constructor; this deploy call previously omitted them
      // entirely, which would have failed at deploy time with an arity
      // mismatch against the real compiled contract.
      creatorAddr: Uint8Array;
      lpEscrowAddr: Uint8Array;
      /**
       * The three keys that may attest this contract's allowlist root, and how
       * many it takes. Each contract carries its own set — nothing here can
       * read another contract's ledger, so a shared one is not possible.
       *
       * Three DISTINCT holders, or the threshold is decorative: the contract
       * rejects duplicate keys but cannot tell one person holding two of them
       * from two people.
       */
      allowlistAttestorKeys: [Uint8Array, Uint8Array, Uint8Array];
      allowlistThreshold: bigint;
    },
    merkleProof: MerkleProofEntry[],
    buyNonce: Uint8Array,
  ): Promise<PsmRecord> {
    const witnesses = bondingCurveWitnesses(this.userSecretKey, merkleProof, buyNonce, this.governorSecretKey);
    const compiled = compileBondingCurve(witnesses);
    const deployed = await deployContract(this.remembering(providers), {
      compiledContract: compiled,
      args: [
        args.launchId,
        args.allowlistRoot,
        args.totalSupply,
        args.maxWalletPercent,
        args.bondAmount,
        args.walletCap,
        args.basePrice,
        args.maxPrice,
        args.curveSupply,
        args.dvAllocation,
        args.dvPrice,
        args.allowlistSize,
        args.registrationCloseTime,
        args.minDvParticipants,
        args.creatorPubKey,
        args.platformAddr,
        args.creatorAddr,
        args.lpEscrowAddr,
        args.allowlistAttestorKeys[0],
        args.allowlistAttestorKeys[1],
        args.allowlistAttestorKeys[2],
        args.allowlistThreshold,
      ],
    });
    this.bondingCurve = deployed;
    return toRecord(deployed);
  }

  async connectBondingCurve(
    providers: ContractProviders,
    contractAddress: string,
    merkleProof: MerkleProofEntry[],
    buyNonce: Uint8Array,
  ): Promise<void> {
    const witnesses = bondingCurveWitnesses(this.userSecretKey, merkleProof, buyNonce, this.governorSecretKey);
    const compiled = compileBondingCurve(witnesses);
    // No `privateStateId`, deliberately — see connectEligibilityGate.
    this.bondingCurve = await findDeployedContract(this.remembering(providers), {
      compiledContract: compiled,
      contractAddress,
    });
  }

  // --- Creator Escrow ---

  async deployCreatorEscrow(
    providers: ContractProviders,
    args: { launchId: Uint8Array; currency: number },
    communitySk?: UserSecretKey,
  ): Promise<PsmRecord> {
    const witnesses = creatorEscrowWitnesses(this.userSecretKey, this.governorSecretKey, communitySk);
    const compiled = compileCreatorEscrow(witnesses);
    const deployed = await deployContract(this.remembering(providers), {
      compiledContract: compiled,
      args: [args.launchId, args.currency],
    });
    this.creatorEscrow = deployed;
    return toRecord(deployed);
  }

  async connectCreatorEscrow(
    providers: ContractProviders,
    contractAddress: string,
    communitySk?: UserSecretKey,
  ): Promise<void> {
    const witnesses = creatorEscrowWitnesses(this.userSecretKey, this.governorSecretKey, communitySk);
    const compiled = compileCreatorEscrow(witnesses);
    // No `privateStateId`, deliberately — see connectEligibilityGate.
    this.creatorEscrow = await findDeployedContract(this.remembering(providers), {
      compiledContract: compiled,
      contractAddress,
    });
  }

  // --- Vesting ---

  async deployVesting(
    providers: ContractProviders,
    args: {
      launchId: Uint8Array;
      tokenAllocation: bigint;
      vestDays: bigint;
      /** The launch supply `tokenAllocation` is a share of — sealed alongside it. */
      totalSupply: bigint;
      /** CLAUDE.md: CREATOR_ALLOC_MAX. The constructor refuses an allocation above this share. */
      maxCreatorPercent: bigint;
    },
  ): Promise<PsmRecord> {
    const witnesses = vestingWitnesses(this.userSecretKey, this.governorSecretKey);
    const compiled = compileVesting(witnesses);
    const deployed = await deployContract(this.remembering(providers), {
      compiledContract: compiled,
      args: [args.launchId, args.tokenAllocation, args.vestDays, args.totalSupply, args.maxCreatorPercent],
    });
    this.vesting = deployed;
    return toRecord(deployed);
  }

  async connectVesting(providers: ContractProviders, contractAddress: string): Promise<void> {
    const witnesses = vestingWitnesses(this.userSecretKey, this.governorSecretKey);
    const compiled = compileVesting(witnesses);
    // No `privateStateId`, deliberately — see connectEligibilityGate.
    this.vesting = await findDeployedContract(this.remembering(providers), {
      compiledContract: compiled,
      contractAddress,
    });
  }

  // --- LP Escrow ---

  async deployLpEscrow(
    providers: ContractProviders,
    args: { launchId: Uint8Array; lockDuration: bigint },
    communitySk?: UserSecretKey,
  ): Promise<PsmRecord> {
    const witnesses = lpEscrowWitnesses(this.governorSecretKey, communitySk);
    const compiled = compileLpEscrow(witnesses);
    const deployed = await deployContract(this.remembering(providers), {
      compiledContract: compiled,
      args: [args.launchId, args.lockDuration],
    });
    this.lpEscrow = deployed;
    return toRecord(deployed);
  }

  async connectLpEscrow(
    providers: ContractProviders,
    contractAddress: string,
    communitySk?: UserSecretKey,
  ): Promise<void> {
    const witnesses = lpEscrowWitnesses(this.governorSecretKey, communitySk);
    const compiled = compileLpEscrow(witnesses);
    // No `privateStateId`, deliberately — see connectEligibilityGate.
    this.lpEscrow = await findDeployedContract(this.remembering(providers), {
      compiledContract: compiled,
      contractAddress,
    });
  }

  // --- Treasury ---

  /**
   * Resolution (2026-07-10): treasury.compact's constructor now takes floor/warning
   * thresholds (lovelace, ADA-equivalent) instead of just launchId — see
   * that file's header for why these live at deploy time (platform-wide
   * constant, same status as bonding_curve.ak's max_curve_duration).
   * Defaults match CLAUDE.md's figures (10,000 / 25,000 ADA) unless
   * overridden.
   */
  async deployTreasury(
    providers: ContractProviders,
    args: {
      launchId: Uint8Array;
      floorLovelace?: bigint;
      warningLovelace?: bigint;
      /** How fast the treasury may be drawn down — see the contract's own note. */
      withdrawalWindowSeconds?: bigint;
      adaWithdrawalLimitPerWindow?: bigint;
      nightWithdrawalLimitPerWindow?: bigint;
    },
  ): Promise<PsmRecord> {
    const witnesses = treasuryWitnesses(this.governorSecretKey);
    const compiled = compileTreasury(witnesses);
    const deployed = await deployContract(this.remembering(providers), {
      compiledContract: compiled,
      args: [
        args.launchId,
        args.floorLovelace ?? TREASURY_FLOOR_LOVELACE,
        args.warningLovelace ?? TREASURY_WARNING_LOVELACE,
        args.withdrawalWindowSeconds ?? TREASURY_WITHDRAWAL_WINDOW_SECONDS,
        args.adaWithdrawalLimitPerWindow ?? TREASURY_ADA_WITHDRAWAL_LIMIT,
        args.nightWithdrawalLimitPerWindow ?? TREASURY_NIGHT_WITHDRAWAL_LIMIT,
      ],
    });
    this.treasury = deployed;
    return toRecord(deployed);
  }

  async connectTreasury(providers: ContractProviders, contractAddress: string): Promise<void> {
    const witnesses = treasuryWitnesses(this.governorSecretKey);
    const compiled = compileTreasury(witnesses);
    // No `privateStateId`, deliberately — see connectEligibilityGate.
    this.treasury = await findDeployedContract(this.remembering(providers), {
      compiledContract: compiled,
      contractAddress,
    });
  }

  // --- CTO Governance ---

  /**
   * Design requirement: the constructor now takes a 5th
   * `creatorPubKey` arg (derives `isCreator` in-circuit instead of trusting
   * a caller-supplied flag), and `ctoGovernanceWitnesses` now requires
   * `balanceLeafAmount`/`balanceProof` — the voter's real token balance and
   * Merkle proof against the governor-published `balanceSnapshotRoot`.
   *
   * These two witnesses are baked into the Contract instance at
   * construction time (this class's existing pattern for every PSM), but
   * are only actually meaningful right before a `castVote` call — a real
   * voter's balance/proof can change between deploy/connect time and
   * whenever they actually vote. Callers that need to cast a vote should
   * call `connectCtoGovernance` again immediately before `castVote` with
   * their then-current balance and a proof built against whatever root is
   * pinned on the specific proposal they're voting on (see
   * `packages/zk-proofs/src/cto-governance.ts`'s `buildBalanceSnapshotTree`).
   * `deployCtoGovernance` (governor-only, no vote cast at deploy time) can
   * safely leave these at their defaults.
   */
  async deployCtoGovernance(
    providers: ContractProviders,
    args: {
      launchId: Uint8Array;
      totalSupply: bigint;
      graduationTimestamp: bigint;
      /**
       * Anti-whale-takeover fix (2026-07-28): replaces the old creator-only
       * `creatorVoteCap` — every voter, creator included, is now held
       * to this same absolute cap. See cto_governance.compact's own
       * `maxVoterCap` doc comment.
       */
      maxVoterCap: bigint;
      /** Anti-whale-takeover fix (2026-07-28): minimum distinct voters required for quorum — see cto_governance.compact's `minVoterCount`. */
      minVoterCount: bigint;
      creatorPubKey: Uint8Array;
      /**
       * Fix (2026-07-12): whether this launch's bonding-curve fee
       * escrow held a real, nonzero balance at graduation. Pass `false`
       * for a genuinely zero-volume launch — `createProposal` now hard-
       * rejects a SilenceLockTrigger proposal until the governor attests
       * (via `updateCreatorActivity`) that a real balance exists.
       */
      hasClaimableBalance: boolean;
      /**
       * Break-glass fix (2026-07-19): minimum NIGHT bond required to open a
       * bonded challenge overriding a withheld hasClaimableBalance
       * attestation — see cto_governance.compact's file-header BREAK-GLASS
       * FALLBACK note. Launch-specific, like maxVoterCap, not a
       * hardcoded platform constant.
       */
      breakGlassBondMin: bigint;
      /** Fixed payout address for a forfeited (rebutted) break-glass bond. One
       *  platform wallet, so the whole bond goes here. */
      platformAddr: Uint8Array;
      /**
       * The three keys that may attest the balance snapshot, and how many of
       * them a root needs. Two of three by default.
       *
       * They must be three DISTINCT keys held by three different people: the
       * contract rejects duplicates, but it cannot tell one person holding
       * two of them from two people, and a threshold met by one holder is a
       * threshold in name only.
       */
      attestorKeys: [Uint8Array, Uint8Array, Uint8Array];
      attestThreshold: bigint;
    },
    balanceLeafAmount = 0n,
    balanceProof: MerkleProofEntry[] = [],
  ): Promise<PsmRecord> {
    const witnesses = ctoGovernanceWitnesses(
      this.userSecretKey,
      balanceLeafAmount,
      balanceProof,
      this.governorSecretKey,
    );
    const compiled = compileCtoGovernance(witnesses);
    const deployed = await deployContract(this.remembering(providers), {
      compiledContract: compiled,
      args: [
        args.launchId,
        args.totalSupply,
        args.graduationTimestamp,
        args.maxVoterCap,
        args.minVoterCount,
        args.creatorPubKey,
        args.hasClaimableBalance,
        args.breakGlassBondMin,
        args.platformAddr,
        args.attestorKeys[0],
        args.attestorKeys[1],
        args.attestorKeys[2],
        args.attestThreshold,
      ],
    });
    this.ctoGovernance = deployed;
    return toRecord(deployed);
  }

  /**
   * Anti-whale-takeover fix (2026-07-28): `balanceLeafHeldSince` added —
   * the timestamp the governor's published snapshot first observed this
   * voter holding their leaf's balance. Must match whatever value was
   * baked into the leaf `buildBalanceSnapshotTree` hashed for this voter
   * (see cto-balance-snapshot-builder.ts's `heldSinceTimestamp`), or the
   * Merkle proof simply won't verify.
   */
  async connectCtoGovernance(
    providers: ContractProviders,
    contractAddress: string,
    balanceLeafAmount = 0n,
    balanceProof: MerkleProofEntry[] = [],
    balanceLeafHeldSince = 0n,
  ): Promise<void> {
    const witnesses = ctoGovernanceWitnesses(
      this.userSecretKey,
      balanceLeafAmount,
      balanceProof,
      this.governorSecretKey,
      balanceLeafHeldSince,
    );
    const compiled = compileCtoGovernance(witnesses);
    // No `privateStateId`, deliberately — see connectEligibilityGate.
    this.ctoGovernance = await findDeployedContract(this.remembering(providers), {
      compiledContract: compiled,
      contractAddress,
    });
  }

  // --- Deployment persistence ---

  getDeployments(): NoctisDeployments {
    return {
      eligibilityGate: this.eligibilityGate ? toRecord(this.eligibilityGate) : null,
      bondingCurve: this.bondingCurve ? toRecord(this.bondingCurve) : null,
      creatorEscrow: this.creatorEscrow ? toRecord(this.creatorEscrow) : null,
      vesting: this.vesting ? toRecord(this.vesting) : null,
      lpEscrow: this.lpEscrow ? toRecord(this.lpEscrow) : null,
      treasury: this.treasury ? toRecord(this.treasury) : null,
      ctoGovernance: this.ctoGovernance ? toRecord(this.ctoGovernance) : null,
    };
  }
}

// ============================================================================
// HIGH-LEVEL API — LAUNCH LIFECYCLE
// ============================================================================
// Every method below that touches more than one PSM (marked "sequential, not
// atomic") issues its calls one at a time and returns after all of them
// settle. See the file header — there is no SDK-level way to make
// these atomic today. Callers that need transactional safety across PSMs
// must apply their own compensation/retry logic, or wait on that
// resolution (confirmation from Midnight engineering, per CLAUDE.md).

const BONDING_CURVE_CREATOR_BPS = 50n;
const BONDING_CURVE_PLATFORM_BPS = 100n;
const BPS_DENOMINATOR = 10000n;

/**
 * Computes the two fee-slice arguments `buyTokens` requires
 * (claimedCreatorFee/claimedPlatformFee), matching bonding_curve.compact's
 * `verifyFeeSlice` floor-division check at 0.5% / 1.0% of gross payment.
 */
export function computeBondingCurveFees(grossPayment: bigint): {
  creatorFee: bigint;
  platformFee: bigint;
} {
  return {
    creatorFee: (grossPayment * BONDING_CURVE_CREATOR_BPS) / BPS_DENOMINATOR,
    platformFee: (grossPayment * BONDING_CURVE_PLATFORM_BPS) / BPS_DENOMINATOR,
  };
}

/**
 * Computes the `claimedRefund` argument `claimRatioBondRefund` requires
 * (2026-07-10) — CLAUDE.md's ratio formula:
 * `NIGHT_returned = NIGHT_bonded * tokens_purchased / tokens_allocated`,
 * floored (Compact can't divide in-circuit, so the contract only verifies
 * this is the correct floor of the true value — this is where that floor
 * actually gets computed). `tokensAllocated` is the launch's `baseSlot`
 * (same value for every registrant); `tokensPurchased` is this specific
 * buyer's own DarkVeil-phase purchase total.
 */
export function computeRatioBondRefund(bondAmount: bigint, tokensPurchased: bigint, tokensAllocated: bigint): bigint {
  if (tokensAllocated <= 0n) throw new Error('tokensAllocated must be positive — has DarkVeil closed yet?');
  return (bondAmount * tokensPurchased) / tokensAllocated;
}

// Resolution (2026-07-10): CLAUDE.md's confirmed thresholds, in lovelace
// (1 ADA = 1_000_000 lovelace). Same "documented default, adjustable at
// deploy" status as everything else of this shape in this codebase.
export const TREASURY_FLOOR_LOVELACE = 10_000n * 1_000_000n; // 10,000 ADA
export const TREASURY_WARNING_LOVELACE = 25_000n * 1_000_000n; // 25,000 ADA

/**
 * Defaults for the treasury's withdrawal pacing — see `treasury.compact`'s
 * own note on why these are deploy-time policy rather than constants there.
 *
 * A day, and a fifth of the warning threshold per currency. Sized to clear
 * a routine conversion batch comfortably while still meaning that emptying
 * the treasury takes days rather than one transaction. An operator running
 * a different cycle should pass their own.
 */
export const TREASURY_WITHDRAWAL_WINDOW_SECONDS = 86_400n;
export const TREASURY_ADA_WITHDRAWAL_LIMIT = TREASURY_WARNING_LOVELACE / 5n;
export const TREASURY_NIGHT_WITHDRAWAL_LIMIT = 5_000n * 1_000_000n;

export type TreasuryHealth = {
  adaEquivalentLovelace: bigint;
  belowFloor: boolean;
  belowWarning: boolean;
};

/**
 * Reads the shared treasury's mark-to-market ADA-equivalent balance and
 * checks it against the floor/warning thresholds. `nightPriceLovelacePerAtomicUnit`
 * must be computed off-chain from CLAUDE.md's Oracle Strategy
 * (median(Orcfax NIGHT/USD, Minswap TWAP x Orcfax ADA/USD), converted from
 * USD to a lovelace-per-atomic-NIGHT-unit rate) — treasury.compact's
 * `isBelowFloor`/`isBelowWarning` deliberately take an already-converted
 * rate rather than doing any on-chain price lookup, since no oracle
 * integration exists on the Midnight side of this codebase.
 *
 * This is advisory, not an on-chain gate — treasury.compact has no
 * "launch creation" circuit to attach a block to (deploying a new launch's
 * PSMs happens off-chain via the ops/SDK flow), and Compact still has no
 * working cross-contract call mechanism that would let a new
 * launch's own constructor call into this shared treasury even if the
 * concept existed. Callers (the launch-creation flow, wherever it lives —
 * currently the WordPress backend, outside this repo's tracked TS layer)
 * are expected to call this BEFORE building a deploy transaction for a new
 * both launch types launch and refuse to proceed if `belowFloor` is true.
 */
export async function checkTreasuryHealth(
  treasuryHandle: PsmHandle,
  nightPriceLovelacePerAtomicUnit: bigint,
): Promise<TreasuryHealth> {
  // CallResult's return value lives at `.private.result` — `.private` is
  // explicitly documented as privacy-sensitive (ZK-confidential transcript
  // data alongside it) and must not be passed across a trust boundary
  // whole; extract just the primitive values we need, same discipline the
  // SDK's own docs recommend.
  const [equivResult, floorResult, warningResult] = await Promise.all([
    treasuryHandle.callTx.getAdaEquivalentBalance(nightPriceLovelacePerAtomicUnit),
    treasuryHandle.callTx.isBelowFloor(nightPriceLovelacePerAtomicUnit),
    treasuryHandle.callTx.isBelowWarning(nightPriceLovelacePerAtomicUnit),
  ]);
  return {
    adaEquivalentLovelace: equivResult.private.result as bigint,
    belowFloor: floorResult.private.result as boolean,
    belowWarning: warningResult.private.result as boolean,
  };
}

function required(handle: PsmHandle | null, name: string): PsmHandle {
  if (!handle) throw new Error(`${name} not connected`);
  return handle;
}

/**
 * High-level API for the Noctis launch lifecycle. Wraps a connected
 * NoctisMidnightClient with launch-specific, multi-step operations.
 */
export class NoctisLaunchManager {
  constructor(private client: NoctisMidnightClient) {}

  // --- DarkVeil ---

  /**
   * Cardano Launch: registerForDarkVeil lives on the standalone eligibility_gate
   * deployment. Midnight Launch: it lives on the merged eligibility_gate +
   * bonding_curve contract (2026-07-10 — see bonding_curve.compact's
   * file header) — there is no separate eligibilityGate deployment for
   * Midnight Launch at all, so this falls back to bondingCurve when eligibilityGate
   * isn't connected.
   */
  async registerForDarkVeil() {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.registerForDarkVeil();
  }

  /**
   * Moves the launch's overall phase. Governor-only, and one-way: the circuit
   * refuses Pending as a target and holds every other transition to its one
   * valid predecessor, so a launch cannot be walked backwards.
   *
   * SEPARATE FROM `startRegistration`, and both are required before anyone can
   * register. `phase` is the launch's lifecycle; `dvState` is DarkVeil's own
   * sub-phase within it, and `registerForDarkVeil` asserts BOTH — Pending plus
   * a started registration window is not enough on its own.
   */
  async advancePhase(newPhase: LaunchPhase) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.advancePhase(newPhase);
  }

  /**
   * Opens registration. Governor-only, and callable once — the sub-phase moves
   * out of Inactive and the circuit refuses to move it again, so a second call
   * cannot reopen a window that has already run.
   *
   * Registration also needs the launch phase itself to be DarkVeil; see
   * `advancePhase` above.
   */
  async startRegistration() {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.startRegistration();
  }

  /**
   * Freezes registration and opens the buying window, publishing the
   * registrant root in the same call.
   *
   * The root is computed off-chain over the registrant set as it stands at
   * this exact moment, which is why publishing it and freezing the window are
   * one circuit rather than two: the set the root commits to is final because
   * nothing can join after the same call that published it.
   *
   * The circuit holds this to the minimum participant floor — below it, the
   * launch has to be cancelled instead, which refunds every bond in full.
   */
  async startBuying(registrantRoot: Uint8Array) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.startBuying(registrantRoot);
  }

  /**
   * Fix (2026-07-21): governor publishes the batch-computed allowlist
   * Merkle root — registerForDarkVeil's verifyAllowlist circuit checks
   * membership against whatever root is live here, so nothing can register
   * until this has been called at least once. Same eligibilityGate-or-
   * bondingCurve fallback as registerForDarkVeil above. Governor-only
   * on-chain (checked via getGovernorSecret() in the circuit itself) — the
   * providers this manager was connected with must carry the real governor
   * witness secret, see integration/cli/publish-allowlist-root.ts.
   *
   * One attestor's call. The root changes only once the threshold has been
   * met by DISTINCT attestors within the expiry window, so a caller expecting
   * this to publish on its own will not see the root move — that is the point.
   *
   * `currentTimestampSeconds` is bound to real chain time by the circuit and
   * dates the attestation round.
   */
  async updateAllowlistRoot(newRoot: Uint8Array, currentTimestampSeconds: bigint) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.updateAllowlistRoot(newRoot, currentTimestampSeconds);
  }

  /**
   * Phase 2 security-audit fix (2026-07-11): darkveil.compact retired —
   * Cardano Launch's submitBuyCommit now lives on eligibilityGate (the merged
   * contract), Midnight Launch's on bondingCurve, same fallback pattern as
   * registerForDarkVeil above.
   *
   * Fix (2026-07-21, High): submitBuyCommit no longer takes a
   * nullifier parameter at all, on either tier — the caller could
   * previously supply an arbitrary value, letting one registrant submit
   * unlimited buy commitments (over-allocation) and letting anyone
   * precompute another registrant's nullifier (privacy leak, since it was
   * derived from the caller's PUBLIC key). Both circuits now derive it
   * in-circuit from the caller's secret key instead — see
   * computeBuyNullifier in eligibility_gate.compact/bonding_curve.compact.
   */
  async submitDarkVeilBuyCommit(commitment: Uint8Array, timestamp: bigint) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.submitBuyCommit(commitment, timestamp);
  }

  /**
   * Reveals a DarkVeil buy — same eligibilityGate-or-bondingCurve fallback
   * as submitDarkVeilBuyCommit above, EXCEPT the two tiers' real circuit
   * signatures now genuinely diverge (fix, 2026-07-21): Midnight Launch's
   * bonding_curve.compact's revealBuyCommit now takes real
   * claimedCreatorFee/claimedTreasuryFee/claimedOpsFee parameters, verified
   * and accrued into the same payout accumulators buyTokens/withdrawFees
   * use — closing a Critical finding where DarkVeil proceeds had no real
   * payout path at all (accrued into totalRaisedCommitted, which nothing
   * ever paid out). Cardano Launch's eligibility_gate.compact revealBuyCommit
   * itself is still payment-free by design — real Cardano Launch settlement
   * happens on Cardano via ClaimDarkVeilTokens, not here.
   *
   * Both tiers take a real currentTimestamp, bound to real chain time
   * (blockTimeGte/blockTimeLte), enforcing a 30-day reveal window after
   * DarkVeil closes — an unrevealed Open commitment could otherwise sit
   * forever, and nothing downstream could conclude a registrant did not buy.
   *
   * Midnight Launch's fee arguments are creator and platform. The treasury/ops pair
   * they used to be became one platform slice, and this pass-through still
   * named the old three when it was reached.
   */
  async revealDarkVeilBuyCommit(
    commitment: Uint8Array,
    tokenAmount: bigint,
    pricePerToken: bigint,
    currentTimestamp: bigint,
    tierCFees?: {
      claimedCreatorFee: bigint;
      claimedPlatformFee: bigint;
    },
  ) {
    if (this.client.bondingCurve && !this.client.eligibilityGate) {
      if (!tierCFees) {
        throw new Error(
          "Midnight Launch revealBuyCommit requires tierCFees (claimedCreatorFee/claimedPlatformFee) — see this method's own comment.",
        );
      }
      return this.client.bondingCurve.callTx.revealBuyCommit(
        commitment,
        tokenAmount,
        pricePerToken,
        tierCFees.claimedCreatorFee,
        tierCFees.claimedPlatformFee,
        currentTimestamp,
      );
    }
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.revealBuyCommit(commitment, tokenAmount, pricePerToken, currentTimestamp);
  }

  /**
   * `baseSlot` is the per-registrant DarkVeil allocation —
   * CLAUDE.md's `base_slot = dv_supply / registered_count`, computed
   * off-chain from `dvAllocation / registrationCount` at this exact moment
   * (the final registrant count is only known once registration is over).
   * Required for claimRatioBondRefund below.
   *
   * Phase 2 security-audit fix (2026-07-11): both tiers' merged
   * `closeDarkVeil` now take `baseSlot` — Cardano Launch's eligibility_gate.compact
   * gained the ratio-refund mechanism (and its own baseSlot requirement)
   * in the same pass that retired the standalone darkveil.compact, so the
   * old per-tier arity branch is no longer needed.
   */
  async closeDarkVeil(closeTimestamp: bigint, baseSlot: bigint) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.closeDarkVeil(closeTimestamp, baseSlot);
  }

  /**
   * Cancels a DarkVeil phase outright. Governor-only, and it marks the phase
   * failed, which is what routes every locked bond back in full through
   * claimBondRefund rather than the ratio refund.
   *
   * The correct path when registration closed below the participant floor, or
   * when the launch is abandoned before the Cardano claim window ran: a
   * registrant is owed their whole bond in either case.
   */
  async cancelDarkVeil() {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.cancelDarkVeil();
  }

  /**
   * Marks a DarkVeil phase failed without cancelling it. Governor-only.
   *
   * The circuit refuses a phase that already closed normally, because a closed
   * phase settles against what each registrant actually bought — marking it
   * failed would open the full-refund path to bonds that are owed only a ratio.
   */
  async markDarkVeilFailed() {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.markDarkVeilFailed();
  }

  /**
   * Records that a buyer really settled `settledAmount` tokens for real ADA on
   * Cardano, observed from their own ClaimDarkVeilTokens transaction.
   *
   * Governor-only, and the single writer of the settlement record the ratio
   * refund reads: a registrant's refund is computed from what they actually
   * settled, so their entitlement follows the Cardano transaction rather than
   * anything they assert on Midnight. `settledAmount` must be taken from that
   * transaction's own `dv_amount`.
   *
   * Cardano Launch only. Midnight Launch settles inside its own merged curve, so there is no
   * separate Cardano leg for a governor to attest to.
   */
  async recordDarkVeilSettlement(buyerKey: Uint8Array, settledAmount: bigint) {
    const handle = this.client.eligibilityGate;
    if (!handle) {
      throw new Error(
        'recordDarkVeilSettlement is a Cardano Launch circuit on the eligibility gate; no eligibilityGate is connected.',
      );
    }
    return handle.callTx.recordDarkVeilSettlement(buyerKey, settledAmount);
  }

  /**
   * Closes the settlement record: the governor attesting that the Cardano
   * claim window has ended and every real settlement has been recorded.
   *
   * One-way, and it gates the sweep of fully-forfeited bonds — so it is the
   * point after which a registrant with no recorded settlement is treated as
   * one who never settled. A launch whose claim window never actually ran must
   * be cancelled or marked failed instead, which routes every bond back in
   * full.
   *
   * Cardano Launch only, for the same reason as recordDarkVeilSettlement above.
   */
  async finalizeDvSettlement() {
    const handle = this.client.eligibilityGate;
    if (!handle) {
      throw new Error(
        'finalizeDvSettlement is a Cardano Launch circuit on the eligibility gate; no eligibilityGate is connected.',
      );
    }
    return handle.callTx.finalizeDvSettlement();
  }

  /**
   * Claims a FULL NIGHT bond refund — launch cancelled outright, or
   * DarkVeil itself failed. For a DarkVeil that closed normally
   * (succeeded), use claimRatioBondRefund below instead.
   */
  async claimBondRefund(recipientAddr: Uint8Array) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.claimBondRefund(recipientAddr);
  }

  /**
   * Claims a RATIO-BASED partial NIGHT bond refund, for a DarkVeil that
   * closed normally (2026-07-10). `claimedRefund` must be computed
   * off-chain as `floor(bondAmount * tokensPurchased / baseSlot)` — the
   * circuit verifies this is the correct floor, it does not compute it
   * (Compact can't divide in-circuit). Use
   * `computeRatioBondRefund()` below to get this right.
   *
   * The FORFEITED remainder (`bondAmount - claimedRefund`) is paid to the
   * platform in the same call. One wallet, so the caller supplies no share
   * and the amount is fully determined by the refund already verified above.
   *
   * Phase 2 security-audit fix (2026-07-11): previously Midnight Launch only —
   * Cardano Launch's standalone eligibility_gate.compact had no ratio-refund
   * circuit at all (internal tracking's old entry: "Cardano Launch
   * unaffected"). Now available on both tiers, since Cardano Launch's
   * eligibility_gate.compact merged in darkveil.compact's
   * dvTokensPurchased/baseSlot state in the same pass — same
   * eligibilityGate-or-bondingCurve fallback as the rest of this class.
   */
  async claimRatioBondRefund(recipientAddr: Uint8Array, claimedRefund: bigint) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.claimRatioBondRefund(recipientAddr, claimedRefund);
  }

  /**
   * Collects a bond forfeited in full and pays it to the platform.
   *
   * Needs a real inclusion proof for `registrantKey` in the registrant tree
   * published at `startBuying`, supplied through the `getRegistrantMerkleProof`
   * witness — a bond is only ever collected against a key the published tree
   * actually contains. Permissionless: the destination is sealed at deploy and
   * the amount comes from the ledger, so calling it confers nothing.
   */
  async sweepForfeitedBond(registrantKey: Uint8Array) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.sweepForfeitedBond(registrantKey);
  }

  /**
   * States on chain that this caller holds a bond with no path in the
   * registrant tree, starting a 72-hour window.
   *
   * The three circuits below are what make a bond answer to the record the
   * registrant wrote themselves rather than to the root published afterwards —
   * see eligibility_gate.compact's REGISTRANT EXCLUSION DISPUTE section.
   */
  async disputeRegistrantExclusion(currentTimestamp: bigint) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.disputeRegistrantExclusion(currentTimestamp);
  }

  /**
   * Answers a dispute by producing the disputant's own path in the published
   * tree, via the `getRegistrantMerkleProof` witness.
   *
   * Permissionless by design: the tree is public, so any observer holding it
   * can answer, and this does not depend on the governor staying reachable.
   */
  async rebutRegistrantExclusion(registrantKey: Uint8Array) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.rebutRegistrantExclusion(registrantKey);
  }

  /**
   * Takes back a bond behind a dispute that stood unanswered for the full
   * window. Waits for the settlement record to be closed first — on Cardano Launch
   * that is `settlementFinalized`, on Midnight Launch the reveal window elapsing,
   * because the purchase is recorded on Midnight there rather than on
   * Cardano. Either way the point is the same: nothing should conclude a
   * registrant did not buy while a purchase can still be recorded.
   */
  async claimDisputedBond(recipientAddr: Uint8Array, currentTimestamp: bigint) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.claimDisputedBond(recipientAddr, currentTimestamp);
  }

  /**
   * Gives up on a DarkVeil phase that stopped moving, marking it failed so
   * every locked bond becomes claimable.
   *
   * Permissionless, and that is the whole point: every transition through
   * this phase is governor-only, and the curve's own timeout sits behind a
   * governor-only call, so a registrant had no way to act on their own bond
   * if the governor went quiet. The deadline is the authorization — this
   * refuses until real chain time has passed it, so calling it early is not
   * possible and calling it late confers nothing.
   */
  async expireDarkVeil() {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.expireDarkVeil();
  }

  /**
   * Reads the ZK Fair Launch Certificate after DarkVeil closes — what the
   * relayer in integration/zk-cert-relayer.ts fetches and anchors to Cardano
   * L1's zk_anchor.ak.
   *
   * On Cardano Launch the certificate is a published ledger field, so this reads it
   * off the indexer: free, permissionless, and no transaction. Anyone can
   * check the certificate against the chain themselves, which is what makes it
   * evidence rather than a claim.
   *
   * Midnight Launch's merged curve returns it from a circuit instead, so that tier goes
   * through `.callTx` and the JS-typed return value is unwrapped from
   * `.private.result` (the real field per midnight-js-contracts' CallResult —
   * compact-js's CompiledContract widening means the compiler will not catch a
   * wrong field name here).
   */
  async getFairLaunchCert(): Promise<FairLaunchCert> {
    if (this.client.isTierB()) {
      const { publicDataProvider, contractAddress } = this.client.darkVeilPublicRead();
      const ledger = await readEligibilityGateLedger(publicDataProvider, contractAddress);
      return ledger.fairLaunchCert;
    }
    const handle = this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    const result = await handle.callTx.getFairLaunchCert();
    return result.private.result as FairLaunchCert;
  }

  /**
   * Cancels an open (not yet revealed) DarkVeil buy commitment, before
   * DarkVeil closes. No wrapper existed for this real circuit before
   * now — confirmed identical between eligibility_gate.compact (Cardano Launch)
   * and bonding_curve.compact (Midnight Launch) by diff, same eligibilityGate-or-
   * bondingCurve fallback as the rest of this class.
   */
  async cancelDarkVeilBuyCommit(commitment: Uint8Array) {
    const handle = this.client.eligibilityGate ?? this.client.bondingCurve;
    if (!handle) throw new Error('eligibility_gate not connected (checked both eligibilityGate and bondingCurve)');
    return handle.callTx.cancelBuyCommit(commitment);
  }

  /**
   * Everything a launch page renders about a Cardano Launch DarkVeil phase — the
   * phase, the flat price, the allocation, what has been committed, the
   * certificate — in one read off the indexer.
   *
   * These are published ledger fields, so this costs nothing, needs no wallet
   * or proof server, and leaves no transaction behind. One round trip returns
   * the lot, and any figure it reports can be checked against the chain by
   * anyone who cares to.
   */
  async getDarkVeilSnapshot(): Promise<DarkVeilSnapshot> {
    if (!this.client.isTierB()) {
      throw new Error(
        'getDarkVeilSnapshot reads the Cardano Launch eligibility gate’s published ledger; no eligibilityGate is connected.',
      );
    }
    const { publicDataProvider, contractAddress } = this.client.darkVeilPublicRead();
    return readDarkVeilSnapshot(publicDataProvider, contractAddress);
  }

  // --- Bonding curve buy (Midnight Launch only) ---

  /**
   * Buys tokens on Midnight Launch's public bonding curve. The 5% cumulative wallet
   * cap is now enforced INSIDE buyTokens itself (2026-07-10 — the
   * merged eligibility_gate + bonding_curve contract checks and updates
   * cumulativePurchases atomically in the same circuit call, no separate
   * checkAndUpdateCap call needed or possible anymore). This single call
   * either succeeds with the cap enforced, or reverts entirely — no
   * partial-state risk the way the old two-call version had.
   *
   * Doc-sync note: this comment previously claimed DarkVeil-phase
   * purchases weren't counted toward this same cumulativePurchases map —
   * that gap was already closed by the follow-up fix (revealBuyCommit
   * updates the identical map, same identity, atomically) before this
   * comment was corrected; bonding_curve.test.ts's "a DarkVeil reveal and
   * a later public buyTokens share the same cumulativePurchases entry"
   * test proves it.
   *
   * Cardano Launch only, not Midnight Launch: this method doesn't apply. Cardano Launch's public
   * curve moved to contracts/cardano/bonding_curve_tier_b.ak, a
   * Cardano transaction, not a Midnight circuit call — build and submit
   * that through the Cardano tx-building path instead.
   */
  async buyTokens(tokenAmount: bigint, curve_: CurveParams, tokensSold: bigint, timestamp: bigint) {
    const curve = required(this.client.bondingCurve, 'bonding_curve');

    // Computed here rather than accepted from the caller. What the curve
    // charges is a function of its own sealed parameters and how much has
    // already sold, so there is no figure a caller could supply that this
    // could not derive — and the circuit recomputes it independently and
    // refuses anything else. `buyCost` is the same shared mirror the Cardano
    // curves are checked against, so all three tiers price from one
    // implementation.
    const grossPayment = buyCost('quadratic', curve_, tokensSold, tokenAmount);
    const { creatorFee, platformFee } = computeBondingCurveFees(grossPayment);

    return curve.callTx.buyTokens(tokenAmount, grossPayment, creatorFee, platformFee, timestamp);
  }

  // --- Graduation (sequential, not atomic — see file header) ---

  /**
   * Bonding curve graduation itself is automatic — bonding_curve.compact's
   * buyTokens circuit transitions CurveState to Graduated the moment
   * tokensSold == curveSupply; there is no separate "graduate" circuit.
   * This handles everything that needs to happen once graduation is
   * observed: seal the LP lock, close the creator fee escrow (fixing its
   * final balance and starting the silence-lock clock), and start the
   * creator's token vesting clock.
   */
  async graduateAndSeedLp(timestamp: bigint) {
    const lp = required(this.client.lpEscrow, 'lp_escrow');
    const escrow = required(this.client.creatorEscrow, 'creator_escrow');
    const vesting = required(this.client.vesting, 'vesting');

    const lpResult = await lp.callTx.sealLock(timestamp);
    const escrowResult = await escrow.callTx.closeEscrowAtGraduation(timestamp);
    const vestingResult = await vesting.callTx.startVesting(timestamp);

    return { lpResult, escrowResult, vestingResult };
  }

  // --- Vesting (creator's TOKEN allocation) ---

  async claimVested(claimAmount: bigint, currentTimestamp: bigint) {
    const vesting = required(this.client.vesting, 'vesting');
    return vesting.callTx.claimVested(claimAmount, currentTimestamp);
  }

  // --- Creator Fee Escrow (ADA/NIGHT trade-fee income) ---

  async claimFees(claimAmount: bigint, currentTimestamp: bigint) {
    const escrow = required(this.client.creatorEscrow, 'creator_escrow');
    return escrow.callTx.claimFees(claimAmount, currentTimestamp);
  }

  // --- CTO Governance ---

  /**
   * Governor publishes a fresh Merkle root of (voterKey, balance) leaves
   * (design requirement) — must be called at least once before any
   * `createProposal`, which now hard-asserts a real snapshot exists. Build
   * the tree with `packages/zk-proofs/src/cto-governance.ts`'s
   * `buildBalanceSnapshotTree`.
   *
   * Stale-snapshot fix (2026-07-19): `currentTimestamp` is now required —
   * `createProposal` rejects once the published snapshot is more than 30
   * days old, so this must be called again periodically (at least once
   * every 30 days) for a launch to keep any proposal type creatable, not
   * just once ever.
   */
  async updateBalanceSnapshot(newRoot: Uint8Array, currentTimestamp: bigint) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.updateBalanceSnapshot(newRoot, currentTimestamp);
  }

  /**
   * Governor refreshes creator activity + claimable-balance status from
   * off-chain monitoring (fix, 2026-07-12) — call whenever the platform
   * observes a claim or social post (`timestamp`), or whenever the real
   * fee balance on the launch's curve contract changes state (drained to
   * zero by a claim, or newly nonzero after more trading). Both facts come
   * from the same off-chain observation, so they update together.
   */
  async updateCreatorActivity(timestamp: bigint, hasClaimableBalance: boolean, currentTimestamp: bigint) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.updateCreatorActivity(timestamp, hasClaimableBalance, currentTimestamp);
  }

  /**
   * The creator refreshing their own silence clock.
   *
   * Callable ONLY by the creator — the circuit derives the caller's identity
   * and compares it to the launch's sealed `creatorKey`, so this client must
   * be constructed with the creator's own secret.
   *
   * The point is that the silence timer has an author who is not the people
   * attesting it: without this, the clock advanced toward "silent" whenever
   * the attestors went quiet, whatever the creator was doing.
   */
  async recordCreatorHeartbeat(currentTimestamp: bigint) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.recordCreatorHeartbeat(currentTimestamp);
  }

  // --- CTO Governance: bonded break-glass fallback (2026-07-19) ---
  //
  // Community override for a governor withholding hasClaimableBalance —
  // see cto_governance.compact's file-header BREAK-GLASS FALLBACK note.

  /** Opens a bonded challenge asserting hasClaimableBalance should be true. */
  async bondedSilenceChallenge(bondAmount: bigint, currentTimestamp: bigint) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.bondedSilenceChallenge(bondAmount, currentTimestamp);
  }

  /**
   * Resolves a pending break-glass challenge — permissionless, callable by
   * anyone. Fix (2026-07-21, High): no longer takes a
   * treasuryShareAmount — the Rebutted path used to forfeit the
   * challenger's bond to platformAddr (platform-controlled,
   * the same party as the governor being checked), a direct conflict of
   * interest that made every break-glass challenge against a dishonest
   * governor a guaranteed profit for that governor's own platform. Rebutted
   * now just marks state — the bond stays fully refundable to the
   * challenger via claimBreakGlassBondRefund below (extended to accept
   * Rebutted as well as Confirmed).
   */
  async resolveBreakGlassChallenge(currentTimestamp: bigint) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.resolveBreakGlassChallenge(currentTimestamp);
  }

  /** Claims a refund for a CONFIRMED or REBUTTED break-glass challenge — identity-gated to the original challenger. */
  async claimBreakGlassBondRefund(recipientAddr: Uint8Array) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.claimBreakGlassBondRefund(recipientAddr);
  }

  /**
   * `proposedCommunityWallet` is pinned into the Proposal at creation, so
   * `executeProposal` cannot accept a different wallet at execution time. Only
   * meaningful for a `SilenceLockTrigger` proposal — pass a zero-filled
   * 32-byte array for other types.
   *
   * `bondAmount` is a real NIGHT bond taken by the circuit, at or above the
   * contract's own floor. A launch has one proposal slot and filing holds it
   * for the whole ballot, so the bond is what that costs: returned in full via
   * `claimProposalBond` once a ballot draws a quorum, swept to the platform by
   * `sweepForfeitedProposalBond` when one draws nobody.
   */
  async createCtoProposal(
    proposalType: number,
    descriptionHash: Uint8Array,
    currentTimestamp: bigint,
    targetDexAddr: Uint8Array,
    allocationAmount: bigint,
    allocationRecipient: Uint8Array,
    proposedCommunityWallet: Uint8Array,
    bondAmount: bigint,
  ) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.createProposal(
      proposalType,
      descriptionHash,
      currentTimestamp,
      targetDexAddr,
      allocationAmount,
      allocationRecipient,
      proposedCommunityWallet,
      bondAmount,
    );
  }

  /** Returns the bond behind a ballot that drew a quorum. Proposer only. */
  async claimProposalBond(proposalId: Uint8Array, recipientAddr: Uint8Array) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.claimProposalBond(proposalId, recipientAddr);
  }

  /**
   * Sweeps the bond behind a ballot that drew nobody, to the sealed platform
   * address. Permissionless — the destination and amount are both fixed by the
   * ledger, so calling it confers nothing.
   */
  async sweepForfeitedProposalBond(proposalId: Uint8Array) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.sweepForfeitedProposalBond(proposalId);
  }

  /**
   * Design requirement: `voteWeight`/`isCreator` dropped —
   * both are now derived on-chain from the balance-snapshot witnesses baked
   * into this client's `ctoGovernance` handle (see
   * `connectCtoGovernance`'s doc comment — reconnect with your current
   * balance/proof immediately before calling this).
   */
  async castVote(proposalId: Uint8Array, support: boolean, currentTimestamp: bigint) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    return cto.callTx.castVote(proposalId, support, currentTimestamp);
  }

  /**
   * Executes a passed CTO proposal, then triggers CTO redirect in creator
   * escrow, vesting, and LP escrow. Sequential, not atomic — if any
   * trigger call fails after executeProposal succeeds, the proposal is
   * marked executed but one or more PSMs haven't redirected yet; callers
   * must retry the failed trigger call(s) directly.
   *
   * Design requirement: `executeProposal` no longer takes
   * `communityWalletAddr` — it now reads the wallet pinned on the proposal
   * at creation time. `communityWalletAddr` is still required here because
   * `creator_escrow`/`vesting`/`lp_escrow`/`bonding_curve`'s own
   * `triggerCTO` circuits are separate, unmerged PSMs that still take
   * it directly — callers must pass the SAME address that was set as
   * `proposedCommunityWallet` on this proposal at creation, or the redirect
   * destinations across PSMs will silently diverge from what governance
   * actually voted on.
   *
   * CTO fee-redirect fix (2026-07-12): `bondingCurve.triggerCTO` added —
   * this is Midnight Launch only (Cardano Launch has no Midnight-side bonding curve to
   * trigger; its Cardano curve's TriggerCTO redeemer is a separate,
   * off-chain-orchestrated call against `bonding_curve_tier_b.ak`, not
   * wired here). Before this fix, `bonding_curve.compact` held the REAL
   * claimable creator fee but had no CTO concept at all, so
   * triggering CTO on the other three PSMs never actually redirected the
   * bonding-curve trade fee a passed vote was supposed to redirect.
   */
  async executeCtoProposal(proposalId: Uint8Array, communityWalletAddr: Uint8Array) {
    const cto = required(this.client.ctoGovernance, 'cto_governance');
    const escrow = required(this.client.creatorEscrow, 'creator_escrow');
    const vesting = required(this.client.vesting, 'vesting');
    const lp = required(this.client.lpEscrow, 'lp_escrow');

    // Every trigger carries the SAME `proposalId` this call is executing, so
    // each PSM records the ballot its redirect rests on and consumes it. The
    // id is already in hand here — it is what makes each contract's own
    // `ctoProposalId` checkable against cto_governance's `proposals` ledger
    // rather than being an unattributed governor action.
    const executeResult = await cto.callTx.executeProposal(proposalId);
    const escrowResult = await escrow.callTx.triggerCTO(proposalId, communityWalletAddr);
    const vestingResult = await vesting.callTx.triggerCTO(proposalId, communityWalletAddr);
    const lpResult = await lp.callTx.triggerCTO(proposalId, communityWalletAddr);
    // Midnight Launch only — Cardano Launch's bonding curve lives on Cardano, not here.
    const curveResult = this.client.bondingCurve
      ? await this.client.bondingCurve.callTx.triggerCTO(proposalId, communityWalletAddr)
      : undefined;

    return {
      executeResult,
      escrowResult,
      vestingResult,
      lpResult,
      curveResult,
    };
  }

  // --- Cancellation ---

  /**
   * Cancels the launch across bonding curve, creator escrow, vesting, and
   * LP escrow. Sequential, not atomic — a failure partway through
   * leaves the launch in a mixed cancelled/active state across PSMs;
   * callers must retry the remaining cancelLaunch() calls directly.
   */
  async cancelLaunch() {
    const curve = required(this.client.bondingCurve, 'bonding_curve');
    const escrow = required(this.client.creatorEscrow, 'creator_escrow');
    const vesting = required(this.client.vesting, 'vesting');
    const lp = required(this.client.lpEscrow, 'lp_escrow');

    const curveResult = await curve.callTx.cancelCurve();
    const escrowResult = await escrow.callTx.cancelLaunch();
    const vestingResult = await vesting.callTx.cancelLaunch();
    const lpResult = await lp.callTx.cancelLaunch();

    return { curveResult, escrowResult, vestingResult, lpResult };
  }

  // --- Bonding curve refund (Midnight Launch only — 2026-07-09) ---

  /**
   * Claims back the NIGHT a buyer paid into Midnight Launch's bonding curve, once
   * it's been cancelled (failure path). `recipientAddr` is the real
   * Midnight address the refund should be sent to — separate from the
   * derived identity key the circuit uses internally to look up how much
   * this caller paid.
   *
   * Cardano Launch only, not Midnight Launch: has no equivalent here — its ADA never left
   * Cardano, so a refund there is a plain Cardano-side claim against
   * bonding_curve_tier_b.ak, not a Midnight circuit call.
   */
  async claimCurveRefund(recipientAddr: Uint8Array) {
    const curve = required(this.client.bondingCurve, 'bonding_curve');
    return curve.callTx.claimCurveRefund(recipientAddr);
  }

  /**
   * Permissionless force-cancel for a curve that's been Active for more
   * than 90 days without reaching Graduated (the part `cancelCurve`
   * above didn't actually cover: that's governor-only with no deadline,
   * so a curve could stall forever if the governor never acts). Anyone
   * can call this once the deadline has passed; the circuit's own
   * timestamp check is the only authorization. Once Cancelled,
   * claimCurveRefund becomes reachable the same way it is after a
   * voluntary cancelCurve.
   */
  async expireCurve(timestamp: bigint) {
    const curve = required(this.client.bondingCurve, 'bonding_curve');
    return curve.callTx.expireCurve(timestamp);
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createNoctisClient(
  userSecretKey: UserSecretKey,
  governorSecretKey?: UserSecretKey,
): NoctisMidnightClient {
  return new NoctisMidnightClient(userSecretKey, governorSecretKey);
}

export function createLaunchManager(client: NoctisMidnightClient): NoctisLaunchManager {
  return new NoctisLaunchManager(client);
}
