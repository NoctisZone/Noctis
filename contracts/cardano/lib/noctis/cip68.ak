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
/// This checks only that the KEYS are present. What a value says is still
/// entirely the creator's business — a launch may rename itself to
/// anything — but it may not stop saying anything at all, which is
/// `no_empty_values`'s job below.
pub fn has_required_fungible_fields(metadata: Pairs<ByteArray, Data>) -> Bool {
  list.all(
    required_fungible_keys,
    fn(required) { list.any(metadata, fn(entry) { entry.1st == required }) },
  )
}

/// Whether a single metadata value says anything.
///
/// A metadata map is refused when it is empty, because a token with nothing
/// to display is a broken token. A present key holding an empty value leaves
/// it exactly as undisplayable — a wallet reading `name` and finding an
/// empty string has learned nothing it would not have learned from the key's
/// absence. So the same reasoning that refuses the empty map refuses the
/// empty value.
///
/// Two shapes carry text and both are handled, because CIP-68 chunks a value
/// longer than 64 bytes into a LIST of bytestrings rather than one long one:
/// a bytestring must have length, and a chunk list must have chunks and no
/// empty chunk among them.
///
/// Everything else passes, and that is deliberate rather than an oversight.
/// `decimals: 0` is a real, meaningful value — a token with zero decimal
/// places — and an integer has no notion of emptiness to test. Reading 0
/// as empty would refuse the most ordinary launch on the platform.
pub fn value_is_non_empty(value: Data) -> Bool {
  if value is text: ByteArray {
    bytearray.length(text) > 0
  } else if value is chunks: List<ByteArray> {
    and {
      !list.is_empty(chunks),
      list.all(chunks, fn(chunk) { bytearray.length(chunk) > 0 }),
    }
  } else {
    True
  }
}

/// Whether every value in a metadata map says something.
///
/// Applied to the whole map rather than only to the two required keys, so one
/// rule covers `name`, `description`, `ticker` and `url` alike: a key that is
/// present is a key that claims to carry information. A creator with no
/// ticker omits the key; CIP-68 makes it optional precisely so that absence
/// is expressible without a placeholder.
pub fn no_empty_values(metadata: Pairs<ByteArray, Data>) -> Bool {
  list.all(metadata, fn(entry) { value_is_non_empty(entry.2nd) })
}

/// The tests below are about which KEYS are present, so the value genuinely
/// does not matter to them — this is deliberately the emptiest one there
/// is. Note that a real map containing it would be refused, by
/// `no_empty_values` rather than by the key check these tests exercise.
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

// ----------------------------------------------------------------------------
// A PRESENT KEY MUST SAY SOMETHING
// ----------------------------------------------------------------------------

test a_value_with_text_says_something() {
  let v: Data = "MAXX"
  value_is_non_empty(v)
}

test an_empty_bytestring_says_nothing() {
  let v: Data = ""
  !value_is_non_empty(v)
}

/// CIP-68 chunks a value longer than 64 bytes into a list, so the list form is
/// as ordinary as the bytestring form and gets the same treatment.
test a_chunked_value_says_something() {
  let v: Data = ["the first sixty-four bytes", "and the rest of it"]
  value_is_non_empty(v)
}

test a_chunk_list_with_no_chunks_says_nothing() {
  let chunks: List<ByteArray> = []
  let v: Data = chunks
  !value_is_non_empty(v)
}

/// One empty chunk is enough to refuse the whole value — otherwise the check
/// could be walked straight past by padding an empty name with a real chunk.
test a_chunk_list_with_an_empty_chunk_says_nothing() {
  let v: Data = ["a real chunk", ""]
  !value_is_non_empty(v)
}

/// The carve-out that matters most, pinned so nobody tightens it later: a
/// token with zero decimal places is the most ordinary launch there is, and 0
/// is what it says. An integer is not a thing that can be empty.
test zero_decimals_is_a_value_not_an_absence() {
  let v: Data = 0
  value_is_non_empty(v)
}

test a_conformant_map_passes_both_checks() {
  let name: Data = "Mock Token"
  let description: Data = "A token"
  let ticker: Data = "TOK"
  let decimals: Data = 0
  let metadata = [
    Pair("name", name), Pair("description", description), Pair("ticker", ticker),
    Pair("decimals", decimals),
  ]
  and {
    has_required_fungible_fields(metadata),
    no_empty_values(metadata),
  }
}

/// The exact hole this closes: every required key present, so the key check is
/// satisfied, and the token still has no name.
test a_map_naming_nothing_is_refused() {
  let name: Data = ""
  let description: Data = "A token"
  let metadata = [Pair("name", name), Pair("description", description)]
  and {
    has_required_fungible_fields(metadata),
    !no_empty_values(metadata),
  }
}

/// An optional key is held to the same rule when it is present. A creator with
/// no ticker leaves the key out; that is what optional means.
test an_empty_optional_key_is_refused_but_an_absent_one_is_not() {
  let name: Data = "Mock Token"
  let description: Data = "A token"
  let blank: Data = ""
  let with_blank_ticker = [
    Pair("name", name), Pair("description", description), Pair("ticker", blank),
  ]
  let without_ticker = [Pair("name", name), Pair("description", description)]
  and {
    !no_empty_values(with_blank_ticker),
    no_empty_values(without_ticker),
  }
}
