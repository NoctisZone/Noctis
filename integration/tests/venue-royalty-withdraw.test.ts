// venue-royalty-withdraw.test.ts
//
// The creator's royalty withdraw: the request they sign, the signature a
// CIP-30 wallet hands back, and the fill an executor builds from both.
//
// Signatures here come from Lucid Evolution's own CIP-8 implementation
// (`signData`), which is what a browser wallet's `signData` produces, and are
// checked with CML's verifier, not the one the module uses. Keys are derived
// from fixed entropy, so every value is deterministic and can be pinned.

import { CML, credentialToAddress, Data, signData } from '@lucid-evolution/lucid';
import { Address } from '@meshsdk/core-cst';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import type { VenuePoolConfigData } from '../venue-pool.js';
import { VenuePoolConfigSchema } from '../venue-pool.js';
import {
  draftVenueRoyaltyWithdraw,
  planVenueRoyaltyWithdrawFill,
  VENUE_ROYALTY_REWARD_FLOOR_LOVELACE,
  VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE,
  VenueRoyaltyWithdrawConfigSchema,
  type VenueWithdrawOrderUtxo,
  venueRoyaltyKeyHash,
  venueRoyaltyWithdrawDatum,
  venueRoyaltyWithdrawPayload,
  venueRoyaltyWithdrawRedeemer,
  venueSignatureFromCip30,
  venueWithdrawSignatureForm,
} from '../venue-royalty-withdraw.js';
import type { VenuePoolUtxo } from '../venue-swap.js';

function keyFromEntropy(entropyHex: string) {
  const root = CML.Bip32PrivateKey.from_bip39_entropy(hexToBytes(entropyHex), new Uint8Array());
  const key = root
    .derive(1852 + 0x80000000)
    .derive(1815 + 0x80000000)
    .derive(0x80000000)
    .derive(0)
    .derive(0)
    .to_raw_key();
  return {
    key,
    bech32: key.to_bech32(),
    publicKeyHex: bytesToHex(key.to_public().to_raw_bytes()),
    keyHash: key.to_public().hash().to_hex(),
  };
}

const CREATOR = keyFromEntropy('33'.repeat(32));
const STRANGER = keyFromEntropy('44'.repeat(32));
const CREATOR_BASE_ADDRESS = credentialToAddress(
  'Preprod',
  { type: 'Key', hash: CREATOR.keyHash },
  { type: 'Key', hash: 'bb'.repeat(28) },
);

const TOKEN = { policy: 'aa'.repeat(28), name: '4a494e58' };
const NFT = { policy: 'cc'.repeat(28), name: '6e6674' };
const LQ = { policy: 'cc'.repeat(28), name: '6c71' };
const TOKEN_UNIT = TOKEN.policy + TOKEN.name;
const NFT_UNIT = NFT.policy + NFT.name;
const LQ_UNIT = LQ.policy + LQ.name;

function pool(overrides: Partial<VenuePoolConfigData> = {}): VenuePoolUtxo {
  const datum: VenuePoolConfigData = {
    pool_nft: NFT,
    pool_x: { policy: '', name: '' },
    pool_y: TOKEN,
    pool_lq: LQ,
    fee_num: 99_700n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 300_000n,
    treasury_y: 40n,
    royalty_x: 5_000_000n,
    royalty_y: 1_000n,
    dao_policy: [],
    treasury_address: 'ee'.repeat(28),
    royalty_pub_key: CREATOR.publicKeyHex,
    nonce: 3n,
    ...overrides,
  };
  return {
    txHash: '11'.repeat(32),
    outputIndex: 0,
    address: 'addr_test1wpool',
    assets: { lovelace: 900_000_000n, [TOKEN_UNIT]: 5_000_000n, [NFT_UNIT]: 1n, [LQ_UNIT]: 9_000_000n },
    datum,
  };
}

/** What a CIP-30 wallet returns for `signData(address, payload)`. */
function walletSign(payloadHex: string, key = CREATOR) {
  return signData(Address.fromBech32(CREATOR_BASE_ADDRESS).toBytes(), payloadHex, key.bech32);
}

/** CML's verifier, independent of the module's. */
function cmlVerifies(publicKeyHex: string, messageHex: string, signatureHex: string): boolean {
  return CML.PublicKey.from_bytes(hexToBytes(publicKeyHex)).verify(
    hexToBytes(messageHex),
    CML.Ed25519Signature.from_raw_bytes(hexToBytes(signatureHex)),
  );
}

async function signedRequest(p = pool(), key = CREATOR): Promise<VenueWithdrawOrderUtxo> {
  const draft = draftVenueRoyaltyWithdraw({ pool: p, network: 'Preprod' });
  const sig = await venueSignatureFromCip30(walletSign(draft.payloadHex, key), draft.payloadHex);
  return {
    txHash: '22'.repeat(32),
    outputIndex: 0,
    address: 'addr_test1wrequest',
    assets: { lovelace: draft.requestLovelace },
    datum: venueRoyaltyWithdrawDatum(draft, sig, key.keyHash),
  };
}

