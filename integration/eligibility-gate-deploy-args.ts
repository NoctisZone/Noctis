// ============================================================================
// Noctis Zone — resolve and check the eligibility gate's constructor args
// ============================================================================
// Lifted out of cli/deploy-eligibility-gate.ts so a test can reach it. A CLI
// runs main() on import and cannot be exercised directly, and this is the part
// worth exercising: every check here mirrors an assertion the constructor
// makes, so that a bad deploy fails before it costs a transaction rather than
// after, with an error naming the field rather than the circuit.
//
// One rule is stronger here than on chain. `walletCap` must equal
// `totalSupply * maxWalletPercent / 100`, which the contract documents and
// cannot check, because Compact circuits have no division — it only asserts
// the value is positive. Deriving it here rather than accepting it is the
// difference between a cap that means what it says and one that is whatever
// the caller typed, for the life of the launch.
// ============================================================================

/** 2^44 - 1 — verifyRatioRefund's ceiling, asserted by the constructor. */
export const MAX_BOND_AMOUNT = 17_592_186_044_415n;

/**
 * The native token's colour: 32 zero bytes. Deploying with this makes the bond
 * NIGHT-denominated, which is what the contract did before the bond became
 * asset-agnostic — so it is a legal value, not a rejected one.
 */
export const NATIVE_TOKEN_COLOUR_HEX = '00'.repeat(32);

export interface EligibilityGateDeployInput {
  launchIdHex: string;
  allowlistRootHex: string;
  creatorPubKeyHex: string;
  platformAddrHex: string;
  allowlistAttestorKeysHex: [string, string, string];
  allowlistThreshold: number;
  totalSupply: string | number;
  maxWalletPercent: string | number;
  bondAmount: string | number;
  /**
   * The unshielded colour the bond is posted in, 32 bytes hex. OPTIONAL, and
   * it defaults to the native token so an existing caller keeps its current
   * behaviour rather than silently acquiring a new one.
   */
  bondTokenColourHex?: string;
  dvAllocation: string | number;
  dvPrice: string | number;
  allowlistSize: string | number;
  registrationCloseTime: string | number;
  /**
   * The three DarkVeil window durations, in seconds. Optional, defaulting to
   * CLAUDE.md's own sequence — registration T-48h to T-2h, a 2h freeze, then a
   * 24h buying window — so an existing caller gets the real schedule without
   * naming it. A rehearsal shortens them deliberately.
   */
  registrationWindowSeconds?: string | number;
  freezeWindowSeconds?: string | number;
  buyingWindowSeconds?: string | number;
  minDvParticipants: string | number;
  /** Optional. If given it must equal the derived value. */
  walletCap?: string | number;
}

export interface EligibilityGateDeployArgs {
  launchId: Uint8Array;
  allowlistRoot: Uint8Array;
  totalSupply: bigint;
  maxWalletPercent: bigint;
  bondAmount: bigint;
  bondTokenColour: Uint8Array;
  walletCap: bigint;
  dvAllocation: bigint;
  dvPrice: bigint;
  allowlistSize: bigint;
  registrationCloseTime: bigint;
  registrationWindowSeconds: bigint;
  freezeWindowSeconds: bigint;
  buyingWindowSeconds: bigint;
  minDvParticipants: bigint;
  creatorPubKey: Uint8Array;
  platformAddr: Uint8Array;
  allowlistAttestorKeys: [Uint8Array, Uint8Array, Uint8Array];
  allowlistThreshold: bigint;
}

export function fromHex32(hex: unknown, label: string): Uint8Array {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${label}: expected 64 hex characters (32 bytes), got ${JSON.stringify(hex)}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBigInt(value: string | number, label: string): bigint {
  // BigInt() coerces false, '' and [] to 0n and lets -1 through, so the type
  // is checked before the conversion rather than after.
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${label}: expected a number or a numeric string, got ${JSON.stringify(value)}`);
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`${label}: expected a number, got an empty string`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label}: not an integer, got ${JSON.stringify(value)}`);
  }
  if (parsed < 0n) {
    throw new Error(`${label}: must not be negative, got ${parsed}`);
  }
  return parsed;
}

const isZero = (b: Uint8Array) => b.every((x) => x === 0);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Resolve the 15 constructor arguments, refusing anything the contract would.
 *
 * Returns the args ready to hand to `deployEligibilityGate`, with `walletCap`
 * derived rather than trusted.
 */
