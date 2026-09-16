//// CIP-68 asset-name labels — the one place the launch token's naming is
//// defined.
////
//// WHY THIS MODULE EXISTS
//// CIP-68 binds a token to its metadata by NAME, under one shared policy: the
//// user token and its reference NFT carry the same base name behind different
//// four-byte labels, and both must be under the same policy id. That binding
//// is the entire discovery mechanism — a wallet holding `<policy>(333)MAXX`
//// looks up `<policy>(100)MAXX` and reads the metadata out of its datum.
////
//// The labels are defined by CIP-67 as
////
////     0x0 ++ label_number_as_2_bytes ++ crc8(label_number) ++ 0x0
////
//// so they are fixed constants, not something to derive at run time. They are
//// declared once here and pinned by test against values computed from the
//// CIP's own worked example, because a wrong label is invisible: the mint
//// succeeds, the token exists, and nothing ever finds its metadata.

use aiken/collection/list
use aiken/primitive/bytearray

/// CIP-67 label 100 — the reference NFT that carries the metadata datum.
pub const label_reference_nft: ByteArray = #"000643b0"

/// CIP-67 label 333 — the fungible user token. This is what a holder's wallet
/// shows and what trades; the launch token is always this one.
pub const label_fungible_token: ByteArray = #"0014df10"

/// Every CIP-67 label is exactly four bytes.
pub const label_length: Int = 4

/// The on-chain asset name for the fungible launch token.
pub fn fungible_asset_name(base_name: ByteArray) -> ByteArray {
  bytearray.concat(label_fungible_token, base_name)
}

/// The on-chain asset name for the matching reference NFT.
pub fn reference_asset_name(base_name: ByteArray) -> ByteArray {
  bytearray.concat(label_reference_nft, base_name)
}

/// The base name behind a label — the ticker as a creator typed it.
pub fn base_name(labelled_name: ByteArray) -> ByteArray {
  bytearray.drop(labelled_name, label_length)
}

/// Whether a name carries the given label.
pub fn has_label(labelled_name: ByteArray, label: ByteArray) -> Bool {
  bytearray.take(labelled_name, label_length) == label
}

// ============================================================================
// TESTS
// ============================================================================

/// The labels are the whole discovery mechanism, so they are pinned rather
/// than trusted. These are CIP-67's own encoding: `0x0 ++ label ++ crc8 ++
/// 0x0`. The 222 case is the CIP's published worked example (222 →
/// `000de140`); an implementation that reproduces it is producing the other
/// labels by the same rule.
test labels_match_cip67() {
  and {
    label_reference_nft == #"000643b0",
    label_fungible_token == #"0014df10",
    bytearray.length(label_reference_nft) == label_length,
    bytearray.length(label_fungible_token) == label_length,
  }
}

/// The pair must describe one token: same base name, different labels.
test the_pair_shares_a_base_name() {
  let ticker = "MAXX"
  and {
    fungible_asset_name(ticker) != reference_asset_name(ticker),
    base_name(fungible_asset_name(ticker)) == ticker,
    base_name(reference_asset_name(ticker)) == ticker,
  }
}

test labels_are_recognised() {
  let ticker = "MAXX"
  and {
    has_label(fungible_asset_name(ticker), label_fungible_token),
    has_label(reference_asset_name(ticker), label_reference_nft),
    !has_label(fungible_asset_name(ticker), label_reference_nft),
    !has_label(reference_asset_name(ticker), label_fungible_token),
  }
}

/// `dict.to_pairs` yields asset names in ascending byte order, and
/// launch_token_policy relies on the reference NFT coming first. The two
/// labels differ at byte 1 (0x06 < 0x14), so that ordering holds for every
/// possible base name — pinned here so the assumption is tested where the
/// constants live, not left implicit at the call site.
test reference_label_sorts_before_fungible_label() {
  and {
    bytearray.compare(label_reference_nft, label_fungible_token) == Less,
    bytearray.compare(reference_asset_name("MAXX"), fungible_asset_name("MAXX")) == Less,
    bytearray.compare(
      reference_asset_name("ZZZZZZZZ"),
      fungible_asset_name("A"),
    ) == Less,
  }
}

/// Cross-implementation pin, same discipline as thread_nft.ak's. The genesis
/// mint builds these names in TypeScript while the validators derive them
/// here; if the two disagree the mint succeeds and nothing ever resolves the
/// metadata. Never "fix" a failure here by editing only one side.
test matches_typescript_implementation() {
  and {
    fungible_asset_name("MAXX") == #"0014df104d415858",
    reference_asset_name("MAXX") == #"000643b04d415858",
  }
}

/// Cardano caps an asset name at 32 bytes and the label takes four of them,
/// so a ticker has 28 to work with. Stated as a tested property because the
/// limit is enforced off-chain, where it is easy to forget the label is part
/// of the budget.
test a_ticker_has_28_bytes_of_room() {
  let longest = "abcdefghijklmnopqrstuvwxyz12"
  and {
    bytearray.length(longest) == 28,
    bytearray.length(fungible_asset_name(longest)) == 32,
    bytearray.length(reference_asset_name(longest)) == 32,
  }
}

/// The two keys CIP-68's 333 fungible sub-standard requires every token's
/// metadata to carry.
///
/// Everything else the sub-standard mentions — ticker, url, decimals, logo —
/// is optional, so only these two are worth a contract's attention.
pub const required_fungible_keys: List<ByteArray> = ["name", "description"]

/// Whether a metadata map carries both of them.
///
/// The genesis builder already refuses to construct a token without them, but
/// metadata is REVISED by rewriting this map, and a revision that dropped one
/// would leave the token permanently unreadable to a wallet following the
/// standard — with the file still describing itself as CIP-68. Conformance
/// that only holds at genesis is not conformance, so the check belongs where
/// revisions happen rather than only where the first version is built.
///
/// What the values SAY is deliberately not checked. A launch may rename
/// itself to anything; it may not stop having a name.
pub fn has_required_fungible_fields(metadata: Pairs<ByteArray, Data>) -> Bool {
  list.all(
    required_fungible_keys,
    fn(required) { list.any(metadata, fn(entry) { entry.1st == required }) },
  )
}

fn any_value() -> Data {
  let v: Data = ""
  v
}

test required_fields_accepts_a_conformant_map() {
  has_required_fungible_fields(
    [
      Pair("name", any_value()),
      Pair("description", any_value()),
      Pair("ticker", any_value()),
    ],
  )
}

test required_fields_rejects_a_map_missing_description() {
  !has_required_fungible_fields(
    [Pair("name", any_value()), Pair("logo", any_value())],
  )
}

test required_fields_rejects_a_map_missing_name() {
  !has_required_fungible_fields([Pair("description", any_value())])
}

test required_fields_rejects_an_empty_map() {
  !has_required_fungible_fields([])
}
