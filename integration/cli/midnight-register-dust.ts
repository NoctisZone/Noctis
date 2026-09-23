// ============================================================================
// Noctis Zone — register NIGHT UTXOs for DUST generation
// ============================================================================
// Holding NIGHT does not pay for anything. A NIGHT UTXO generates the DUST
// that fees are denominated in only once it has been REGISTERED for
// generation, and registration is its own on-chain transaction — the wallet
// SDK never does it implicitly while balancing. So this runs once per wallet
// before that wallet's first transaction of any kind.
//
// Registration is self-funding, which is what makes the ordering work: the fee
// is claimed from the DUST the registered UTXOs have already generated
// (`splitNightUtxosForDustRegistration` sets `feePayment` from the coins'
// `generatedNow`), not from a balance the wallet does not have yet. A wallet
// at 0 DUST registers successfully.
//
// Already-registered UTXOs are filtered out rather than resubmitted, so this
// is safe to re-run: a wallet with nothing left to register reports
// `alreadyRegistered` instead of failing.
//
// Several wallets per process, results keyed by the caller's own role names —
// same shape as midnight-wallet-balances.ts, and for the same reason: one
// wallet's failure names itself instead of costing the others their result.
//
// Input:  {"network":"preprod","proofServerUrl":"http://127.0.0.1:6310",
//          "wallets":[{"role":"buyer_1","seedHex":"<64 hex>"}, …],
//          "waitForDustSeconds":0}
// Output: {"results":{"<role>":{"status":"registered","txId":…,
//                               "utxosRegistered":n,"dustAtomic":…}
//                     | {"status":"alreadyRegistered", …}
//                     | {"error":"…"}}}
// ============================================================================