export function resolveEligibilityGateDeployArgs(input: EligibilityGateDeployInput): EligibilityGateDeployArgs {
  const launchId = fromHex32(input.launchIdHex, 'launchIdHex');
  const allowlistRoot = fromHex32(input.allowlistRootHex, 'allowlistRootHex');
  const creatorPubKey = fromHex32(input.creatorPubKeyHex, 'creatorPubKeyHex');
  const platformAddr = fromHex32(input.platformAddrHex, 'platformAddrHex');

  if (!Array.isArray(input.allowlistAttestorKeysHex) || input.allowlistAttestorKeysHex.length !== 3) {
    throw new Error('allowlistAttestorKeysHex must be exactly three keys.');
  }
  const attestors = input.allowlistAttestorKeysHex.map((k, i) => fromHex32(k, `allowlistAttestorKeysHex[${i}]`)) as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];

  attestors.forEach((k, i) => {
    if (isZero(k)) {
      throw new Error(
        `allowlistAttestorKeysHex[${i}] cannot be all zero — the contract rejects an empty attestor key.`,
      );
    }
  });
  for (const [i, j] of [
    [0, 1],
    [0, 2],
    [1, 2],
  ] as const) {
    if (sameBytes(attestors[i], attestors[j])) {
      throw new Error(
        `allowlistAttestorKeysHex[${i}] and [${j}] are the same key. Three DISTINCT holders, or the threshold ` +
          'is decorative: one person holding two of them supplies both halves of a 2-of-3 alone.',
      );
    }
  }
  if (input.allowlistThreshold !== 2 && input.allowlistThreshold !== 3) {
    throw new Error(`allowlistThreshold must be 2 or 3, got ${JSON.stringify(input.allowlistThreshold)}`);
  }
  if (isZero(platformAddr)) {
    throw new Error('platformAddrHex cannot be all zero — it receives forfeited DarkVeil bonds.');
  }

  const totalSupply = toBigInt(input.totalSupply, 'totalSupply');
  const maxWalletPercent = toBigInt(input.maxWalletPercent, 'maxWalletPercent');
  const bondAmount = toBigInt(input.bondAmount, 'bondAmount');
  // Every 32-byte value is a well-formed colour, so there is nothing to
  // validate about its SHAPE beyond the length fromHex32 already enforces.
  // What is worth stating is that all-zero is meaningful rather than missing:
  // it is nativeToken(). A deploy that means NIGHT says so by omission.
  const bondTokenColour = fromHex32(input.bondTokenColourHex ?? NATIVE_TOKEN_COLOUR_HEX, 'bondTokenColourHex');
  const dvAllocation = toBigInt(input.dvAllocation, 'dvAllocation');
  const dvPrice = toBigInt(input.dvPrice, 'dvPrice');
  const allowlistSize = toBigInt(input.allowlistSize, 'allowlistSize');
  const registrationCloseTime = toBigInt(input.registrationCloseTime, 'registrationCloseTime');
  // CLAUDE.md's DarkVeil sequence: registration runs T-48h to T-2h (so a 46h
  // window, since registrationCloseTime IS the T-2h freeze), a 2h freeze, then
  // DV_BUYING_HRS of buying.
  const registrationWindowSeconds = toBigInt(input.registrationWindowSeconds ?? 46 * 3600, 'registrationWindowSeconds');
  const freezeWindowSeconds = toBigInt(input.freezeWindowSeconds ?? 2 * 3600, 'freezeWindowSeconds');
  const buyingWindowSeconds = toBigInt(input.buyingWindowSeconds ?? 24 * 3600, 'buyingWindowSeconds');
  const minDvParticipants = toBigInt(input.minDvParticipants, 'minDvParticipants');

  if (totalSupply <= 0n) {
    throw new Error('totalSupply must be greater than 0.');
  }
  if (maxWalletPercent <= 0n || maxWalletPercent > 100n) {
    throw new Error(`maxWalletPercent must be 1-100, got ${maxWalletPercent}`);
  }
  if (bondAmount > MAX_BOND_AMOUNT) {
    throw new Error(
      `bondAmount ${bondAmount} exceeds ${MAX_BOND_AMOUNT} (2^44-1). Above this no bond refund could ever ` +
        'succeed for the whole launch, which is why the contract refuses it at deploy rather than at refund.',
    );
  }
  if (registrationCloseTime <= 0n) {
    throw new Error('registrationCloseTime must be greater than 0.');
  }
  // The contract seals the derived schedule and refuses these itself; refusing
  // here too means a bad schedule costs a validation error rather than a
  // deploy. The registration window has to fit before the close, or the
  // derived open time would wrap.
  for (const [name, value] of [
    ['registrationWindowSeconds', registrationWindowSeconds],
    ['freezeWindowSeconds', freezeWindowSeconds],
    ['buyingWindowSeconds', buyingWindowSeconds],
  ] as const) {
    if (value <= 0n) throw new Error(`${name} must be greater than 0.`);
  }
  if (registrationCloseTime <= registrationWindowSeconds) {
    throw new Error(
      `registrationCloseTime ${registrationCloseTime} must be later than registrationWindowSeconds ` +
        `${registrationWindowSeconds}, or registration would open before the epoch.`,
    );
  }
  if (minDvParticipants <= 0n) {
    throw new Error('minDvParticipants must be greater than 0.');
  }
  if (dvAllocation > totalSupply) {
    throw new Error(`dvAllocation ${dvAllocation} exceeds totalSupply ${totalSupply}.`);
  }

  const walletCap = (totalSupply * maxWalletPercent) / 100n;
  if (walletCap <= 0n) {
    throw new Error(
      `walletCap derives to 0 from totalSupply=${totalSupply} and maxWalletPercent=${maxWalletPercent}. ` +
        'The contract refuses a non-positive cap.',
    );
  }
  if (input.walletCap !== undefined) {
    const supplied = toBigInt(input.walletCap, 'walletCap');
    if (supplied !== walletCap) {
      throw new Error(
        `walletCap ${supplied} does not equal totalSupply * maxWalletPercent / 100 (${walletCap}). ` +
          'This value caps every wallet for the life of the launch and cannot be changed afterwards.',
      );
    }
  }

  return {
    launchId,
    allowlistRoot,
    totalSupply,
    maxWalletPercent,
    bondAmount,
    bondTokenColour,
    walletCap,
    dvAllocation,
    dvPrice,
    allowlistSize,
    registrationCloseTime,
    registrationWindowSeconds,
    freezeWindowSeconds,
    buyingWindowSeconds,
    minDvParticipants,
    creatorPubKey,
    platformAddr,
    allowlistAttestorKeys: attestors,
    allowlistThreshold: BigInt(input.allowlistThreshold),
  };
}
