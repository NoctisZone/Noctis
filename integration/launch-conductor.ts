// ============================================================================
// Noctis Zone — what a launch is owed right now
// ============================================================================
// Every phase change in a DarkVeil launch used to be a person running a script
// from a workstation. This is the decision that replaces them: given a read of
// the chain and the clock, what is due and not yet done.
//
// PURE, AND THAT IS THE WHOLE DESIGN. It takes a snapshot and a time and
// returns an action; it reads nothing, submits nothing, and remembers nothing
// between calls. Everything it needs is either sealed in the contract at
// deploy or already on chain, so two ticks that see the same chain reach the
// same answer — which is what lets a tick crash, double-fire, or run beside
// another one without a reconciliation step. The chain is the state store.
// There is no local job state to get out of sync with it.
//
// This is the shape the polled batchers already use and the reason they
// self-heal: a fill that fails leaves the order on chain, so the next tick
// reads it and tries again. The lifecycle sequences had nothing equivalent —
// no durable step state, no classification, recovery written only as prose in
// comments — and a launch stuck mid-settlement leaves real bonds unrefunded.
//
// WHY IT IS SAFE TO ACT WITHOUT CHECKING FIRST. Every circuit named here
// either refuses a second submission or is deliberately idempotent, proven by
// a test that drives each one twice. So the conductor never has to ask "did my
// last attempt land" — it re-derives from the chain and submits, and a call
// that already happened is refused harmlessly. Read that suite before adding
// an action here; an action whose circuit does neither would make blind retry
// unsafe for the whole loop, not just for itself.
//
// WHAT THIS DELIBERATELY DOES NOT DECIDE. Anything needing knowledge the chain
// does not hold stays out: the registrant root has to be computed from the
// registrant set, and settlements have to be attested from Cardano. Those are
// surfaced as actions with `needsOffChainInput`, so the loop can tell "nobody
// has done this yet" from "I can do this myself".
// ============================================================================

import { DarkVeilState, LaunchPhase } from '../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import type { DarkVeilSnapshot } from './midnight-public-state.js';

/** Everything the conductor may decide to do, in lifecycle order. */
export type ConductorActionKind =
  | 'advanceToDarkVeil'
  | 'startRegistration'
  | 'publishRegistrantRoot'
  | 'openBuying'
  | 'closeDarkVeil'
  | 'recordSettlements'
  | 'finalizeDvSettlement'
  | 'expireDarkVeil'
  | 'expireDvSettlement';

export interface ConductorAction {
  kind: ConductorActionKind;
  /** Why this one, in a line a log can carry without this file. */
  because: string;
  /**
   * True when the action cannot be built from chain state alone.
   *
   * Two of them need something only the platform can produce: a Merkle root
   * over the registrant set, and an attestation of what settled on Cardano. A
   * loop that cannot supply those should surface the action rather than
   * silently treat the launch as up to date — a launch waiting on one of
   * these looks identical, from the chain, to one that is simply early.
   */
  needsOffChainInput?: boolean;
  /**
   * The per-registrant allocation `closeDarkVeil` must be given.
   *
   * Computed here rather than chosen, because the circuit admits exactly one
   * value: two bounds that together leave a single integer. Supplying any
   * other is refused, so this is a derivation and not a decision — which is
   * precisely what makes the close safe to open to anyone.
   */
  baseSlot?: bigint;
}

export type ConductorVerdict =
  | { status: 'due'; action: ConductorAction }
  | { status: 'waiting'; until: bigint; because: string }
  | { status: 'idle'; because: string };

/**
 * The largest per-registrant allocation that fits.
 *
 * `floor(dvAllocation / registrationCount)`, which is the only value
 * `closeDarkVeil` accepts. Returns 0 for no registrants — a launch with none
 * never reaches the close at all, because it cannot clear the participant
 * floor, so the division is guarded rather than reasoned about.
 */
