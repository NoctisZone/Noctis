// ============================================================================
// Noctis Zone — who holds the secret behind each sealed identity
// ============================================================================
// A launch's identity slots take a public key, and a public key is a hash, so
// any 32 bytes of the right length satisfy every structural check there is:
// right length, non-zero, three distinct values, reproducible. A gate can be
// deployed cleanly, report success, and be inert — because the circuit that
// reads one of those slots compares it against a value derived from a secret,
// and no secret derives to an arbitrary hash.
//
// The check that catches that is not about the value. It is "can somebody
// produce a witness that derives to this", and the only way to answer it is to
// say who holds the secret and then show that they do. This module is that
// answer, made into a thing a deploy carries rather than a thing somebody
// remembered to think about.
//
// THREE KINDS OF SLOT, and they are checked differently on purpose:
//
//   platform-held  the secret is supplied here, so the claim is PROVEN — the
//                  key is re-derived and must match what is about to be
//                  sealed. Nothing is taken on trust.
//
//   external       a separate party derived their own key and handed over only
//                  the key. Nothing here can verify it, and saying so is the
//                  point: that unverifiability is exactly what the separation
//                  buys and what it costs. It is recorded as unproven rather
//                  than passing quietly as though it had been checked.
//
//   receive-only   an address that only ever receives. It presents no witness
//                  and satisfies no circuit, so there is no derivation to
//                  check — only a holder to name, because a forfeited bond
//                  paid to an address nobody controls is gone.
//
// WHAT A THRESHOLD IS WORTH IS A FACT ABOUT ITS HOLDERS, and this records it
// rather than implying it. Three keys held by one operator make a real
// key-compromise control — no single leaked key publishes an allowlist root,
// and losing one costs nothing. They do not make separation of duties, and a
// manifest that says so is worth more than a threshold that quietly reads as
// something it is not.
//
// AN ATTESTOR SECRET THAT IS THE GOVERNOR SECRET IS THE GOVERNOR. Both derive
// under the same domain, so the two keys are the same bytes. The sealed keys
// stay distinct, every structural check passes, and one of the three attestors
// is simply the governor wearing a different name. Refused here, because
// nothing downstream can see it.
// ============================================================================

import { DOMAINS, deriveRoleKey } from '../contracts/midnight/witnesses.js';

export type CustodyKind = 'platform-held' | 'external' | 'receive-only';

export interface CustodyRecord {
  kind: CustodyKind;
  /**
   * Who holds the secret — a name somebody could actually be asked for it by.
   *
   * The failure this guards is not a wrong name. It is an unanswered one: a
   * slot filled in because the form needed filling, which is the same thing as
   * a key nobody holds, written in words instead of bytes.
   */
  holder: string;
  /** Where it is kept, in a phrase. Recorded, not checked. */
  storedAs?: string;
}

/** Every identity a Cardano Launch gate seals at deploy. */
export interface IdentityCustody {
  governor: CustodyRecord;
  attestors: [CustodyRecord, CustodyRecord, CustodyRecord];
  creator: CustodyRecord;
  platformAddr: CustodyRecord;
}

/** The sealed values a custody manifest has to account for. */
export interface SealedIdentities {
  governorKey: Uint8Array;
  attestorKeys: [Uint8Array, Uint8Array, Uint8Array];
  creatorPubKey: Uint8Array;
  platformAddr: Uint8Array;
}

/** Secrets the platform says it holds, for the slots it claims. */
export interface HeldSecrets {
  governorSecret?: Uint8Array;
  attestorSecrets?: [Uint8Array, Uint8Array, Uint8Array];
}

export interface CustodyFinding {
  slot: string;
  detail: string;
}

export interface CustodyVerdict {
  /** Anything that must be fixed before a deploy. */
  refusals: CustodyFinding[];
  /** Slots nothing here could verify, named so they are read rather than assumed. */
  unproven: CustodyFinding[];
  /** How many attestor keys are held by parties other than the platform. */
  independentAttestors: number;
  /** One line per slot, for the deploy record. */
  manifest: string[];
}