import { inspect } from 'node:util';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import type { UtxoWithMeta } from '@midnight-ntwrk/wallet-sdk-facade';
import { PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { getUnshieldedRegistrationState } from '../indexer-client.js';
import {
  buildServerWallet,
  defaultNetworkConfig,
  hasUnshieldedNight,
  type MidnightNetwork,
  type SnapshotCliInput,
  snapshotOptionsFrom,
  waitForWalletState,
} from '../midnight-server-wallet.js';
import { claimStdoutForResult } from './cli-io.js';

interface WalletInput {
  role: string;
  seedHex: string;
}

interface Input extends SnapshotCliInput {
  network: MidnightNetwork;
  proofServerUrl: string;
  wallets: WalletInput[];
  /**
   * Optionally block until DUST actually shows up, per wallet. Left at 0 by
   * default: generation is continuous once registered, so the orchestrator
   * reads balances on its own schedule rather than paying this wait eleven
   * times over.
   */
  waitForDustSeconds?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait for a funded wallet's NIGHT UTXOs to appear. Minutes rather
 * than seconds — the unshielded sub-wallet settles quickly but still has to
 * connect and take its first update. If this expires the wallet is far more
 * likely to be unfunded than slow, which is what the error says.
 */
const COIN_WAIT_TIMEOUT_MS = 300_000;

/** How many times to re-attempt a submission that lost its node connection. */
const SUBMIT_ATTEMPTS = 4;

/**
 * Phase logging to stderr, so stdout stays a clean JSON channel.
 *
 * Without this the command is undiagnosable: every phase below can block on
 * the network, and a run that produces nothing looks identical whether it is
 * waiting for coins, proving, or wedged on shutdown.
 */
const log = (role: string, phase: string) => process.stderr.write(`[${new Date().toISOString()}] ${role}: ${phase}\n`);

/**
 * Stop the wallet, but never let stopping be the reason a result is lost.
 * facade.stop() tears down live subscriptions and can hang; when it does, the
 * work is already done and the caller still deserves its answer.
 */
async function shutdownQuietly(built: { shutdown: () => Promise<void> }, role: string): Promise<void> {
  const outcome = await Promise.race([
    built
      .shutdown()
      .then(() => 'stopped')
      .catch((e) => `failed: ${e}`),
    sleep(15_000).then(() => 'timed out'),
  ]);
  if (outcome !== 'stopped') log(role, `shutdown ${outcome} (continuing anyway)`);
}

/**
 * Did the NODE reject this, as opposed to the connection dropping?
 *
 * A rejection carries a coded RpcError; the disconnect race surfaces as a
 * socket close with no code. Retrying the former is worse than useless - each
 * attempt re-bans the transaction hash.
 */
function isNodeRejection(err: unknown): boolean {
  const text = inspect(err, { depth: 6 });
  return /RpcError|Invalid Transaction|Custom error|temporarily banned/.test(text);
}

async function registerOne(input: Input, wallet: WalletInput): Promise<Record<string, unknown>> {
  const config = defaultNetworkConfig(input.network, input.proofServerUrl);
  log(wallet.role, 'building wallet');
  // Registration pays its fee in DUST — the node reports 173,
  // InsufficientDustForRegistrationFee, when it cannot. So this wallet has to
  // reach the chain head like any other fee-payer, and resuming from a snapshot
  // is what keeps that a catch-up rather than a replay of all history.
  const built = await buildServerWallet(
    Buffer.from(wallet.seedHex, 'hex'),
    config,
    snapshotOptionsFrom(input, wallet.role, (message) => log(wallet.role, message)),
  );

  try {
    const nightTokenType = ledger.nativeToken().raw;

    // Ask the CHAIN whether this wallet is already registered, before touching
    // the wallet's own view of its coins. A short-lived facade keeps serving
    // the original, already-spent UTXO — registration rotates it — so trusting
    // availableCoins here means re-registering an already-registered wallet,
    // collecting 173, and eventually a 1012 ban.
    const address = String(PublicKey.fromKeyStore(built.unshieldedKeystore).address);
    log(wallet.role, 'checking chain registration state');
    const onChain = await getUnshieldedRegistrationState(config.indexerWsUrl, address);
    if (onChain.registered) {
      log(wallet.role, 'already registered on chain — nothing to do');
      return {
        status: 'alreadyRegistered',
        utxosRegistered: 0,
        createdNightUtxos: onChain.createdNightUtxos,
        spentNightUtxos: onChain.spentNightUtxos,
      };
    }

    log(wallet.role, 'not registered on chain; waiting for NIGHT UTXOs');

    // Wait for the NIGHT UTXOs this command actually needs, not for all three
    // sub-wallets to reach the tip. The unshielded sub-wallet carries them and
    // settles almost immediately; waiting on the dust sub-wallet's full sync
    // instead is what put earlier runs into an OOM without ever registering.
    const state = await waitForWalletState(
      built.facade,
      (state) => state.isSynced && hasUnshieldedNight(state),
      COIN_WAIT_TIMEOUT_MS,
      'this wallet to reach the chain head with NIGHT UTXOs visible (is it funded?)',
    );

    // Only NIGHT, and only what is not already generating. Resubmitting an
    // already-registered UTXO is rejected, so this filter is what makes the
    // command idempotent rather than a one-shot.
    const toRegister: readonly UtxoWithMeta[] = state.unshielded.availableCoins.filter(
      (coin) => coin.utxo.type === nightTokenType && coin.meta.registeredForDustGeneration === false,
    );

    if (toRegister.length === 0) {
      return {
        status: 'alreadyRegistered',
        utxosRegistered: 0,
        dustAtomic: state.dust.balance(new Date()).toString(),
      };
    }

    // Deliberately NOT calling facade.estimateRegistration(): its first act is
    // `await this.dust.waitForSyncedState()`, and the dust sub-wallet does not
    // reach the tip on preprod (see midnight-server-wallet.ts's note and
    // upstream #639), so it never returns. It is observation-only by the SDK's
    // own description — it builds a throwaway transaction with a sampled
    // signing key purely to price it — so nothing downstream needs it. The
    // registration path below computes its own fee allowance from
    // splitNightUtxosForDustRegistration, which reads current state and does
    // not wait.
    // Log each UTXO's age: registration is funded from the DUST an
    // unregistered UTXO has generated, and the ledger's grace period is 3h
    // (dustGracePeriodSeconds = 10800), so age is the first thing to look at
    // when the node answers 173 (InsufficientDustForRegistrationFee).
    const ages = toRegister
      .map((c) => {
        const ctime = new Date(c.meta.ctime as unknown as string).getTime();
        return Number.isFinite(ctime) ? `${((Date.now() - ctime) / 3_600_000).toFixed(2)}h` : 'unknown';
      })
      .join(',');
    log(wallet.role, `${toRegister.length} unregistered NIGHT UTXO(s) age=[${ages}]; building registration`);
    const recipe = await built.facade.registerNightUtxosForDustGeneration(
      toRegister,
      built.unshieldedKeystore.getPublicKey(),
      (payload) => built.unshieldedKeystore.signData(payload),
    );
    log(wallet.role, 'proving (proof server)');
    const finalized = await built.facade.finalizeRecipe(recipe);

    // The node RPC socket is closed by the server shortly after connect
    // ("1000: Normal Closure"), and a submit that lands on the dead socket
    // fails with a generic SubmissionError whose cause is that disconnect.
    // The endpoint itself is healthy - system_health answers on every URL
    // form - so this is a reconnect race, not an outage, and retrying is the
    // right response. Submitting the same signed transaction twice is safe:
    // a duplicate is rejected by the node, it cannot double-register.
    log(wallet.role, 'submitting');
    let txId: string | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt++) {
      try {
        txId = await built.facade.submitTransaction(finalized);
        break;
      } catch (err) {
        lastError = err;
        // Only a TRANSPORT failure is worth retrying. A rejection the node has
        // already judged (1010 invalid, 173 insufficient dust) will be judged
        // the same way every time, and Substrate re-bans the hash on each
        // rejection - so retrying one earns a temporary ban (1012) instead of
        // a result. That is exactly how buyer_1 accumulated 17 rejections.
        if (isNodeRejection(err)) {
          log(wallet.role, 'node REJECTED the transaction - not retrying');
          break;
        }
        log(wallet.role, `submit attempt ${attempt}/${SUBMIT_ATTEMPTS} failed (transport); retrying`);
        if (attempt < SUBMIT_ATTEMPTS) await sleep(5_000);
      }
    }
    if (txId === undefined) throw lastError;
    log(wallet.role, `submitted tx ${txId}`);

    // Read the current state, then keep re-reading only while the caller asked
    // us to wait and nothing has generated yet. Reads the latest emitted state
    // rather than a fully synced one, for the same reason as above.
    const readDust = async () =>
      (await waitForWalletState(built.facade, () => true, 60_000, 'a wallet state update')).dust.balance(new Date());

    const deadline = Date.now() + (input.waitForDustSeconds ?? 0) * 1000;
    let dustAtomic = await readDust();
    while (dustAtomic === 0n && Date.now() < deadline) {
      await sleep(2000);
      dustAtomic = await readDust();
    }

    return {
      status: 'registered',
      txId,
      utxosRegistered: toRegister.length,
      dustAtomic: dustAtomic.toString(),
    };
  } finally {
    await shutdownQuietly(built, wallet.role);
  }
}

async function main(): Promise<void> {
  // Stdout carries the result and nothing else; what the SDK logs goes with the rest of the diagnostics.
  claimStdoutForResult();
  const input: Input = JSON.parse(await readStdin());
  if (!input.proofServerUrl) throw new Error('proofServerUrl is required.');
  if (!Array.isArray(input.wallets) || input.wallets.length === 0) {
    throw new Error('wallets must be a non-empty array of {role, seedHex}.');
  }

  const results: Record<string, unknown> = {};
  for (const wallet of input.wallets) {
    if (!wallet?.role) throw new Error('every wallet needs a role.');
    if (!/^[0-9a-fA-F]{64}$/.test(wallet.seedHex ?? '')) {
      results[wallet.role] = { error: 'seedHex must be 32 bytes (64 hex chars).' };
      continue;
    }
    try {
      results[wallet.role] = await registerOne(input, wallet);
    } catch (err) {
      // Submission failures arrive as a terse message with the real reason on
      // `cause` (the node's own coded error). Reporting only `message` turns
      // every distinct chain rejection into the same unactionable string.
      // The SDK raises an Effect tagged error whose real reason hangs off a
      // `cause` property that is NOT the standard Error.cause, so neither
      // `err.message` nor `String(err)` shows what the node actually said.
      // inspect() walks it; without this every rejection reads the same.
      const detail = inspect(err, { depth: 6, breakLength: 200 }).replace(/\s+/g, ' ').slice(0, 1200);
      log(wallet.role, `FAILED ${detail}`);
      results[wallet.role] = { error: detail };
    }
  }

  await writeAndExit({ results }, 0);
}

/**
 * Write the JSON result, wait for it to actually flush, then exit.
 *
 * The wallet SDK leaves live subscriptions and timers behind even after the
 * facade is stopped, so the event loop does not drain on its own and the
 * process would otherwise sit there having already finished its work. Exiting
 * on the write callback rather than immediately is what stops the output being
 * truncated when stdout is a pipe or a file.
 */
function writeAndExit(payload: unknown, code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write(JSON.stringify(payload), () => process.exit(code));
  });
}

main().catch(async (err) => {
  await writeAndExit({ error: err instanceof Error ? err.message : String(err) }, 1);
});
