//// Vendored from Splash splash-core `validators_v3` (CC0-1.0 / Apache-2.0).
//// Modified by Noctis (2026-09-06): `RoyaltyWithdrawConfig` gained a trailing
//// `owner` field, the key that may refund the request. `WithdrawData` and
//// `WithdrawRoyaltyDataToSign`, the parts under the creator's signature, are
//// unchanged.

use aiken/crypto.{VerificationKeyHash}
use splash/plutus.{Asset}

pub type RoyaltyWithdrawConfig {
  withdraw_data: WithdrawData,
  signature: ByteArray,
  additional_bytes: ByteArray,
  /// Noctis addition: who placed the request and may take it back.
  owner: VerificationKeyHash,
}

pub type WithdrawData {
  pool_nft: Asset,
  withdraw_royalty_x: Int,
  withdraw_royalty_y: Int,
  ex_fee: Int,
}

// Used to build message for signature verification
pub type WithdrawRoyaltyDataToSign {
  withdraw_data: WithdrawData,
  pool_nonce: Int,
}

pub type DoubleRoyaltyWithdrawRedeemer {
  pool_in_ix: Int,
  order_in_ix: Int,
  signer: Int,
  hash: Bool,
}

pub type RoyaltyWithdrawRedeemer {
  pool_in_ix: Int,
  order_in_ix: Int,
  hash: Bool,
}
