// ============================================================================
// Noctis Zone — turning a planned transition into the call that performs it
// ============================================================================
// The planner says what a launch is owed. This says how to ask for it: which
// action of darkveil-action.ts, with which arguments, presenting which secret.
// It is pure, so the mapping and the refusals in it can be tested without a
// chain, a wallet or a proof server — which is the only way the checks below
// get exercised more than once a launch.
//
// THIS IS WHERE THE PHASE DRIVERS' KNOWLEDGE ENDED UP. They were two scripts
// that each walked a fixed sequence of calls with the arithmetic and the
// preconditions written inline, and the sequence is now the planner's while
// the call shapes are here. The checks they carried came with them, because
// they were the valuable part:
//
//   THE ROOT MUST COMMIT TO THE SET THAT BONDED. Publishing a registrant root
//   freezes who is in the phase. A root built from a roster that has fallen
//   behind the chain freezes the wrong set, permanently, and nothing later
//   reports it — the launch simply proceeds with somebody missing. So the root
//   is supplied with the count it was built over, and it is refused unless
//   that count is the chain's own.
//
//   A SETTLEMENT RECORD IS NOT CLOSED ON SOMEBODY ELSE'S ASSURANCE. The
//   relayer is the only party that can say it has seen every Cardano claim,
//   and its say-so is necessary rather than sufficient: a buyer who revealed
//   on Midnight and appears nowhere in the attestation would be recorded as
//   having settled nothing, and the forfeiture sweep would then take their
//   whole bond. So the chain's own list of revealers is checked against the
//   attestation before the record is treated as complete.
//
// WHAT IS DELIBERATELY NOT HERE. Registrant-side calls — registering, buy
// commitments, reveals, refund claims — have no mapping in this file and
// should not acquire one. They are made by participants from their own seeds,
// and a conductor that could make them on their behalf would be a conductor
// holding fifteen people's identities.
// ============================================================================

import type { ConductorAction, ConductorActionKind } from './launch-conductor.js';
import type { DarkVeilSnapshot } from './midnight-public-state.js';

/** A registrant root, with the set size it was built over. */
export interface RegistrantRootInput {
  rootHex: string;
  /**
   * How many registrants the root commits to.
   *
   * Carried with the root rather than trusted alongside it: this is the whole
   * check. A root and a count that disagree with the chain mean the tree was
   * built before the set stopped growing.
   */
  registrantCount: string | number | bigint;
}

/** One buyer's Cardano settlement, as the relayer observed it. */
export interface SettlementEntry {
  buyerKeyHex: string;
  /** Tokens that really settled. Decimal string; zero is a real observation. */
  settledAmount: string;
}

export interface SettlementAttestation {
  entries: SettlementEntry[];
  /**
   * Whether the relayer asserts it has observed every Cardano claim.
   *
   * Necessary and not sufficient — see the header. Absent means it has not
   * said so, which the planner reads as not complete.
   */
  complete: boolean;
}

/** Everything the platform supplies that the chain does not hold. */
export interface OffChainInputs {
  registrantRoot?: RegistrantRootInput;
  settlements?: SettlementAttestation;
}

export interface CallContext {
  snapshot: DarkVeilSnapshot;
  offChain: OffChainInputs;
  /**
   * Buyers who revealed, as the chain has them — `dvTokensPurchased`.
   *
   * Keys are lower-case hex. Used only to check the attestation covers
   * everyone; the amounts a settlement records come from Cardano, not here.
   */
  revealedKeys?: readonly string[];
  /**
   * Settlements already recorded, as the chain has them — `settledDvPurchases`.
   *
   * Keyed by lower-case hex, valued by the recorded amount as a decimal
   * string. Present-with-zero is distinct from absent: the first is a buyer
   * observed to have claimed nothing, the second is a buyer nobody has looked
   * at, and the forfeiture rule treats them differently.
   */
  recordedSettlements?: Readonly<Record<string, string>>;
}

