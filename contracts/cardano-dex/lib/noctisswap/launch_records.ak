//// The launch records this package reads, mirrored from the launch package
//// (`contracts/cardano`). (c) Noctis Zone, Apache-2.0.
////
//// NoctisSwap only ever reads these as reference inputs; it never spends them.
//// The types are field-for-field copies of the originals, because constructor
//// order and field order decide how the on-chain data decodes:
////
////   CtoGovernanceDatum and its parts  <- validators/cto_governance.ak
////   LpEscrowDatum and its parts       <- lib/noctis/lp_escrow_datum.ak
////   thread NFT naming                 <- lib/noctis/thread_nft.ak
////
//// A change to any of those in the launch package must be mirrored here, and
//// the pinned naming test below is the tripwire for the one that is easiest to
//// miss.

use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Credential}
use cardano/assets.{AssetName, PolicyId}

// ---------------------------------------------------------------------------
// CTO governance record
// ---------------------------------------------------------------------------

pub type CtoAnchorState {
  PreCTO
  CTOTriggered
  CTODissolved
}

pub type ProposalType {
  SilenceLockTrigger
  FundAllocation
  DexMigration
  WhitelistUpdate
  DissolveCTOProposal
}

pub type ProposalOutcome {
  Passed
  Failed
}

pub type ExecutionStatus {
  PendingExecution
  Executed
  Expired
}

pub type ProposalAnchor {
  proposal_type: ProposalType,
  description_hash: ByteArray,
  proof_bundle_hash: ByteArray,
  yes_votes: Int,
  no_votes: Int,
  voter_count: Int,
  creator_yes_votes: Int,
  creator_no_votes: Int,
  outcome: ProposalOutcome,
  start_timestamp: Int,
  end_timestamp: Int,
  anchor_timestamp: Int,
  execution_status: ExecutionStatus,
  target_dex_credential: Option<Credential>,
  allocation_amount: Int,
  allocation_recipient_hash: VerificationKeyHash,
  relayer_credential_hash: VerificationKeyHash,
}

pub type CtoGovernanceDatum {
  launch_id: ByteArray,
  cto_state: CtoAnchorState,
  community_wallet_hash: VerificationKeyHash,
  governor_credential_hash: VerificationKeyHash,
  total_supply: Int,
  quorum_bps: Int,
  creator_vote_cap_bps: Int,
  min_voter_count: Int,
  active_proposal: Option<ProposalAnchor>,
  proposal_count: Int,
  last_executed_proposal: Option<ProposalAnchor>,
  pending_relayer_bond: Int,
  pending_relayer_key_hash: VerificationKeyHash,
  payout_pub_key_hash: VerificationKeyHash,
  thread_nft_policy: PolicyId,
  ballot_duration: Int,
  last_ballot_end_timestamp: Int,
}

// ---------------------------------------------------------------------------
// LP escrow record
// ---------------------------------------------------------------------------

pub type LpState {
  Locked
  Cancelled
}

pub type DexAction {
  ProposeAdd
  ProposeRemove
}

pub type PendingDexChange {
  dex_credential: Credential,
  action: DexAction,
  proposed_at: Int,
}

pub type LpEscrowDatum {
  launch_id: ByteArray,
  lock_timestamp: Int,
  lock_duration: Int,
  lp_state: LpState,
  governor_pub_key_hash: VerificationKeyHash,
  community_wallet_hash: VerificationKeyHash,
  cto_triggered: Bool,
  fee_recipient_pub_key_hash: VerificationKeyHash,
  dex_whitelist: List<Credential>,
  multisig_signers: List<VerificationKeyHash>,
  multisig_threshold: Int,
  pending_dex_change: Option<PendingDexChange>,
  lp_token_policy_id: PolicyId,
  lp_token_name: AssetName,
  lp_token_amount: Int,
  cto_governance_credential: Credential,
  thread_nft_policy: PolicyId,
  last_migration_timestamp: Int,
}

// ---------------------------------------------------------------------------
// Thread NFT naming
// ---------------------------------------------------------------------------

/// Every state record of a launch carries one NFT under the platform's thread
/// NFT policy, named by a one-byte role tag and the first 31 bytes of the
/// launch id. The launch package owns tags 00 to 06.
pub const role_cto_governance: ByteArray = #"00"

pub const role_lp_escrow: ByteArray = #"03"

/// NoctisSwap's own roles, chosen outside the launch package's range. The pool
/// NFT and the pool's LQ token are both minted by the factory policy, named
/// with these tags and the launch id, so a pool is bound to its launch by the
/// same naming as the launch's other records.
pub const role_pool: ByteArray = #"10"

pub const role_lq: ByteArray = #"11"

pub fn thread_asset_name(role: ByteArray, launch_id: ByteArray) -> ByteArray {
  bytearray.concat(role, bytearray.take(launch_id, 31))
}

const launch_id_32: ByteArray =
  #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

/// Pinned to the launch package's own scheme: the role tag, then bytes 1..31
/// of the id, dropping the last byte.
test thread_asset_name_matches_the_launch_package() {
  thread_asset_name(role_cto_governance, launch_id_32) == #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
}

test thread_asset_name_is_32_bytes() {
  bytearray.length(thread_asset_name(role_pool, launch_id_32)) == 32
}

test roles_do_not_collide() {
  and {
    thread_asset_name(role_pool, launch_id_32) != thread_asset_name(
      role_cto_governance,
      launch_id_32,
    ),
    thread_asset_name(role_pool, launch_id_32) != thread_asset_name(
      role_lp_escrow,
      launch_id_32,
    ),
  }
}
