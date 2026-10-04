// ============================================================================
// What both Cardano failover providers share
// ============================================================================
// The environment that names the second backend, and the parts of the
// submission rules that do not depend on which library threw the error.
// cardano-provider.ts (Lucid) and mesh-cardano-provider.ts (Mesh) both read
// from here, so the two can never disagree about either.
//
// Deliberately free of any chain library: a Mesh-only bundle takes these
// without taking Lucid, and Lucid's with them its WASM.
// ============================================================================

/** The environment that names the second backend. */
export const FALLBACK_KOIOS_URL_ENV = 'NP_CARDANO_FALLBACK_KOIOS_URL';
export const FALLBACK_KOIOS_TOKEN_ENV = 'NP_CARDANO_FALLBACK_KOIOS_TOKEN';

/** An error's text, whatever was thrown. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether a refusal only says the transaction is already queued or known. */
export function isAlreadySubmitted(err: unknown): boolean {
  return /already (?:been )?(?:submitted|in (?:the )?mempool|exists in (?:the )?mempool)|AlreadyInMempool|transaction already known/i.test(
    errorText(err),
  );
}

export class AmbiguousSubmissionError extends Error {
  constructor(
    readonly transitError: unknown,
    readonly refusal: unknown,
  ) {
    super(
      `The first backend failed in transit (${errorText(transitError)}) and the second refused the transaction ` +
        `(${errorText(refusal)}). The first may have accepted it before its connection dropped — read the chain ` +
        'before resubmitting.',
    );
    this.name = 'AmbiguousSubmissionError';
  }
}