/**
 * Names that mean the question was not answered.
 *
 * Deliberately short, and deliberately about UNANSWERED rather than
 * PROVISIONAL: "rehearsal operator" is a real holder for a rehearsal and must
 * pass, while "TBD" is the form being filled in so it would submit.
 */
const UNANSWERED = new Set(['', '-', '?', 'n/a', 'na', 'none', 'tbd', 'todo', 'unassigned', 'placeholder', 'unknown']);

function holderIsAnswered(holder: string): boolean {
  return !UNANSWERED.has(holder.trim().toLowerCase());
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const short = (bytes: Uint8Array): string =>
  Array.from(bytes.slice(0, 6))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * Whether every sealed identity has a holder, and whether each claim is proven.
 *
 * Returns rather than throws, so a caller can print the whole picture instead
 * of the first thing wrong with it — a deploy blocked one field at a time is
 * how a provisioning session turns into an afternoon.
 */
export function checkIdentityCustody(
  custody: IdentityCustody,
  sealed: SealedIdentities,
  held: HeldSecrets = {},
): CustodyVerdict {
  const refusals: CustodyFinding[] = [];
  const unproven: CustodyFinding[] = [];
  const manifest: string[] = [];

  const check = (
    slot: string,
    record: CustodyRecord,
    sealedValue: Uint8Array,
    derive?: () => Uint8Array | undefined,
  ) => {
    if (!holderIsAnswered(record.holder)) {
      refusals.push({
        slot,
        detail:
          `no holder is named (got ${JSON.stringify(record.holder)}). This value is sealed at deploy, and a ` +
          'slot nobody holds cannot be corrected afterwards.',
      });
    }

    if (record.kind === 'platform-held') {
      const derived = derive?.();
      if (!derived) {
        refusals.push({
          slot,
          detail:
            'is claimed as platform-held but no secret was supplied for it, so the claim is the only evidence ' +
            'that anybody can satisfy the circuit that reads it.',
        });
      } else if (!sameBytes(derived, sealedValue)) {
        refusals.push({
          slot,
          detail:
            `is claimed as platform-held but the secret supplied derives to ${short(derived)}…, not the ` +
            `${short(sealedValue)}… about to be sealed. One of the two is not what it is said to be.`,
        });
      }
    } else if (record.kind === 'external') {
      unproven.push({
        slot,
        detail: `is held by ${record.holder}, who derived it themselves. Nothing here can check that they did.`,
      });
    }

    manifest.push(
      `${slot.padEnd(14)} ${record.kind.padEnd(13)} ${record.holder}` +
        (record.storedAs ? ` — ${record.storedAs}` : '') +
        `  [${short(sealedValue)}…]`,
    );
  };

  // `receive-only` describes an address that satisfies no circuit. Anywhere
  // else it would be a slot excused from the one check that matters.
  for (const [slot, record] of [
    ['governor', custody.governor],
    ['attestor-1', custody.attestors[0]],
    ['attestor-2', custody.attestors[1]],
    ['attestor-3', custody.attestors[2]],
    ['creator', custody.creator],
  ] as const) {
    if (record.kind === 'receive-only') {
      refusals.push({
        slot,
        detail: 'is receive-only, but a circuit reads it — something has to be able to present a witness for it.',
      });
    }
  }

  check('governor', custody.governor, sealed.governorKey, () =>
    held.governorSecret ? deriveRoleKey({ bytes: held.governorSecret }, DOMAINS.ELIGIBILITY_GOVERNOR).bytes : undefined,
  );

  custody.attestors.forEach((record, i) => {
    check(`attestor-${i + 1}`, record, sealed.attestorKeys[i], () => {
      const secret = held.attestorSecrets?.[i];
      return secret ? deriveRoleKey({ bytes: secret }, DOMAINS.ELIGIBILITY_GOVERNOR).bytes : undefined;
    });
  });

  // The creator derives their own, under a launch-scoped domain this module
  // cannot reproduce without their secret — so there is nothing to prove here
  // and the holder is the whole check.
  check('creator', custody.creator, sealed.creatorPubKey);

  // The payout address answers a different question from the rest, so it is
  // asked a different one. No circuit derives it, so there is nothing to
  // prove and no secret anyone could have supplied — running the derivation
  // check here would refuse it for a reason that cannot apply, and bury the
  // one that does.
  if (custody.platformAddr.kind === 'platform-held') {
    refusals.push({
      slot: 'platformAddr',
      detail:
        'is claimed as platform-held, but it is an address rather than a key: no circuit derives it, so there ' +
        'is nothing to prove. Say receive-only, which is what it is.',
    });
  }
  check(
    'platformAddr',
    custody.platformAddr.kind === 'platform-held'
      ? { ...custody.platformAddr, kind: 'receive-only' }
      : custody.platformAddr,
    sealed.platformAddr,
  );

  // An attestor secret that IS the governor secret derives to the governor's
  // own key — same domain, same bytes — so the sealed keys stay distinct while
  // one of the three attestors is the governor under another name. Nothing
  // downstream can see this, which is why it is refused here.
  if (held.governorSecret && held.attestorSecrets) {
    held.attestorSecrets.forEach((secret, i) => {
      if (sameBytes(secret, held.governorSecret as Uint8Array)) {
        refusals.push({
          slot: `attestor-${i + 1}`,
          detail:
            'is the governor secret. Both derive under the same domain, so this attestor and the governor are ' +
            'the same key wearing two names, and the threshold is one party short of what it says.',
        });
      }
    });

    // Distinct secrets, checked here as well as on chain so a repeat costs a
    // validation error rather than a transaction. Identical secrets make an
    // approval count that can never reach its threshold, because approvals are
    // recorded by attestor rather than by call.
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        if (sameBytes(held.attestorSecrets[i], held.attestorSecrets[j])) {
          refusals.push({
            slot: `attestor-${j + 1}`,
            detail: `is the same secret as attestor-${i + 1}, so the three slots hold two attestors.`,
          });
        }
      }
    }
  }

  const independentAttestors = custody.attestors.filter((r) => r.kind === 'external').length;

  return { refusals, unproven, independentAttestors, manifest };
}