describe('drafting a withdraw request', () => {
  it('takes everything owed, pays the creator key, and carries the fee and the reward floor', () => {
    const draft = draftVenueRoyaltyWithdraw({ pool: pool(), network: 'Preprod' });
    expect(draft.withdrawData).toEqual({
      pool_nft: NFT,
      withdraw_royalty_x: 5_000_000n,
      withdraw_royalty_y: 1_000n,
      ex_fee: VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE,
    });
    expect(draft.poolNonce).toBe(3n);
    expect(draft.requestLovelace).toBe(VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE + VENUE_ROYALTY_REWARD_FLOOR_LOVELACE);
    expect(draft.payoutAddress).toBe(credentialToAddress('Preprod', { type: 'Key', hash: CREATOR.keyHash }));
  });

  it('pays the key the public key hashes to, which is the payment key a wallet signs with', () => {
    expect(venueRoyaltyKeyHash(CREATOR.publicKeyHex)).toBe(CREATOR.keyHash);
  });

  it('pins the signed payload to the bytes the withdraw script serialises', () => {
    // WithdrawRoyaltyDataToSign { WithdrawData { Asset{policy,name}, x, y, ex_fee }, nonce }, as
    // serialise_data writes it: tag 121 constructors over indefinite-length lists.
    const payload = venueRoyaltyWithdrawPayload(
      { pool_nft: NFT, withdraw_royalty_x: 5_000_000n, withdraw_royalty_y: 1_000n, ex_fee: 2_000_000n },
      3n,
    );
    expect(payload).toBe(`d8799fd8799fd8799f581c${NFT.policy}43${NFT.name}ff1a004c4b401903e81a001e8480ff03ff`);
  });

  it('encodes the fixture claim exactly as the compiler serialised it', () => {
    // `single_royalty_withdraw_pool.ak` records these bytes as captured from
    // Aiken's own `serialise_data`, not hand-encoded, so this is the builder
    // agreeing with the chain rather than with itself. Its wallet-signed test
    // signs the same claim.
    const payload = venueRoyaltyWithdrawPayload(
      {
        pool_nft: { policy: 'aa', name: '6e6674' },
        withdraw_royalty_x: 1_000_000n,
        withdraw_royalty_y: 200n,
        ex_fee: 2_000_000n,
      },
      3n,
    );
    expect(payload).toBe('d8799fd8799fd8799f41aa436e6674ff1a000f424018c81a001e8480ff03ff');
  });

  it('refuses to take more than is owed, nothing at all, or a negative amount', () => {
    expect(() => draftVenueRoyaltyWithdraw({ pool: pool(), network: 'Preprod', takeX: 5_000_001n })).toThrow(
      /owes 5000000 lovelace/,
    );
    expect(() =>
      draftVenueRoyaltyWithdraw({ pool: pool({ royalty_x: 0n, royalty_y: 0n }), network: 'Preprod' }),
    ).toThrow(/owes no royalty/);
    expect(() => draftVenueRoyaltyWithdraw({ pool: pool(), network: 'Preprod', takeY: -1n })).toThrow(/non-negative/);
  });
});

describe('reading a CIP-30 signature', () => {
  it('rebuilds what the wallet signed, so the prefix and the payload verify together', async () => {
    const { payloadHex } = draftVenueRoyaltyWithdraw({ pool: pool(), network: 'Preprod' });
    const sig = await venueSignatureFromCip30(walletSign(payloadHex), payloadHex);
    expect(sig.publicKeyHex).toBe(CREATOR.publicKeyHex);
    expect(sig.hashed).toBe(false);
    // The prefix ends with the byte-string header for the payload that follows it.
    expect(sig.additionalBytesHex.endsWith(`58${(payloadHex.length / 2).toString(16).padStart(2, '0')}`)).toBe(true);
    expect(cmlVerifies(sig.publicKeyHex, sig.additionalBytesHex + payloadHex, sig.signatureHex)).toBe(true);
  });

  it('refuses a wallet that signed a different message', async () => {
    const draft = draftVenueRoyaltyWithdraw({ pool: pool(), network: 'Preprod' });
    const other = draftVenueRoyaltyWithdraw({ pool: pool(), network: 'Preprod', takeX: 1n });
    await expect(venueSignatureFromCip30(walletSign(other.payloadHex), draft.payloadHex)).rejects.toThrow(
      /different message/,
    );
  });

  it('refuses a signature that does not verify', async () => {
    const { payloadHex } = draftVenueRoyaltyWithdraw({ pool: pool(), network: 'Preprod' });
    const signed = walletSign(payloadHex);
    // Flip one bit of the signature, the last field of the COSE_Sign1.
    const last = Number.parseInt(signed.signature.slice(-2), 16) ^ 1;
    const tampered = { ...signed, signature: signed.signature.slice(0, -2) + last.toString(16).padStart(2, '0') };
    await expect(venueSignatureFromCip30(tampered, payloadHex)).rejects.toThrow(/does not verify/);
  });
});

