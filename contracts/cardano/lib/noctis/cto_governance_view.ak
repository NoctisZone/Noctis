//// The fields of a launch's governance record that another validator
//// consults, read by position.
////
//// A reader proves the governance UTXO genuine by its thread NFT, in the same
//// conjunction as everything it reads here. That UTXO only ever carries a
//// datum `cto_governance.ak` wrote through its own typed continuing-datum
//// check, or one the genesis mint wrote, so once the NFT is proven a full
//// structural check of the record re-proves what is already true. That check
//// is the largest thing a reader decodes: these read only the fields asked
//// for. A forged UTXO fails the NFT check whatever these return for it.
////
//// Every position here is pinned against a real `CtoGovernanceDatum` and
//// `ProposalAnchor` by the tests at the end of `cto_governance.ak`, which owns
//// both types, so reordering either one fails there first.

use aiken/builtin

// ---------------------------------------------------------------------------
// Constructor positions of the governance enums
// ---------------------------------------------------------------------------

/// `CtoAnchorState.CTOTriggered`.
pub const cto_triggered: Int = 1

/// `ProposalType.SilenceLockTrigger`.
pub const silence_lock_trigger: Int = 0

/// `ProposalType.DissolveCTOProposal`.
pub const dissolve_cto_proposal: Int = 4

/// `ProposalOutcome.Passed`.
pub const passed: Int = 0

/// `ExecutionStatus.Executed`.
pub const executed: Int = 1

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

fn nth(xs: List<Data>, n: Int) -> Data {
  if n == 0 {
    builtin.head_list(xs)
  } else {
    nth(builtin.tail_list(xs), n - 1)
  }
}

fn field(record: Data, n: Int) -> Data {
  nth(builtin.un_constr_data(record).2nd, n)
}

fn tag(value: Data) -> Int {
  builtin.un_constr_data(value).1st
}

/// `CtoGovernanceDatum.launch_id`.
pub fn launch_id(record: Data) -> ByteArray {
  builtin.un_b_data(field(record, 0))
}

/// The constructor position of `CtoGovernanceDatum.cto_state`.
pub fn cto_state(record: Data) -> Int {
  tag(field(record, 1))
}

/// `CtoGovernanceDatum.community_wallet_hash`.
pub fn community_wallet_hash(record: Data) -> ByteArray {
  builtin.un_b_data(field(record, 2))
}

/// `CtoGovernanceDatum.last_executed_proposal`, which must be present.
pub fn last_executed(record: Data) -> Data {
  let option = builtin.un_constr_data(field(record, 10))
  if option.1st == 0 {
    builtin.head_list(option.2nd)
  } else {
    fail @"no proposal has been executed"
  }
}

/// The constructor position of `ProposalAnchor.proposal_type`.
pub fn proposal_type(anchor: Data) -> Int {
  tag(field(anchor, 0))
}

/// The constructor position of `ProposalAnchor.outcome`.
pub fn outcome(anchor: Data) -> Int {
  tag(field(anchor, 8))
}

/// The constructor position of `ProposalAnchor.execution_status`.
pub fn execution_status(anchor: Data) -> Int {
  tag(field(anchor, 12))
}

/// `ProposalAnchor.allocation_recipient_hash`.
pub fn allocation_recipient_hash(anchor: Data) -> ByteArray {
  builtin.un_b_data(field(anchor, 15))
}