/**
 * What a threshold is actually worth, given who holds the keys behind it.
 *
 * Stated rather than implied, and never a refusal: an arrangement where one
 * operator holds all three is a deliberate choice with a real benefit, and the
 * thing worth guarding against is not that choice but its being read later as
 * a guarantee it never made.
 */
export function describeThreshold(threshold: number, independentAttestors: number): string {
  if (independentAttestors === 0) {
    return (
      `${threshold} of 3, all three held by the platform. No single leaked key can publish an allowlist ` +
      `root, and losing any one costs nothing while ${threshold} remain. This is a key-compromise control, ` +
      'not separation of duties — one operator can still act alone.'
    );
  }
  if (independentAttestors >= 3 - threshold + 1) {
    return (
      `${threshold} of 3, with ${independentAttestors} held outside the platform. The platform cannot publish ` +
      'an allowlist root alone.'
    );
  }
  return (
    `${threshold} of 3, with ${independentAttestors} held outside the platform — but the platform holds ` +
    `${3 - independentAttestors}, which is enough on its own. The outside holders can join a threshold; they ` +
    'cannot withhold one.'
  );
}

/** The verdict as lines for a deploy record or an operator's screen. */
export function formatCustodyVerdict(verdict: CustodyVerdict, threshold: number): string[] {
  const lines = ['Identity custody', ...verdict.manifest.map((l) => `  ${l}`)];
  lines.push(`  threshold      ${describeThreshold(threshold, verdict.independentAttestors)}`);
  if (verdict.unproven.length > 0) {
    lines.push('  not verifiable here:');
    for (const f of verdict.unproven) lines.push(`    ${f.slot}: ${f.detail}`);
  }
  if (verdict.refusals.length > 0) {
    lines.push('  REFUSED:');
    for (const f of verdict.refusals) lines.push(`    ${f.slot}: ${f.detail}`);
  }
  return lines;
}
