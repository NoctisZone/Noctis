//// Launch-token minting policy — one-shot, per launch.
////
//// WHAT THIS GUARANTEES
//// A launch's token supply is fixed by the chain, not by the platform's
//// custody of a key: the policy can mint exactly once, for exactly the
//// declared total, and is then permanently spent. Anyone can verify both
//// properties from the policy id alone, without trusting the platform.
////
//// HOW THE ONE-SHOT WORKS
//// The policy is parameterized on a specific UTXO, which the minting
//// transaction must consume. Cardano's ledger guarantees a UTXO can be spent
//// exactly once, so this policy can succeed exactly once — after the genesis
//// transaction, no further minting under this policy id is possible by
//// anyone, including the platform. Nothing needs to expire and no key needs
//// to be destroyed.
////
//// The seed comes from the CREATOR'S own wallet, so uniqueness needs no
//// platform involvement at all.
////
//// SUPPLY IS STRUCTURAL, NOT DECLARED
//// `total_supply` is a parameter too, and the policy requires the minted
//// quantity to equal it exactly. Combined with the one-shot property, the
//// cap becomes a fact about the chain rather than a promise about the
//// platform's behaviour: a launch's token supply is fixed at its first and
//// only mint, and is verifiable from the policy id alone.
////
//// NO BURN, EVER
//// The same pins that fix the mint rule out its reverse: a negative quantity
//// under this policy id fails the exact-quantity checks, so the supply the
//// genesis transaction fixed can never be reduced under this policy either.
//// A holder may still send tokens to an address nobody can spend from, but
//// that is a transfer the chain sees as a transfer, not a burn.
////
//// THE CIP-68 PAIR
//// One transaction mints two assets: the fungible supply under CIP-67 label
//// 333, and a single reference NFT under label 100 carrying the same base
//// name. CIP-68 requires both to live under one policy id — that shared
//// policy plus the shared base name is precisely how a wallet holding the
//// token finds the metadata describing it.
////
//// Minting the pair together is what lets the supply stay one-shot AND the
//// metadata stay updatable for the life of the launch: CIP-68 metadata is
//// revised by SPENDING the reference NFT's UTXO, never by minting again, so
//// a policy that can never mint again is no constraint on it. The reference
//// NFT is minted here, at genesis, inside the single shot this policy has.
////
//// Exactly these two assets, and nothing else, may be minted. A third name
//// would be an unaccounted asset riding along under the launch's own policy
//// id, indistinguishable to a holder from the real token.

use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{from_verification_key}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction}
use noctis/cip68