describe('what the executor checks before filling', () => {
  it('accepts the signature against the pool at the nonce it was signed for', async () => {
    const request = await signedRequest();
    await expect(venueWithdrawSignatureForm(pool(), request)).resolves.toEqual({ hashed: false });
  });

  it('accepts a signature over the hashed payload, and says so for the redeemer', async () => {
    const draft = draftVenueRoyaltyWithdraw({ pool: pool(), network: 'Preprod' });
    const prefix = 'a0';
    const message = prefix + bytesToHex(blake2b(hexToBytes(draft.payloadHex), { dkLen: 28 }));
    const signature = CREATOR.key.sign(hexToBytes(message)).to_hex();
    const request = {
      datum: venueRoyaltyWithdrawDatum(draft, { signatureHex: signature, additionalBytesHex: prefix }, CREATOR.keyHash),
    };
    await expect(venueWithdrawSignatureForm(pool(), request)).resolves.toEqual({ hashed: true });
  });

  it('refuses a request signed before another withdrawal moved the nonce', async () => {
    const request = await signedRequest();
    await expect(venueWithdrawSignatureForm(pool({ nonce: 4n }), request)).rejects.toThrow(
      /at nonce 4.*only be refunded/s,
    );
  });

  it('refuses a request signed by a key the pool does not pay', async () => {
    const request = await signedRequest(pool(), STRANGER);
    await expect(venueWithdrawSignatureForm(pool(), request)).rejects.toThrow(/does not verify/);
  });
});

describe('laying out the fill', () => {
  it('moves the counters and the reserves by the amounts taken, bumps the nonce, and pays the creator key', async () => {
    const p = pool();
    const request = await signedRequest(p);
    const fill = await planVenueRoyaltyWithdrawFill({
      pool: p,
      request,
      network: 'Preprod',
      minOutputLovelace: 1_000_000n,
    });
    expect(fill.poolAssets).toEqual({
      lovelace: 895_000_000n,
      [TOKEN_UNIT]: 4_999_000n,
      [NFT_UNIT]: 1n,
      [LQ_UNIT]: 9_000_000n,
    });
    expect(fill.nextDatum).toEqual({ ...p.datum, royalty_x: 0n, royalty_y: 0n, nonce: 4n });
    expect(Data.from(fill.nextDatumCbor, VenuePoolConfigSchema)).toEqual(fill.nextDatum);
    expect(fill.reward).toEqual({
      address: credentialToAddress('Preprod', { type: 'Key', hash: CREATOR.keyHash }),
      assets: { lovelace: 5_000_000n + VENUE_ROYALTY_REWARD_FLOOR_LOVELACE, [TOKEN_UNIT]: 1_000n },
    });
    expect(fill.exFee).toBe(VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE);
    expect(fill.hashed).toBe(false);
  });

  it('round-trips the request datum through the schema the validator decodes', async () => {
    const request = await signedRequest();
    const cbor = Data.to(request.datum, VenueRoyaltyWithdrawConfigSchema);
    expect(Data.from(cbor, VenueRoyaltyWithdrawConfigSchema)).toEqual(request.datum);
  });

  it('refuses a request holding anything but ADA, or too little ADA for its fee', async () => {
    const request = await signedRequest();
    const args = { pool: pool(), network: 'Preprod' as const, minOutputLovelace: 1_000_000n };
    await expect(
      planVenueRoyaltyWithdrawFill({
        ...args,
        request: { ...request, assets: { ...request.assets, [TOKEN_UNIT]: 1n } },
      }),
    ).rejects.toThrow(/carries ADA and nothing else/);
    await expect(
      planVenueRoyaltyWithdrawFill({ ...args, request: { ...request, assets: { lovelace: 1_000_000n } } }),
    ).rejects.toThrow(/against a fee of 2000000/);
  });

  it('refuses a request for more than the pool now owes', async () => {
    const request = await signedRequest();
    await expect(
      planVenueRoyaltyWithdrawFill({
        pool: pool({ royalty_x: 4_000_000n }),
        request,
        network: 'Preprod',
        minOutputLovelace: 1_000_000n,
      }),
    ).rejects.toThrow(/pool owes 4000000/);
  });

  it('names the withdraw script redeemer by position and signature form', () => {
    expect(venueRoyaltyWithdrawRedeemer(1, 0, false)).toBe('d8799f0100d87980ff');
    expect(venueRoyaltyWithdrawRedeemer(0, 1, true)).toBe('d8799f0001d87a80ff');
  });
});
