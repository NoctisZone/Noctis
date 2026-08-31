// ============================================================================
// Noctis Zone — Real Cardano transaction submitter for
// contracts/cardano/validators/cto_sybil_challenge.ak
// ============================================================================
// The submission/resolution half of item #16's off-chain evidence pipeline
// (integration/cto-sybil-challenge-evidence.ts builds the evidence this
// submitter deposits a bond against).
//
// Two real transactions, two different signers:
//   - submitChallenge — the CHALLENGER's own wallet pays the bond
//     (NHOP_CHALLENGE_BOND, 25 ADA) and deposits it plus an inline datum at
//     the contract's fixed script address, AND mints the challenge token
//     that makes the deposit resolvable. Modeled on
//     darkveil-claim-submitter.ts's buyer-wallet-signed pattern
//     (lucid.selectWallet.fromAPI).
//
//     THE MINT IS NOT OPTIONAL, and the reason is worth stating because the
//     opposite is intuitive. Creating a script UTXO needs no validator
//     approval — only spending one does — so a deposit alone builds and
//     submits happily. But `spend` requires this validator's own token on the
//     input it settles and requires that token burned in the same
//     transaction, so a deposit made without the mint can never be resolved
//     by either arm: the bond goes in and has no way out. Minting IS
//     validated, which is the whole point — it is what makes `submitted_at`
//     a time the chain agreed to rather than one the challenger chose, and
//     the defence window counts from that field. `mint` and `spend` are two
//     handlers of one script, so the policy id IS the script hash and nobody
//     else can mint this token.
//   - resolveChallenge — GOVERNOR-signed (matches the validator's own
//     list.has(self.extra_signatories, datum.governor_pub_key_hash) check),
//     spends the challenge UTXO with ResolveChallenge, paying either the
//     challenger in full (Upheld) or treasury+ops split 60/40 (Rejected).
//     Modeled on cardano-cto-anchor-submitter.ts's relayer-private-key
//     pattern.
//
// Datum/redeemer schema hand-mirrored from a FRESHLY REGENERATED
// contracts/cardano/plutus.json (`aiken build`, 2026-07-19) — field
// names/order/constructor index (0, the only redeemer variant) read
// directly from the blueprint's real JSON, not from the .ak source
// comments — same discipline every other submitter in this session
// established (earlier fixes already document this codebase's drift risk on
// exactly this point).
//
// What is NOT tested: an actual end-to-end submission against a live
// Cardano node — needs funded challenger/governor keys and a deployed
// contract instance, neither available in this dev environment. Same
// honest boundary as every other submitter in this codebase.
// ============================================================================

import type {
  LucidEvolution,
  Network as LucidNetwork,
  MintingPolicy,
  SpendingValidator,
  UTxO,
  WalletApi,
} from '@lucid-evolution/lucid';
import {
  Blockfrost,
  Constr,
  credentialToAddress,
  Data,
  getAddressDetails,
  Lucid,
  validatorToAddress,
  validatorToScriptHash,
} from '@lucid-evolution/lucid';
import { CTO_SYBIL_MINT_REDEEMER } from './redeemer-indices.js';

// ============================================================================
// DATA SCHEMAS — mirror the fresh contracts/cardano/plutus.json exactly
// ============================================================================

const CtoSybilChallengeDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  governor_pub_key_hash: Data.Bytes(),
  challenged_voter_key: Data.Bytes(),
  challenged_proposal_id: Data.Bytes(),
  challenger_key_hash: Data.Bytes(),
  bond_amount: Data.Integer(),
  submitted_at: Data.Integer(),
  evidence_hash: Data.Bytes(),
  treasury_pub_key_hash: Data.Bytes(),
  ops_pub_key_hash: Data.Bytes(),
});
type CtoSybilChallengeDatumData = Data.Static<typeof CtoSybilChallengeDatumShape>;
const CtoSybilChallengeDatumSchema = CtoSybilChallengeDatumShape as unknown as CtoSybilChallengeDatumData;

