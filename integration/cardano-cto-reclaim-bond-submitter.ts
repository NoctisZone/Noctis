// ============================================================================
// Noctis Zone — Real Cardano transaction submitter for
// contracts/cardano/validators/cto_governance.ak's ReclaimRelayerBond
// ============================================================================
// Permissionless — the payout destination is fixed by the datum's own
// pending_relayer_key_hash, same "the invariant is the authorization" idiom
// as every other permissionless claim in this codebase. In practice the
// relayer themselves calls this (they're the one collecting their own bond
// back), but nothing on-chain requires that specific caller.
//
// Data encoding reuses cardano-cto-anchor-submitter.ts's exported schemas
// and findCtoGovernanceUtxo/requireCtoDatum helpers.
//
// What IS real here: Data encoding, UTXO lookup, transaction construction,
// and the value-movement/new-datum logic are all built against Lucid
// Evolution's real, installed API.
//
// What is NOT tested: an actual end-to-end submission against a live
// Cardano node. Same honest boundary as every other submitter here.
// ============================================================================

import type { LucidEvolution, Network as LucidNetwork, SpendingValidator } from '@lucid-evolution/lucid';
import { Constr, credentialToAddress, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import {
  type CtoGovernanceDatumData,
  CtoGovernanceDatumSchema,
  findCtoGovernanceUtxo,
  requireCtoDatum,
  toHex,
} from './cardano-cto-anchor-submitter.js';
import { cardanoProvider } from './cardano-provider.js';
import { settlementDatum } from './launch-schemas.js';
import { CTO_GOVERNANCE_REDEEMER } from './redeemer-indices.js';

/**
 * ReclaimRelayerBond, by name — see `redeemer-indices.ts`, whose table a test
 * holds against the compiled blueprint. No fields: a bare Constr with an
 * empty field list.
 */
function reclaimRelayerBondRedeemer() {
  return new Constr(CTO_GOVERNANCE_REDEEMER.ReclaimRelayerBond, []);
}

export interface CardanoCtoReclaimBondSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** cto_governance.ak's compiled PlutusV3 script CBOR. */
  compiledScriptCbor: string;
  /** Pays the fee/collateral only — ReclaimRelayerBond has no validator-checked signer; the payout itself is fixed to the datum's own pending_relayer_key_hash regardless of who submits. */
  callerPrivateKey: string;
  launchId: Uint8Array;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. The governance UTXO is authenticated against it — the datum
   * cannot be allowed to nominate its own authenticator. See
   * launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export class CardanoCtoReclaimBondSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: CardanoCtoReclaimBondSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(cardanoProvider(config), config.network).then((lucid) => {
      lucid.selectWallet.fromPrivateKey(config.callerPrivateKey);
      // Nothing awaits this until a method runs, so a caller that constructs the
      // submitter and then fails before calling one leaves the rejection with no
      // handler — and Node prints it to stderr after the real answer has already
      // been written to stdout. Attaching a no-op handler marks it handled
      // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
      // with the same error, which is the whole point (verified, not assumed).
      this.lucidPromise.catch(() => {});
      return lucid;
    });
  }

  /** Pays the launch's currently-pending relayer bond to its recorded pending_relayer_key_hash — only callable once the anchored proposal has been legitimately Executed or Expired (never reachable if the governor voided it, since VoidPendingProposal already zeroes the bond). */
  async reclaimRelayerBond(): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const anchorUtxo = await findCtoGovernanceUtxo(
      lucid,
      this.scriptAddress,
      this.config.launchId,
      this.config.threadNftPolicyId,
    );
    const currentDatum = Data.from<CtoGovernanceDatumData>(requireCtoDatum(anchorUtxo), CtoGovernanceDatumSchema);

    const proposal = currentDatum.active_proposal;
    if (!proposal) {
      throw new Error("No active_proposal on this launch's cto_governance UTXO — nothing to reclaim against.");
    }
    if (proposal.execution_status !== 'Executed' && proposal.execution_status !== 'Expired') {
      throw new Error(
        `active_proposal.execution_status is '${proposal.execution_status}' — bond can only be reclaimed once it's 'Executed' or 'Expired'.`,
      );
    }
    if (currentDatum.pending_relayer_bond <= 0n) {
      throw new Error('pending_relayer_bond is not positive — nothing to reclaim.');
    }

    const bond = currentDatum.pending_relayer_bond;
    const relayerAddress = credentialToAddress(this.config.network, {
      type: 'Key',
      hash: currentDatum.pending_relayer_key_hash,
    });

    const newDatum: CtoGovernanceDatumData = {
      ...currentDatum,
      pending_relayer_bond: 0n,
      pending_relayer_key_hash: '',
    };

    const continuingAssets = {
      ...anchorUtxo.assets,
      lovelace: (anchorUtxo.assets.lovelace ?? 0n) - bond,
    };

    const tx = await lucid
      .newTx()
      .collectFrom([anchorUtxo], Data.to(reclaimRelayerBondRedeemer()))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<CtoGovernanceDatumData>(newDatum, CtoGovernanceDatumSchema),
        },
        continuingAssets,
      )
      .pay.ToAddressWithData(relayerAddress, { kind: 'inline', value: settlementDatum(anchorUtxo) }, { lovelace: bond })
      .complete();

    const signed = await tx.sign.withPrivateKey(this.config.callerPrivateKey).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { toHex };
