// ============================================================================
// Compacting a banked dust snapshot
// ============================================================================
// A dust sub-wallet's local state carries the chain's whole dust GENERATION
// tree, and the ledger re-expands a leaf every time that leaf's generation is
// updated, then never collapses it again. So the banked blob, and the time it
// takes to restore, grow with the chain rather than with the wallet.
//
// Only the leaves behind the wallet's OWN backing NIGHT are needed to spend.
// Every other leaf can be collapsed into its subtree hash with
// `DustLocalState.collapseGenerationTree(lo, hi)`: a collapsed subtree keeps its
// hash, so the tree root and every spend path the wallet can build are
// unchanged. The commitment tree is left alone.
//
// The pattern, and the observation that makes it safe, are from ODATANO's
// NIGHTGATE (github.com/ODATANO/NIGHTGATE, `srv/midnight/worker/dust-collapse.ts`,
// Apache-2.0); this is a reimplementation over our own snapshot format.
//
// THE SAFETY RULE, and the reason a failure here never costs anything: the
// compacted state is deserialized again and must reproduce the generation and
// commitment roots, the balance at its own sync time and the UTXO count of the
// original. Anything else — a parse that finds nothing, an own UTXO whose
// backing NIGHT is not in the index, a root that moved — returns the ORIGINAL
// blob untouched, with the reason. Compaction is an optimisation; the full blob
// is always a correct snapshot.
//
// What it does not do: avoid the first replay from genesis. A wallet with no
// snapshot still applies every event once. This makes every LATER restore cheap.
// ============================================================================

import * as ledger from '@midnight-ntwrk/ledger-v8';

/** The wallet's own generation entries, read out of the state's debug form. */
export interface OwnGeneration {
  /** The generation tree's next free index: every leaf in use is below it. */
  firstFree: bigint;
  /** Backing NIGHT initial nonce (lower-case hex) → its generation index. */
  nightIndices: Map<string, bigint>;
}

/**
 * Read `generating_tree_first_free` and `night_indices` out of
 * `DustLocalState.toString(true)`.
 *
 * Parsed from the debug string because the ledger exposes neither field as a
 * property. That is fragile by nature, and it is why the caller re-verifies
 * the result rather than trusting this parse: a format change makes this
 * return null or an incomplete map, and either one is caught before a byte is
 * written.
 */
export function parseOwnGeneration(text: string): OwnGeneration | null {
  const firstFree = /generating_tree_first_free:\s*(\d+)/.exec(text);
  const at = text.indexOf('night_indices:');
  if (!firstFree || at < 0) return null;
  const end = text.indexOf('}', at);
  if (end < 0) return null;
  const nightIndices = new Map<string, bigint>();
  for (const match of text.slice(at, end).matchAll(/InitialNonce\(([0-9a-fA-F]+)\):\s*(\d+)/g)) {
    nightIndices.set(match[1].toLowerCase(), BigInt(match[2]));
  }
  return { firstFree: BigInt(firstFree[1]), nightIndices };
}

/**
 * The inclusive index ranges in `[0, firstFree)` that hold none of `keep`.
 *
 * Indices outside that interval are ignored rather than trusted, so a stray
 * value cannot widen a range past the tree's used part.
 */
export function foreignRanges(keep: Iterable<bigint>, firstFree: bigint): [bigint, bigint][] {
  const sorted = [...new Set(keep)]
    .filter((i) => i >= 0n && i < firstFree)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ranges: [bigint, bigint][] = [];
  let next = 0n;
  for (const index of [...sorted, firstFree]) {
    if (index > next) ranges.push([next, index - 1n]);
    next = index + 1n;
  }
  return ranges;
}

export interface DustCollapseResult {
  /** The blob to bank: compacted when `collapsed`, otherwise the input unchanged. */
  blob: string;
  collapsed: boolean;
  /** Serialized local-state bytes before and after (equal when not collapsed). */
  fullBytes: number;
  bytes: number;
  /** How many foreign ranges were collapsed, and how many own leaves were kept. */
  ranges: number;
  ownLeaves: number;
  /** Why the original was returned, when it was. */
  reason?: string;
}

/** The ledger surface this needs, injectable so a test can stand it in. */
export interface DustLedger {
  DustLocalState: { deserialize(raw: Uint8Array): ledger.DustLocalState };
}

interface DustSnapshotJson {
  state?: unknown;
  [key: string]: unknown;
}

function parseSnapshot(blob: string): DustSnapshotJson | string {
  let snapshot: DustSnapshotJson;
  try {
    snapshot = JSON.parse(blob) as DustSnapshotJson;
  } catch {
    return 'the dust snapshot is not JSON';
  }
  if (typeof snapshot.state !== 'string' || snapshot.state.length === 0 || !/^[0-9a-fA-F]*$/.test(snapshot.state)) {
    return 'the dust snapshot carries no hex state';
  }
  return snapshot;
}

function untouchedResult(blob: string, fullBytes: number, reason: string): DustCollapseResult {
  return { blob, collapsed: false, fullBytes, bytes: fullBytes, ranges: 0, ownLeaves: 0, reason };
}

/**
 * Compact one banked dust sub-wallet snapshot — the JSON string the dust
 * wallet's `serializeState()` returns, whose `state` field is the hex-encoded
 * `DustLocalState`.
 *
 * For a snapshot already on disk. It has to deserialize the full state first,
 * and that is the slow step this whole module exists to remove — about two
 * minutes for a ~6.5 MB Preprod state — so a running wallet should use
 * `compactingDustSerializer`, which starts from the state already in memory.
 *
 * Never throws. Every failure returns the original blob with a reason.
 */