export function baseSlotFor(dvAllocation: bigint, registrationCount: bigint): bigint {
  if (registrationCount <= 0n) return 0n;
  return dvAllocation / registrationCount;
}

const ZERO_ROOT = '00'.repeat(32);

/**
 * Advancing the launch into its DarkVeil phase, which everything else needs.
 *
 * Two separate fields carry a launch's position — `phase` is the launch's own
 * lifecycle and `dvState` is DarkVeil's sub-phase within it — and they gate
 * different circuits. `startRegistration` reads only `dvState`, so it succeeds
 * while `phase` is still Pending and leaves a launch whose registration window
 * is open and whose every registration is refused, because
 * `registerForDarkVeil` reads `phase`. Publishing an allowlist root reads
 * `phase` too, and a registrant cannot prove membership in a root nobody could
 * publish.
 *
 * So this is owed as soon as the launch is in Pending, with no clock of its
 * own: it starts nothing, opens nothing to anyone, and is the precondition of
 * the two things that must both be in place before the window arrives. Holding
 * it back until the window can only cost the window.
 */
function advanceToDarkVeil(because: string): ConductorVerdict {
  return { status: 'due', action: { kind: 'advanceToDarkVeil', because } };
}

function isPublished(rootHex: string): boolean {
  return rootHex !== '' && rootHex !== ZERO_ROOT;
}

export interface ConductorInput {
  snapshot: DarkVeilSnapshot;
  /** Seconds since the epoch. Midnight's unit — not Cardano's milliseconds. */
  nowSeconds: bigint;
  /**
   * Whether every buyer who revealed has had their Cardano settlement recorded.
   *
   * Supplied rather than derived because the answer lives on the other chain:
   * the gate records what it is told, and only the relayer knows whether it has
   * been told everything. Left undefined, the conductor will not finalize —
   * refusing to close a record it cannot confirm is complete, which is the
   * direction that cannot strand a registrant.
   */
  settlementsComplete?: boolean;
}

/**
 * The one thing this launch is owed, or nothing.
 *
 * Returns a single action rather than a list on purpose: the lifecycle is a
 * sequence, each step changes what the next read will say, and a loop that
 * tried to batch them would be deciding against state that no longer exists by
 * the time the second one runs.
 */