/** One call of darkveil-action.ts, ready for the connection fields to be added. */
export interface PlannedCall {
  /** The CLI's own action name. */
  action: string;
  /** Arguments beyond the connection base. */
  args: Record<string, string>;
  /**
   * Whether this call must present the governor secret.
   *
   * The phase transitions run on the sealed schedule and consult no key, so
   * they are false here even though a run still needs a funded wallet to pay
   * the fee. Saying which calls genuinely need the secret is what lets a run
   * be given one only where one is required.
   */
  needsGovernorSecret: boolean;
}

export type CallPlan = { ok: true; call: PlannedCall } | { ok: false; missing: string };

const lower = (hex: string): string => hex.toLowerCase();

/**
 * The CLI action each transition is performed by.
 *
 * Exported so a test can assert every planner action has a mapping — the way
 * an action acquires no way of being performed is by being added to one list
 * and not the other.
 */
export const CLI_ACTION_FOR: Readonly<Record<ConductorActionKind, string>> = {
  advanceToDarkVeil: 'advance-phase',
  startRegistration: 'start-registration',
  publishRegistrantRoot: 'publish-registrant-root',
  openBuying: 'open-buying',
  closeDarkVeil: 'close',
  recordSettlements: 'record-settlement',
  finalizeDvSettlement: 'finalize-settlement',
  expireDarkVeil: 'expire-darkveil',
  expireDvSettlement: 'expire-dv-settlement',
};

/** The transitions the governor's own key must make. */
const GOVERNOR_ACTIONS: ReadonlySet<ConductorActionKind> = new Set([
  'advanceToDarkVeil',
  'publishRegistrantRoot',
  'recordSettlements',
  'finalizeDvSettlement',
]);

/**
 * The call that performs a planned transition, or what is missing.
 *
 * Returns rather than throws: a missing registrant root is a state to report
 * and tick again from — somebody has to build one — not a fault in the run.
 */
export function planCall(action: ConductorAction, ctx: CallContext): CallPlan {
  const cliAction = CLI_ACTION_FOR[action.kind];
  const needsGovernorSecret = GOVERNOR_ACTIONS.has(action.kind);

  switch (action.kind) {
    case 'advanceToDarkVeil':
      // The CLI names phases by their string, and this is the only one the
      // conductor ever advances to — the transitions after DarkVeil belong to
      // the Cardano side of the launch.
      return { ok: true, call: { action: cliAction, args: { phase: 'DarkVeil' }, needsGovernorSecret } };

    case 'startRegistration':
    case 'openBuying':
    case 'finalizeDvSettlement':
    case 'expireDarkVeil':
    case 'expireDvSettlement':
      return { ok: true, call: { action: cliAction, args: {}, needsGovernorSecret } };

    case 'closeDarkVeil': {
      // The planner derives this, and it is the divisor every ratio refund is
      // measured against for the rest of the launch. A close that carried no
      // value would be a close that chose one.
      if (action.baseSlot === undefined) {
        return { ok: false, missing: 'the per-registrant allocation the close must be given' };
      }
      return {
        ok: true,
        call: { action: cliAction, args: { baseSlot: action.baseSlot.toString() }, needsGovernorSecret },
      };
    }

    case 'publishRegistrantRoot': {
      const root = ctx.offChain.registrantRoot;
      if (!root) {
        return {
          ok: false,
          missing:
            'a registrant root built over the set the chain holds. It commits to who is in the phase, ' +
            'and only whoever can enumerate that set off chain can compute it.',
        };
      }
      if (!/^[0-9a-fA-F]{64}$/.test(root.rootHex)) {
        return { ok: false, missing: `a 32-byte registrant root; got ${JSON.stringify(root.rootHex)}` };
      }
      const built = BigInt(root.registrantCount);
      const onChain = ctx.snapshot.registrationCount;
      if (built !== onChain) {
        return {
          ok: false,
          missing:
            `a registrant root built over all ${onChain} registrants — this one commits to ${built}. ` +
            'Publishing it would freeze a set that is not the set that bonded, for the life of the launch.',
        };
      }
      return {
        ok: true,
        call: { action: cliAction, args: { registrantRootHex: lower(root.rootHex) }, needsGovernorSecret },
      };
    }

    case 'recordSettlements': {
      const attestation = ctx.offChain.settlements;
      if (!attestation) {
        return {
          ok: false,
          missing:
            'an attestation of what settled on Cardano. The gate records what it is told about the other ' +
            'chain; it cannot look.',
        };
      }
      const next = nextOutstandingSettlement(attestation, ctx.recordedSettlements ?? {});
      if (!next) {
        return {
          ok: false,
          missing:
            'a settlement that is not already recorded. Every entry in the attestation is on chain with ' +
            'the amount it names, so there is nothing left for this call to carry.',
        };
      }
      return {
        ok: true,
        call: {
          action: cliAction,
          args: { buyerKeyHex: lower(next.buyerKeyHex), settledAmount: next.settledAmount },
          needsGovernorSecret,
        },
      };
    }
  }
}

