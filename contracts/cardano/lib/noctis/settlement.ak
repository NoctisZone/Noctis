// ============================================================================
// Noctis Zone — settlement tagging
// ============================================================================
// A payout check written as "some output pays R at least N" is a question
// about the whole transaction, not about the spend being validated. Two
// obligations that happen to owe the same wallet the same amount therefore
// read the same answer from the same output — one payment settles both, and
// the difference is free.
//
// Scoping by address or by amount cannot help, because address and amount are
// exactly what the two obligations have in common. Restricting how many of a
// contract's OWN UTXOs a transaction may spend cannot help either, because the
// two obligations may belong to different contracts, and no contract can see
// another's inputs.
//
// What distinguishes them is which input each settles. So a settlement output
// NAMES its input, carrying that input's `OutputReference` as its datum. An
// `OutputReference` is unique across the chain by construction: no two spends
// can ask for the same tag, and one output cannot answer two.
//
// The cost is one inline datum per settlement output, and that a transaction
// settling two obligations must build two outputs. Both are ordinary.

use aiken/collection/list
use cardano/address.{Credential, from_verification_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

/// True when `output` is tagged as settling `own_ref`.
///
/// Callers keep their own value and recipient checks — this adds the one
/// thing those cannot express, which is *whose* obligation the output
/// discharges.
pub fn settles(output: Output, own_ref: OutputReference) -> Bool {
  output.datum == InlineDatum(own_ref)
}

/// What `credential` NETS from this transaction in one asset: everything it
/// receives, minus everything it already brought.
///
/// Tagging says which obligation an output answers. It does not say the
/// recipient is better off, and those are different questions. An output at
/// the recipient's own credential can be their CHANGE — assets they put into
/// the transaction themselves, handed straight back — and change is
/// indistinguishable from payment by address and amount alone. So a builder
/// who can get the recipient's signature spends a UTXO they already hold,
/// returns it as change, tags it, and sends the contract's real payment
/// somewhere else. Every balance is honest and the recipient gains nothing.
///
/// Netting is what closes that: their own assets appear on both sides and
/// cancel, so only assets that actually arrived from elsewhere count. Pair it
/// with a tagged-output check rather than replacing one — netting alone would
/// let one payment satisfy two obligations, which is what tagging exists to
/// prevent.
pub fn net_asset_gain(
  self: Transaction,
  credential: Credential,
  policy: PolicyId,
  name: AssetName,
) -> Int {
  let received = list.foldl(
    self.outputs,
    0,
    fn(output, acc) {
      if output.address.payment_credential == credential {
        acc + assets.quantity_of(output.value, policy, name)
      } else {
        acc
      }
    },
  )
  let brought = list.foldl(
    self.inputs,
    0,
    fn(input, acc) {
      if input.output.address.payment_credential == credential {
        acc + assets.quantity_of(input.output.value, policy, name)
      } else {
        acc
      }
    },
  )
  received - brought
}

/// The same question for lovelace, which `assets.quantity_of` cannot ask.
pub fn net_lovelace_gain(self: Transaction, credential: Credential) -> Int {
  let received = list.foldl(
    self.outputs,
    0,
    fn(output, acc) {
      if output.address.payment_credential == credential {
        acc + assets.lovelace_of(output.value)
      } else {
        acc
      }
    },
  )
  let brought = list.foldl(
    self.inputs,
    0,
    fn(input, acc) {
      if input.output.address.payment_credential == credential {
        acc + assets.lovelace_of(input.output.value)
      } else {
        acc
      }
    },
  )
  received - brought
}

// ============================================================================
// TESTS
// ============================================================================

fn tagged(own_ref: OutputReference) -> Output {
  Output {
    address: from_verification_key(#"00"),
    value: assets.from_lovelace(1),
    datum: InlineDatum(own_ref),
    reference_script: None,
  }
}

test settles_accepts_its_own_reference() {
  let own_ref = OutputReference { transaction_id: #"aa", output_index: 0 }
  settles(tagged(own_ref), own_ref)
}

test settles_rejects_a_different_output_index() {
  let a = OutputReference { transaction_id: #"aa", output_index: 0 }
  let b = OutputReference { transaction_id: #"aa", output_index: 1 }
  !settles(tagged(a), b)
}

test settles_rejects_a_different_transaction() {
  let a = OutputReference { transaction_id: #"aa", output_index: 0 }
  let b = OutputReference { transaction_id: #"bb", output_index: 0 }
  !settles(tagged(a), b)
}

test settles_rejects_an_untagged_output() {
  let own_ref = OutputReference { transaction_id: #"aa", output_index: 0 }
  let untagged = Output {
    address: from_verification_key(#"00"),
    value: assets.from_lovelace(1),
    datum: NoDatum,
    reference_script: None,
  }
  !settles(untagged, own_ref)
}

fn at(cred_byte: ByteArray, lovelace: Int, tokens: Int) -> Output {
  Output {
    address: from_verification_key(cred_byte),
    value: assets.merge(
      assets.from_lovelace(lovelace),
      assets.from_asset(#"33", "tok", tokens),
    ),
    datum: NoDatum,
    reference_script: None,
  }
}

fn spending(cred_byte: ByteArray, lovelace: Int, tokens: Int) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"77", output_index: 0 },
    output: at(cred_byte, lovelace, tokens),
  }
}

fn cred(cred_byte: ByteArray) -> Credential {
  from_verification_key(cred_byte).payment_credential
}

test net_asset_gain_counts_a_plain_payment() {
  let self = Transaction {
    ..placeholder,
    inputs: [],
    outputs: [at(#"dd", 2, 100)],
  }
  net_asset_gain(self, cred(#"dd"), #"33", "tok") == 100
}

test net_asset_gain_cancels_the_recipients_own_change() {
  // The shape this exists for: they put 100 in and took 100 back out, so
  // nothing arrived from anywhere else.
  let self = Transaction {
    ..placeholder,
    inputs: [spending(#"dd", 2, 100)],
    outputs: [at(#"dd", 2, 100)],
  }
  net_asset_gain(self, cred(#"dd"), #"33", "tok") == 0
}

test net_asset_gain_sees_through_change_to_the_real_payment() {
  // Their own 100 back, plus 40 that came from somewhere else.
  let self = Transaction {
    ..placeholder,
    inputs: [spending(#"dd", 2, 100)],
    outputs: [at(#"dd", 2, 100), at(#"dd", 2, 40)],
  }
  net_asset_gain(self, cred(#"dd"), #"33", "tok") == 40
}

test net_asset_gain_ignores_everyone_else() {
  let self = Transaction {
    ..placeholder,
    inputs: [spending(#"ee", 2, 500)],
    outputs: [at(#"ee", 2, 500), at(#"dd", 2, 25)],
  }
  net_asset_gain(self, cred(#"dd"), #"33", "tok") == 25
}

test net_asset_gain_goes_negative_when_they_are_the_ones_paying() {
  let self = Transaction {
    ..placeholder,
    inputs: [spending(#"dd", 2, 100)],
    outputs: [],
  }
  net_asset_gain(self, cred(#"dd"), #"33", "tok") == -100
}

test net_lovelace_gain_cancels_the_recipients_own_change() {
  let self = Transaction {
    ..placeholder,
    inputs: [spending(#"dd", 5_000_000, 0)],
    outputs: [at(#"dd", 5_000_000, 0)],
  }
  net_lovelace_gain(self, cred(#"dd")) == 0
}

test net_lovelace_gain_counts_only_what_arrived() {
  let self = Transaction {
    ..placeholder,
    inputs: [spending(#"dd", 5_000_000, 0)],
    outputs: [at(#"dd", 7_000_000, 0)],
  }
  net_lovelace_gain(self, cred(#"dd")) == 2_000_000
}