/**
 * ResolveChallenge — the only real redeemer variant (constructor index 0,
 * verified against the fresh blueprint, 2026-07-19). A plain Data.Object is
 * sufficient since this is the sole variant — same reasoning
 * cardano-cto-anchor-submitter.ts already established for AnchorVoteResult.
 */
const ResolveChallengeRedeemerShape = Data.Object({
  upheld: Data.Boolean(),
  current_timestamp: Data.Integer(),
});
type ResolveChallengeRedeemerData = Data.Static<typeof ResolveChallengeRedeemerShape>;
const ResolveChallengeRedeemerSchema = ResolveChallengeRedeemerShape as unknown as ResolveChallengeRedeemerData;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ============================================================================
// PARAMS
// ============================================================================

export interface SubmitChallengeParams {
  launchId: Uint8Array;
  governorPubKeyHash: Uint8Array;
  challengedVoterKey: Uint8Array;
  challengedProposalId: Uint8Array;
  bondAmountLovelace: bigint;
  evidenceHash: Uint8Array;
  treasuryPubKeyHash: Uint8Array;
  opsPubKeyHash: Uint8Array;
}

export interface ResolveChallengeParams {
  launchId: Uint8Array;
  /** Distinguishes multiple open challenges for the same launch (a launch may accumulate several over time). Matched against challenged_voter_key + challenged_proposal_id in the datum. */
  challengedVoterKey: Uint8Array;
  challengedProposalId: Uint8Array;
  upheld: boolean;
  currentTimestamp: bigint;
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface CardanoCtoSybilChallengeSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** cto_sybil_challenge.ak's compiled PlutusV3 script CBOR — plutus.json's `validators[].compiledCode` for `cto_sybil_challenge.cto_sybil_challenge.spend`. One fixed address shared by every launch, same pattern as every other Cardano validator (no constructor params). */
  compiledScriptCbor: string;
  /** Governor's private key — only used by resolveChallenge, never by submitChallenge (which is challenger-wallet-signed). */
  governorPrivateKey?: string;
}

/**
 * `challenge_asset_name` in cto_sybil_challenge.ak — the literal `"sybil"`.
 *
 * One name for every challenge, deliberately: what makes a challenge unique
 * is the UTXO it lives in, and `spend` already binds a resolution to that.
 */
const CHALLENGE_ASSET_NAME_HEX = Buffer.from('sybil', 'utf8').toString('hex');

/**
 * `max_validity_range_width` in the validator, halved either side of the
 * timestamp. Both handlers require a range that CONTAINS the timestamp and is
 * no wider than this — `interval.contains` alone would let a caller widen the
 * range and pick a time far from the real one.
 */
const VALIDITY_HALF_WIDTH_MS = 240_000;

export class CardanoCtoSybilChallengeSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  /**
   * The same script, attached for its minting handler. `mint` and `spend` are
   * two handlers of one Aiken validator, so this is the identical CBOR under a
   * different Lucid type — not a second script and not a second address.
   */
  private mintingPolicy: MintingPolicy;
  private scriptAddress: string;
  /** Policy id + asset name of the challenge token. The policy IS the script hash. */
  private challengeUnit: string;

  constructor(private config: CardanoCtoSybilChallengeSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.mintingPolicy = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.challengeUnit = validatorToScriptHash(this.validator) + CHALLENGE_ASSET_NAME_HEX;
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  /** findChallengeUtxo only ever returns a UTXO it already confirmed has a
   *  datum (it skips undatumed UTXOs while scanning below) — this just
   *  makes that invariant explicit at each call site with a clear error
   *  instead of a silent `!` non-null assertion. */
  private requireDatum(utxo: UTxO): string {
    if (!utxo.datum) {
      throw new Error(
        'CTO sybil challenge UTXO has no inline datum (unexpected — findChallengeUtxo should only return UTXOs with one).',
      );
    }
    return utxo.datum;
  }

  /**
   * The one open challenge for a given (voter, proposal), authenticated by the
   * challenge token.
   *
   * Sibling of launch-utxo-lookup.ts and the same two rules — require a token,
   * and refuse rather than choose — for the same reason: this validator is
   * unparameterized, so every challenge across every launch shares one address
   * and a datum there is written by whoever paid the output.
   *
   * It is STRONGER here than for the launch lookups, and worth saying why: the
   * policy id is this script's own hash rather than a field read off the datum
   * under inspection, so a forger cannot mint a token that satisfies it at
   * all. There is no residual "self-authored policy" case to reason about.
   *
   * Ambiguity is still possible and still refused — the asset name is shared
   * by every challenge, so two challenges naming the same (voter, proposal)
   * both carry a genuine token. Taking the first would let a cheap decoy
   * absorb a resolution meant for the real one.
   */
  private async findChallengeUtxo(
    lucid: LucidEvolution,
    challengedVoterKey: Uint8Array,
    challengedProposalId: Uint8Array,
  ): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.scriptAddress);
    const voterKeyHex = toHex(challengedVoterKey);
    const proposalIdHex = toHex(challengedProposalId);
    const matches: UTxO[] = [];
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let decoded: CtoSybilChallengeDatumData;
      try {
        decoded = Data.from<CtoSybilChallengeDatumData>(utxo.datum, CtoSybilChallengeDatumSchema);
      } catch {
        continue;
      }
      if (decoded.challenged_voter_key !== voterKeyHex || decoded.challenged_proposal_id !== proposalIdHex) {
        continue;
      }
      if ((utxo.assets[this.challengeUnit] ?? 0n) !== 1n) continue;
      matches.push(utxo);
    }

    if (matches.length === 0) {
      throw new Error(
        `No open cto_sybil_challenge UTXO carrying the challenge token found for voter_key ${voterKeyHex} / ` +
          `proposal ${proposalIdHex} at ${this.scriptAddress}. Either no challenge was opened, or it has ` +
          'already been resolved.',
      );
    }
    if (matches.length > 1) {
      const refs = matches.map((u) => `${u.txHash}#${u.outputIndex}`).join(', ');
      throw new Error(
        `${matches.length} open challenges name voter_key ${voterKeyHex} / proposal ${proposalIdHex}: ${refs}. ` +
          'Refusing to guess which to resolve — exactly one is expected, so this needs investigating before ' +
          'any bond is paid out.',
      );
    }

    const only = matches[0];
    if (!only) {
      throw new Error('unreachable: matches has exactly one element');
    }
    return only;
  }

  /**
   * Challenger-initiated: deposits the bond at the fixed script address and
   * mints the challenge token in the same transaction. Signed by the
   * challenger's own connected wallet, which pays the real bond.
   *
   * No SpendingValidator is attached — nothing is being spent here — but the
   * minting policy is, because the mint is what makes the deposit resolvable
   * later. See this file's header for why a deposit alone is a dead end.
   */
  async submitChallenge(walletApi: WalletApi, params: SubmitChallengeParams): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);

    const challengerAddress = await lucid.wallet().address();
    const challengerKeyHash = getAddressDetails(challengerAddress).paymentCredential?.hash;
    if (!challengerKeyHash) {
      throw new Error('Connected wallet has no resolvable payment key hash — cannot submit as challenger.');
    }

    // MILLISECONDS: the defence window is measured from this field, and the
    // resolve path compares it against a timestamp bound to the transaction's
    // own validity range, which Cardano expresses in ms.
    const submittedAt = BigInt(Date.now());

    const datum: CtoSybilChallengeDatumData = {
      launch_id: toHex(params.launchId),
      governor_pub_key_hash: toHex(params.governorPubKeyHash),
      challenged_voter_key: toHex(params.challengedVoterKey),
      challenged_proposal_id: toHex(params.challengedProposalId),
      challenger_key_hash: challengerKeyHash,
      bond_amount: params.bondAmountLovelace,
      submitted_at: submittedAt,
      evidence_hash: toHex(params.evidenceHash),
      treasury_pub_key_hash: toHex(params.treasuryPubKeyHash),
      ops_pub_key_hash: toHex(params.opsPubKeyHash),
    };

    const tx = await lucid
      .newTx()
      // The mint handler binds `submitted_at` to real chain time: it requires
      // the declared timestamp to fall inside this range AND the range to be
      // no wider than the validator's own maximum.
      .validFrom(Number(submittedAt) - VALIDITY_HALF_WIDTH_MS)
      .validTo(Number(submittedAt) + VALIDITY_HALF_WIDTH_MS)
      .mintAssets(
        { [this.challengeUnit]: 1n },
        Data.to(new Constr(CTO_SYBIL_MINT_REDEEMER.OpenChallenge, [submittedAt])),
      )
      .attach.MintingPolicy(this.mintingPolicy)
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<CtoSybilChallengeDatumData>(datum, CtoSybilChallengeDatumSchema),
        },
        // The token has to land ON the challenge output, not in the
        // challenger's wallet — `spend` looks for it on the input it settles.
        // The lovelace must equal `bond_amount` exactly; the mint handler
        // checks that too, so an overfunded deposit is refused rather than
        // silently unaccounted.
        { lovelace: params.bondAmountLovelace, [this.challengeUnit]: 1n },
      )
      .addSigner(challengerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /**
   * Governor-initiated resolution. Pays out per the Upheld/Rejected split
   * the validator itself enforces — see cto_sybil_challenge.ak's
   * ResolveChallenge and{} block, mirrored exactly here since the
   * validator checks the real output values, not a claim.
   */
  async resolveChallenge(params: ResolveChallengeParams): Promise<{ txHash: string }> {
    if (!this.config.governorPrivateKey) {
      throw new Error('resolveChallenge requires governorPrivateKey in the submitter config.');
    }
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromPrivateKey(this.config.governorPrivateKey);

    const challengeUtxo = await this.findChallengeUtxo(lucid, params.challengedVoterKey, params.challengedProposalId);
    const datum = Data.from<CtoSybilChallengeDatumData>(this.requireDatum(challengeUtxo), CtoSybilChallengeDatumSchema);

    const redeemer: ResolveChallengeRedeemerData = {
      upheld: params.upheld,
      current_timestamp: params.currentTimestamp,
    };

    // The validator binds current_timestamp through
    // interval.contains(validity_range, ...), so a resolve transaction
    // without a range is refused outright.
    const resolveValidFrom = Number(params.currentTimestamp) - VALIDITY_HALF_WIDTH_MS;
    const resolveValidTo = Number(params.currentTimestamp) + VALIDITY_HALF_WIDTH_MS;

    let txBuilder = lucid
      .newTx()
      .validFrom(resolveValidFrom)
      .validTo(resolveValidTo)
      .collectFrom([challengeUtxo], Data.to<ResolveChallengeRedeemerData>(redeemer, ResolveChallengeRedeemerSchema))
      .attach.SpendingValidator(this.validator)
      // Burning is required by `spend`, not merely tidy: it checks for a -1 of
      // this token in the same transaction. That is what stops a resolved
      // challenge's token being carried into a later forged one — the token,
      // not the datum, is what makes a challenge real.
      .mintAssets({ [this.challengeUnit]: -1n }, Data.to(new Constr(CTO_SYBIL_MINT_REDEEMER.CloseChallenge, [])))
      .attach.MintingPolicy(this.mintingPolicy);

    if (params.upheld) {
      const challengerAddress = credentialToAddress(this.config.network, {
        type: 'Key',
        hash: datum.challenger_key_hash,
      });
      txBuilder = txBuilder.pay.ToAddress(challengerAddress, {
        lovelace: datum.bond_amount,
      });
    } else {
      const treasuryShare = (datum.bond_amount * 60n) / 100n;
      const opsShare = datum.bond_amount - treasuryShare;
      const treasuryAddress = credentialToAddress(this.config.network, {
        type: 'Key',
        hash: datum.treasury_pub_key_hash,
      });
      const opsAddress = credentialToAddress(this.config.network, {
        type: 'Key',
        hash: datum.ops_pub_key_hash,
      });
      txBuilder = txBuilder.pay
        .ToAddress(treasuryAddress, { lovelace: treasuryShare })
        .pay.ToAddress(opsAddress, { lovelace: opsShare });
    }

    const tx = await txBuilder.addSigner(datum.governor_pub_key_hash).complete();
    const signed = await tx.sign.withPrivateKey(this.config.governorPrivateKey).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { toHex };