export function nextAction(input: ConductorInput): ConductorVerdict {
  const { snapshot: s, nowSeconds: now } = input;
  const sched = s.schedule;

  // Terminal first. A failed or cancelled launch has its own refund path and
  // nothing here should push it further along.
  if (s.dvFailed) {
    return { status: 'idle', because: 'DarkVeil has failed; every bond returns through the refund path.' };
  }
  if (s.phase === LaunchPhase.Cancelled) {
    return { status: 'idle', because: 'The launch is cancelled.' };
  }

  switch (s.dvState) {
    case DarkVeilState.Inactive:
      if (s.phase === LaunchPhase.Pending) {
        return advanceToDarkVeil(
          'the launch is still in its Pending phase, so nobody could register or be allowlisted',
        );
      }
      if (now > sched.registrationOpenTime) {
        return {
          status: 'due',
          action: {
            kind: 'startRegistration',
            because: `registration opened at ${sched.registrationOpenTime} and the phase is still inactive`,
          },
        };
      }
      return {
        status: 'waiting',
        until: sched.registrationOpenTime,
        because: 'registration has not reached its scheduled open time',
      };

    case DarkVeilState.Registration: {
      // The expiry outranks everything else in this state. A launch that never
      // cleared its floor, or whose root was never published, must reach the
      // refund rather than sit here — and that is the one transition nobody
      // can withhold.
      const expiresAt = sched.registrationCloseTime + sched.darkVeilExpirySeconds;
      if (now > expiresAt) {
        return {
          status: 'due',
          action: {
            kind: 'expireDarkVeil',
            because: `the phase passed its ${expiresAt} deadline without opening buying; every bond returns in full`,
          },
        };
      }

      // After the expiry, deliberately: a launch that has run out of time is
      // owed its refund, not another step forward. Before the rest, equally
      // deliberately: registration is open on the clock and refusing everyone
      // until this lands, so it is the most urgent thing that is not a refund.
      if (s.phase === LaunchPhase.Pending) {
        return advanceToDarkVeil(
          'registration is open but the launch is still in its Pending phase, so every registration is refused',
        );
      }

      if (!isPublished(s.pendingRegistrantRootHex) && now > sched.registrationCloseTime) {
        return {
          status: 'due',
          action: {
            kind: 'publishRegistrantRoot',
            // Not derivable here: the root commits to the registrant set, and
            // only whoever can enumerate that set off chain can compute it.
            needsOffChainInput: true,
            because: `registration closed at ${sched.registrationCloseTime} and no registrant root is published`,
          },
        };
      }

      if (now > sched.buyingOpenTime) {
        if (s.registrationCount < sched.minDvParticipants) {
          // Deliberately not an action. The floor is not something to work
          // around; a launch that never reaches it is supposed to expire into
          // a full refund, and the deadline above is what gets it there.
          return {
            status: 'waiting',
            until: expiresAt,
            because:
              `only ${s.registrationCount} of the ${sched.minDvParticipants} registrants required, so buying cannot ` +
              'open; this launch is heading for its expiry and a full refund',
          };
        }
        if (!isPublished(s.pendingRegistrantRootHex)) {
          return {
            status: 'due',
            action: {
              kind: 'publishRegistrantRoot',
              needsOffChainInput: true,
              because: 'buying is due to open but no registrant root is published',
            },
          };
        }
        return {
          status: 'due',
          action: {
            kind: 'openBuying',
            because: `buying opened at ${sched.buyingOpenTime}, the root is published and the floor is met`,
          },
        };
      }

      return {
        status: 'waiting',
        until: sched.buyingOpenTime,
        because: 'registration is open and buying has not reached its scheduled time',
      };
    }

    case DarkVeilState.Buying:
      if (now > sched.buyingCloseTime) {
        return {
          status: 'due',
          action: {
            kind: 'closeDarkVeil',
            baseSlot: baseSlotFor(s.dvAllocation, s.registrationCount),
            because: `buying closed at ${sched.buyingCloseTime}`,
          },
        };
      }
      return {
        status: 'waiting',
        until: sched.buyingCloseTime,
        because: 'buying is open and has not reached its scheduled close',
      };

    case DarkVeilState.Closed: {
      if (s.settlementFinalized) {
        return {
          status: 'idle',
          because: 'the settlement record is closed; the rest of the launch settles on the other chain',
        };
      }

      // The hatch again, and it outranks finalizing for the same reason the
      // registration expiry does: a record nobody ever closed must still reach
      // a refund without anyone's permission.
      const settlementExpiresAt = sched.buyingCloseTime + sched.settlementDeadlineSeconds;
      if (now > settlementExpiresAt) {
        return {
          status: 'due',
          action: {
            kind: 'expireDvSettlement',
            because: `the settlement record passed its ${settlementExpiresAt} deadline while still open`,
          },
        };
      }

      if (input.settlementsComplete === true) {
        return {
          status: 'due',
          action: {
            kind: 'finalizeDvSettlement',
            because: 'every reveal has a recorded settlement, so the certificate figures are final',
          },
        };
      }

      return {
        status: 'due',
        action: {
          kind: 'recordSettlements',
          // The gate records what it is told about Cardano; it cannot look.
          needsOffChainInput: true,
          because:
            input.settlementsComplete === undefined
              ? 'whether every settlement is recorded is unknown, and the record must not be closed until it is'
              : 'settlements are still outstanding',
        },
      };
    }

    default:
      return { status: 'idle', because: `nothing is owed in dvState ${s.dvState}` };
  }
}
