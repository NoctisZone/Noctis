// ============================================================================
// Noctis Zone — what a launch driver needs from this workspace, in one bundle
// ============================================================================
// The scripts that drive a rehearsal — the fifteen participants' registrations,
// commitments, reveals and refunds — are plain Node scripts kept outside the
// repository, and they cannot import TypeScript. Each of them used to carry
// its own copy of whatever it needed from here: an indexer URL table, a ledger
// decode, and, worst, its own idea of what a failed step meant, which was "the
// step failed", so every routine transient stopped the run for a person.
//
// This bundles the pieces those scripts should share with the conductor and
// the CLIs rather than restate: the failure classifier, the indexer probe, the
// tolerant result reader, the wallet-free ledger read, and the two derivations
// a driver needs to ask the chain "did my step land" without a wallet. Nothing
// here is new logic; it is the same functions the tested modules export.
//
// Deliberately without the wallet SDK. A driver reads through the indexer and
// spawns a CLI for anything that pays a fee, so nothing in it should load a
// wallet, and a second wallet process beside a running one is the shape that
// tears a snapshot.
// ============================================================================

// biome-ignore-all lint/performance/noBarrelFile: this file exists to be bundled for scripts outside the repository, and the graph it gathers is the deliverable
export { computeBuyCommit } from '../../packages/zk-proofs/src/eligibility-gate.js';
export { describeError } from '../error-detail.js';
export {
  assertIndexerReachable,
  type IndexerProbe,
  indexerUsable,
  probeIndexer,
  type WaitForIndexerOptions,
  waitForIndexer,
} from '../indexer-availability.js';
export { readDarkVeilSnapshot, readEligibilityGateLedger, summarizeDarkVeil } from '../midnight-public-state.js';
export { deriveDarkVeilBuyNonce, deriveUserSecretFromSeed } from '../midnight-user-identity.js';
export {
  type BankedJobResult,
  classifySubmission,
  indexerOutageIn,
  isAutomaticallyRecoverable,
  ledgerCodesIn,
  nodeReplyUnreadableIn,
  retryDelayMs,
  type SubmissionDisposition,
  type SubmissionOutcome,
} from '../submission-outcome.js';
export { resultJsonFrom } from './cli-io.js';