export function collapseDustSnapshotBlob(blob: string, ledgerApi: DustLedger = ledger): DustCollapseResult {
  const snapshot = parseSnapshot(blob);
  if (typeof snapshot === 'string') return untouchedResult(blob, 0, snapshot);
  try {
    const full = ledgerApi.DustLocalState.deserialize(Uint8Array.from(Buffer.from(snapshot.state as string, 'hex')));
    return collapseDustLocalState(full, blob, ledgerApi);
  } catch (err) {
    return untouchedResult(
      blob,
      (snapshot.state as string).length / 2,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Compact a snapshot from the `DustLocalState` it was serialized from.
 *
 * `blob` MUST be that same state's serialization — the two are taken from one
 * wallet-state emission by `compactingDustSerializer`, so they cannot disagree.
 * Never throws.
 */
export function collapseDustLocalState(
  full: ledger.DustLocalState,
  blob: string,
  ledgerApi: DustLedger = ledger,
): DustCollapseResult {
  const snapshot = parseSnapshot(blob);
  if (typeof snapshot === 'string') return untouchedResult(blob, 0, snapshot);
  const fullBytes = (snapshot.state as string).length / 2;
  const untouched = (n: number, reason: string) => untouchedResult(blob, n, reason);

  try {
    const own = parseOwnGeneration(full.toString(true));
    if (!own) return untouched(fullBytes, 'the state has no generating_tree_first_free / night_indices to read');

    // Collapsing the leaf behind an own UTXO would leave the wallet unable to
    // look up its own generation, which panics inside the wasm the next time it
    // builds a spend. Refuse rather than find out then.
    for (const utxo of full.utxos) {
      const night = String(utxo.backingNight).replace(/^0x/, '').toLowerCase();
      if (!own.nightIndices.has(night)) {
        return untouched(fullBytes, `an own dust UTXO's backing NIGHT ${night.slice(0, 16)}… is not in night_indices`);
      }
    }

    const ranges = foreignRanges(own.nightIndices.values(), own.firstFree);
    if (ranges.length === 0) return untouched(fullBytes, 'nothing foreign to collapse');

    let compact = full;
    for (const [lo, hi] of ranges) compact = compact.collapseGenerationTree(lo, hi);
    const bytes = compact.serialize();

    // Verified on a FRESH deserialize, so what is checked is what a restore
    // will actually read back, not the in-memory object that produced it.
    const back = ledgerApi.DustLocalState.deserialize(bytes);
    const at = full.syncTime;
    const same =
      String(back.generatingTreeRoot()) === String(full.generatingTreeRoot()) &&
      String(back.commitmentTreeRoot()) === String(full.commitmentTreeRoot()) &&
      back.walletBalance(at) === full.walletBalance(at) &&
      back.utxos.length === full.utxos.length;
    if (!same) return untouched(fullBytes, 'the compacted state does not restore to the same roots, balance and UTXOs');

    snapshot.state = Buffer.from(bytes).toString('hex');
    return {
      blob: JSON.stringify(snapshot),
      collapsed: true,
      fullBytes,
      bytes: bytes.length,
      ranges: ranges.length,
      ownLeaves: own.nightIndices.size,
    };
  } catch (err) {
    return untouched(fullBytes, err instanceof Error ? err.message : String(err));
  }
}

/** The slice of a dust wallet-state emission this needs: its own serializer and its local state. */
export interface DustWalletStateEmission {
  serialize(): string;
  state: { state: ledger.DustLocalState };
}

/** Anything with a subscribable stream of dust wallet states — the SDK's `DustWallet`. */
export interface DustStateSource {
  state: {
    subscribe(observer: { next(value: DustWalletStateEmission): void; error(err: unknown): void }): {
      unsubscribe(): void;
    };
  };
}

/** The current value of a replaying stream, then unsubscribe. */
function currentEmission(source: DustStateSource): Promise<DustWalletStateEmission> {
  return new Promise((resolve, reject) => {
    let done = false;
    let subscription: { unsubscribe(): void } | undefined;
    subscription = source.state.subscribe({
      next(value) {
        if (done) return;
        done = true;
        resolve(value);
        // A replaying stream emits DURING subscribe(), before the handle
        // exists; that case is unsubscribed just below instead.
        subscription?.unsubscribe();
      },
      error(err) {
        if (done) return;
        done = true;
        reject(err);
      },
    });
    if (done) subscription.unsubscribe();
  });
}

/**
 * A drop-in for the dust wallet's `serializeState()` that banks the compacted
 * form, for the snapshot saver.
 *
 * It does what `serializeState()` does — take the current state emission and
 * serialize it — then compacts from that SAME emission's in-memory local state,
 * so the blob and the state it is compacted from cannot come from different
 * instants. The saver's cursor-either-side rule still applies around it
 * unchanged. On any refusal the full blob is banked, exactly as before.
 */
export function compactingDustSerializer(
  dust: DustStateSource,
  onResult?: (result: DustCollapseResult, ms: number) => void,
  ledgerApi: DustLedger = ledger,
): { serializeState(): Promise<string> } {
  return {
    async serializeState() {
      const emission = await currentEmission(dust);
      const blob = emission.serialize();
      const started = Date.now();
      const result = collapseDustLocalState(emission.state.state, blob, ledgerApi);
      onResult?.(result, Date.now() - started);
      return result.blob;
    },
  };
}
