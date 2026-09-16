//// LP escrow datum types.
////
//// These live here, rather than in the validator that owns them, because
//// `cto_governance.ak` has to read a sealed LP escrow UTXO as a reference
//// input to learn when a launch graduated — and `lp_escrow.ak` already
//// imports `cto_governance`, so importing back the other way would be a
//// cycle. A shared module is the way two validators agree on a datum shape
//// without either depending on the other.
////
//// Nothing here is validator logic. The rules that maintain these fields
//// stay in `lp_escrow.ak`; this is only the shape they are written in.

use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Credential}
use cardano/assets.{AssetName, PolicyId}

/// LP escrow states — mirrors the Midnight PSM enum
/// A sealed position is `Locked` and stays `Locked`. Migrating moves it to a
/// different DEX; it never unlocks, so there is no separate post-migration
/// state — a `Migrated` variant would need every rule `Locked` has, and two
/// states obliged to behave identically are a place for one of them to be
/// forgotten. `last_migration_timestamp` records that a migration happened.
pub type LpState {
  Locked
  Cancelled
}

/// Which way a proposed whitelist change goes
pub type DexAction {
  ProposeAdd
  ProposeRemove
}

/// A whitelist change awaiting its 72h public notice period — at
/// most one pending change at a time, deliberately: a second proposal
/// can't be queued until the first resolves (executes or is cancelled),
/// so there's never ambiguity about which change a given execute call
/// applies to.
pub type PendingDexChange {
  dex_credential: Credential,
  action: DexAction,
  proposed_at: Int,
}

/// The datum stored at the LP escrow UTxO
pub type LpEscrowDatum {
  // Identity
  launch_id: ByteArray,
  // Lock timing
  // Chain time in MILLISECONDS when the lock was sealed, matching
  // Cardano's own validity range. 0 until SealLock runs.
  lock_timestamp: Int,
  // Also MILLISECONDS; enforced >= min_lock_duration (365 days).
  lock_duration: Int,
  // State
  lp_state: LpState,
  // Authorization
  governor_pub_key_hash: VerificationKeyHash,
  community_wallet_hash: VerificationKeyHash,
  cto_triggered: Bool,
  // Who receives harvested DEX trading fees (CLAUDE.md's Stream B
  // "fee_recipient") — the creator's own wallet, set once at deploy.
  // Redirected to community_wallet_hash once cto_triggered, same rule
  // CLAUDE.md states ("Redirected to CTO wallet if governance vote
  // passes") and the same pattern Migrate's is_authorized already uses.
  fee_recipient_pub_key_hash: VerificationKeyHash,
  // DEX whitelist (payment credentials of approved DEX contracts)
  dex_whitelist: List<Credential>,
  // The team multisig that can propose/cancel whitelist changes. Set
  // once at deploy — M-of-N is a deployment-time choice (multisig_threshold
  // out of however many keys are in multisig_signers), not hardcoded here.
  multisig_signers: List<VerificationKeyHash>,
  multisig_threshold: Int,
  // At most one whitelist change awaiting its notice period.
  pending_dex_change: Option<PendingDexChange>,
  // Token info (what LP tokens are locked)
  lp_token_policy_id: PolicyId,
  lp_token_name: AssetName,
  lp_token_amount: Int,
  // Fix: cto_governance.ak's own fixed script address, set
  // at genesis — same pattern as bonding_curve.ak's own
  // cto_governance_credential field; see that file's doc comment for the
  // full reasoning. Needed because TriggerCTO/DissolveCTO below now
  // require real reference-input evidence a vote actually passed, instead
  // of trusting a bare governor signature.
  cto_governance_credential: Credential,
  // Fix (2026-07-23 audit): governance THREAD NFT policy id — see the
  // full doc comment on bonding_curve.ak. cto_vote_verified now requires
  // the referenced governance UTXO to carry this NFT (asset_name =
  // launch_id), closing the forge-a-fake-governance-UTXO gap.
  thread_nft_policy: PolicyId,
  // Chain time in MILLISECONDS of the most recent migration, 0 if the
  // position has never moved. `Migrate` requires a full cooldown to have
  // elapsed since, which is what stops a position being shuttled between
  // whitelisted DEXes at will.
  last_migration_timestamp: Int,
}