validator launch_token_policy(seed: OutputReference, total_supply: Int) {
  mint(_redeemer: Void, policy_id: PolicyId, self: Transaction) {
    let minted = assets.tokens(self.mint, policy_id)
    // Exactly two names under this policy — the CIP-68 pair, nothing else.
    // `expect` on a two-element list is the clean way to say that: one name,
    // three names, or none, fails here.
    //
    // `dict.to_pairs` yields names in ascending byte order and the label 100
    // prefix always sorts before label 333 (they differ at byte 1, 0x06 <
    // 0x14), so the reference NFT is always first regardless of base name —
    // pinned by cip68.ak's reference_label_sorts_before_fungible_label.
    expect [Pair(reference_name, reference_amount),
      Pair(supply_name, supply_amount)] = dict.to_pairs(minted)
    and {
      // The one-shot: this UTXO can never be spent a second time, so this
      // policy can never mint a second time.
      list.any(self.inputs, fn(input) { input.output_reference == seed }),
      // Both halves of the CIP-68 pair, correctly labelled...
      cip68.has_label(reference_name, cip68.label_reference_nft),
      cip68.has_label(supply_name, cip68.label_fungible_token),
      // ...and describing the SAME token. Without this the reference NFT
      // could name a different asset than the one it is meant to describe.
      cip68.base_name(reference_name) == cip68.base_name(supply_name),
      // CIP-68's reference NFT is a single unit by definition.
      reference_amount == 1,
      // The whole supply exists after this transaction, or the transaction
      // does not happen.
      supply_amount == total_supply,
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

const seed_ref: OutputReference =
  OutputReference { transaction_id: #"aa", output_index: 3 }

const policy: PolicyId = #"c0ffee"

const supply: Int = 1_000_000_000

const ticker: ByteArray = "NOCT"

fn seed_input() -> Input {
  Input {
    output_reference: seed_ref,
    output: Output {
      address: from_verification_key(#"11"),
      value: assets.from_lovelace(10_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

/// A genesis mint of the CIP-68 pair, with each half's name and quantity
/// controllable so a test can break exactly one of them.
fn pair_tx(
  inputs: List<Input>,
  reference_name: ByteArray,
  reference_amount: Int,
  supply_name: ByteArray,
  supply_amount: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: inputs,
    mint: assets.merge(
      assets.from_asset(policy, reference_name, reference_amount),
      assets.from_asset(policy, supply_name, supply_amount),
    ),
  }
}

fn honest_tx(inputs: List<Input>) -> Transaction {
  pair_tx(
    inputs,
    cip68.reference_asset_name(ticker),
    1,
    cip68.fungible_asset_name(ticker),
    supply,
  )
}

test mint_succeeds_with_the_cip68_pair() {
  launch_token_policy.mint(
    seed_ref,
    supply,
    Void,
    policy,
    honest_tx([seed_input()]),
  )
}

/// Without the seed the policy is dead. This is the whole property: once the
/// genesis transaction has spent that UTXO, no later transaction can satisfy
/// this, so no further supply can ever exist.
test mint_rejects_when_seed_is_not_consumed() {
  let other =
    Input {
      ..seed_input(),
      output_reference: OutputReference {
        transaction_id: #"bb",
        output_index: 0,
      },
    }
  !launch_token_policy.mint(seed_ref, supply, Void, policy, honest_tx([other]))
}

/// The supply cap is enforced by the policy, not declared off-chain.
test mint_rejects_over_supply() {
  !launch_token_policy.mint(
    seed_ref,
    supply,
    Void,
    policy,
    pair_tx(
      [seed_input()],
      cip68.reference_asset_name(ticker),
      1,
      cip68.fungible_asset_name(ticker),
      supply + 1,
    ),
  )
}

test mint_rejects_under_supply() {
  !launch_token_policy.mint(
    seed_ref,
    supply,
    Void,
    policy,
    pair_tx(
      [seed_input()],
      cip68.reference_asset_name(ticker),
      1,
      cip68.fungible_asset_name(ticker),
      supply - 1,
    ),
  )
}

/// CIP-68's reference NFT is a single unit. More than one would leave two
/// UTXOs each claiming to describe the same token.
test mint_rejects_multiple_reference_nfts() {
  !launch_token_policy.mint(
    seed_ref,
    supply,
    Void,
    policy,
    pair_tx(
      [seed_input()],
      cip68.reference_asset_name(ticker),
      2,
      cip68.fungible_asset_name(ticker),
      supply,
    ),
  )
}

/// The pair must describe one token. A reference NFT naming something else
/// would be metadata attached to an asset that does not exist.
test mint_rejects_mismatched_base_names() {
  !launch_token_policy.mint(
    seed_ref,
    supply,
    Void,
    policy,
    pair_tx(
      [seed_input()],
      cip68.reference_asset_name("OTHER"),
      1,
      cip68.fungible_asset_name(ticker),
      supply,
    ),
  )
}

/// An unlabelled name is not discoverable as CIP-68 at all, so it is not a
/// valid launch token. Two unlabelled names sort unpredictably against the
/// labels, so this is checked on the supply half where the label test bites
/// directly.
test mint_rejects_unlabelled_supply_name() {
  !launch_token_policy.mint(
    seed_ref,
    supply,
    Void,
    policy,
    pair_tx([seed_input()], cip68.reference_asset_name(ticker), 1, ticker, supply),
  )
}

/// Declared `fail` rather than negated: the two-element `expect` above TRAPS
/// on any other count instead of returning False. On-chain the effect is
/// identical — the script fails, so the transaction is rejected — but the two
/// are different in Aiken, and a negated assertion would error rather than
/// pass.
test mint_rejects_a_third_asset_name() fail {
  let tx =
    Transaction {
      ..honest_tx([seed_input()]),
      mint: assets.merge(
        assets.merge(
          assets.from_asset(policy, cip68.reference_asset_name(ticker), 1),
          assets.from_asset(policy, cip68.fungible_asset_name(ticker), supply),
        ),
        assets.from_asset(policy, cip68.fungible_asset_name("EXTRA"), 1),
      ),
    }
  launch_token_policy.mint(seed_ref, supply, Void, policy, tx)
}

/// The supply alone, with no reference NFT, is a token nothing can describe.
/// Traps for the same reason as the case above.
test mint_rejects_supply_without_a_reference_nft() fail {
  let tx =
    Transaction {
      ..honest_tx([seed_input()]),
      mint: assets.from_asset(
        policy,
        cip68.fungible_asset_name(ticker),
        supply,
      ),
    }
  launch_token_policy.mint(seed_ref, supply, Void, policy, tx)
}

/// Burning is not a special case: a burn is a negative quantity, which is not
/// equal to total_supply, so it is rejected like any other amount. The supply
/// is therefore fixed in both directions for the life of the launch.
test mint_rejects_burn() {
  !launch_token_policy.mint(
    seed_ref,
    supply,
    Void,
    policy,
    pair_tx(
      [seed_input()],
      cip68.reference_asset_name(ticker),
      1,
      cip68.fungible_asset_name(ticker),
      -supply,
    ),
  )
}

/// The validator reads the pair positionally out of a sorted dict. This mints
/// the same pair via a value built in the opposite order to show the result
/// does not depend on how the transaction was assembled — the sort, not the
/// caller, decides.
test mint_is_independent_of_assembly_order() {
  let reversed =
    Transaction {
      ..honest_tx([seed_input()]),
      mint: assets.merge(
        assets.from_asset(policy, cip68.fungible_asset_name(ticker), supply),
        assets.from_asset(policy, cip68.reference_asset_name(ticker), 1),
      ),
    }
  launch_token_policy.mint(seed_ref, supply, Void, policy, reversed)
}

/// A long ticker still fills exactly the 32-byte asset-name limit once the
/// label is applied, and the policy treats it no differently.
test mint_succeeds_with_a_maximum_length_ticker() {
  let longest = "abcdefghijklmnopqrstuvwxyz12"
  and {
    bytearray.length(cip68.fungible_asset_name(longest)) == 32,
    launch_token_policy.mint(
      seed_ref,
      supply,
      Void,
      policy,
      pair_tx(
        [seed_input()],
        cip68.reference_asset_name(longest),
        1,
        cip68.fungible_asset_name(longest),
        supply,
      ),
    ),
  }
}