/**
 * The first attested settlement the chain does not already hold, or none.
 *
 * A DIFFERING amount counts as outstanding, not just an absent one. Recording
 * replaces rather than accumulates — the circuit subtracts the previous figure
 * before adding the new — so a corrected observation is meant to be recorded
 * again, and treating "present" as "done" would leave the wrong figure in the
 * certificate permanently.
 *
 * One at a time, because a tick is one action: the next tick re-reads and
 * takes the next. That costs a read per settlement and buys the property that
 * a run which dies halfway through resumes from the chain rather than from a
 * local note of where it had got to.
 */
export function nextOutstandingSettlement(
  attestation: SettlementAttestation,
  recorded: Readonly<Record<string, string>>,
): SettlementEntry | null {
  for (const entry of attestation.entries) {
    const already = recorded[lower(entry.buyerKeyHex)];
    if (already === undefined || already !== entry.settledAmount) return entry;
  }
  return null;
}

export type CompletenessVerdict =
  | { complete: true }
  | { complete: false; why: string }
  | { complete: 'unknown'; why: string };

/**
 * Whether the settlement record may be closed.
 *
 * Three answers rather than two, and the third is the point. "Unknown" is what
 * an absent attestation means, and the planner treats it as not complete —
 * because the direction that strands somebody is the one where a record is
 * closed early. A buyer who revealed on Midnight and was never recorded is
 * indistinguishable, afterwards, from one who settled nothing, and the
 * forfeiture sweep then takes their whole bond.
 *
 * So the relayer's assurance is checked against the chain rather than taken:
 * every entry it names must really be on chain with the amount it names, and
 * every buyer the chain shows as having revealed must appear in it.
 */
export function settlementCompleteness(ctx: CallContext): CompletenessVerdict {
  const attestation = ctx.offChain.settlements;
  if (!attestation) {
    return { complete: 'unknown', why: 'no settlement attestation has been supplied' };
  }
  if (!attestation.complete) {
    return { complete: false, why: 'the attestation does not claim to cover every Cardano claim yet' };
  }

  const recorded = ctx.recordedSettlements ?? {};
  const outstanding = nextOutstandingSettlement(attestation, recorded);
  if (outstanding) {
    return { complete: false, why: `${lower(outstanding.buyerKeyHex).slice(0, 12)}… is attested but not yet recorded` };
  }

  if (ctx.revealedKeys === undefined) {
    return {
      complete: 'unknown',
      why: 'the chain’s own list of revealed buyers was not read, so the attestation cannot be checked for gaps',
    };
  }
  const attested = new Set(attestation.entries.map((e) => lower(e.buyerKeyHex)));
  const missing = ctx.revealedKeys.map(lower).filter((key) => !attested.has(key));
  if (missing.length > 0) {
    return {
      complete: false,
      why:
        `${missing.length} buyer(s) revealed on chain and appear in no attestation — ` +
        `${missing[0].slice(0, 12)}… among them. Closing the record now would record them as having settled ` +
        'nothing, and the forfeiture sweep takes the whole bond of a registrant who settled nothing.',
    };
  }

  return { complete: true };
}
