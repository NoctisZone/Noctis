// ============================================================================
// Noctis Zone — registrant bundle for a DarkVeil launch
// ============================================================================
// Produces the two things the buying window needs: the `registrantRoot_` that
// `publishRegistrantRoot` publishes, and one membership proof per registrant for
// `submitBuyCommit` to present later.
//
// THE REGISTRANT SET COMES FROM THE CHAIN, not from a list kept alongside it.
// `registerForDarkVeil` writes each registrant's derived identity into the
// public `lockedBonds` map, so who registered is already a matter of record —
// and reading it there means the set cannot drift from what actually happened.
// A locally-maintained roster could omit a registrant who really did bond, and
// the omission would only surface when that registrant's buy commitment failed
// with an invalid-proof error naming the tree rather than the roster.
//
// A DIFFERENT TREE FROM THE ALLOWLIST, with its own domain constants. The
// allowlist is who was ELIGIBLE, published before registration; this is who
// ACTUALLY REGISTERED, frozen at the moment buying opens. Presenting one where
// the other is expected verifies against the wrong root.
//
// Leaves are sorted canonically by identity, so anyone can rebuild this tree
// from public chain state and get the same root. The root is a public
// commitment; being able to re-derive it independently is what makes it
// checkable rather than merely asserted.
//
// WHEN TO RUN IT: at the freeze point, immediately before `publishRegistrantRoot`, and
// not before. The set it commits to is final because nothing can join after
// the same call that publishes it — run it earlier and any registration in
// between is committed to nothing, leaving that registrant unable to buy.
//
// Input:  {"network":"preprod","contractAddress":"…",
//          "indexerHttpUrl":"…","indexerWsUrl":"…"}   (URLs optional)
// Output: {"contractAddress":"…","registrantRootHex":"…","registrantCount":n,
//          "entries":[{"pubKeyHex":"…","bondAmount":"…",
//                      "proof":[{"siblingHex":"…","goesLeft":bool}, …]}, …]}
//
// Reads only. No wallet, no proof server, no transaction, no secret — so this
// is safe to run at any time, and its output carries nothing private beyond
// what the chain already publishes.
// ============================================================================

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { buildRegistrantTree, hashRegistrantLeaf } from '../../packages/zk-proofs/src/eligibility-gate.js';
import { readEligibilityGateLedger } from '../midnight-public-state.js';
import { defaultNetworkConfig, type MidnightNetwork } from '../midnight-server-wallet.js';
import { claimStdoutForResult, jsonSafe, parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface Input {
  network: MidnightNetwork;
  contractAddress: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function main() {
  // Stdout carries the result and nothing else; what the SDK logs goes with the rest of the diagnostics.
  claimStdoutForResult();
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, ['network', 'contractAddress']);

  setNetworkId(input.network);

  const netDefaults = input.network === 'mainnet' ? undefined : defaultNetworkConfig(input.network, 'http://unused');
  const indexerHttpUrl = input.indexerHttpUrl ?? netDefaults?.indexerHttpUrl;
  const indexerWsUrl = input.indexerWsUrl ?? netDefaults?.indexerWsUrl;
  if (!indexerHttpUrl || !indexerWsUrl) {
    throw new Error('indexerHttpUrl/indexerWsUrl must be supplied explicitly for network "mainnet".');
  }

  const publicDataProvider = indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl);
  const ledger = await readEligibilityGateLedger(publicDataProvider, input.contractAddress);

  const registrants = [...ledger.lockedBonds].map(([pubKey, bondAmount]) => ({
    pubKeyHex: toHex(pubKey),
    pubKey,
    bondAmount,
  }));
  if (registrants.length === 0) {
    throw new Error('No registrants on chain yet — lockedBonds is empty, so there is no set to freeze.');
  }

  // The counter and the map are written by the same circuit, in the same call.
  // They can only disagree if a bond has since left the map — which happens on
  // the refund and sweep paths, and both of those mean this launch is no longer
  // heading for a buying window at all. Refused rather than reported: a tree
  // built from a set that has already started unwinding commits to the wrong
  // registrants, and every proof from it would be silently valid-looking.
  if (BigInt(registrants.length) !== ledger.registrationCount) {
    throw new Error(
      `lockedBonds holds ${registrants.length} registrant(s) but registrationCount is ${ledger.registrationCount}. ` +
        'Bonds have already left the map, so this launch is on a refund path rather than heading for a buying window.',
    );
  }

  // Canonical order, so the root is reproducible by anyone reading the same
  // chain state rather than only by whoever ran this.
  registrants.sort((a, b) => (a.pubKeyHex < b.pubKeyHex ? -1 : a.pubKeyHex > b.pubKeyHex ? 1 : 0));

  const tree = buildRegistrantTree(registrants.map(({ pubKey }) => hashRegistrantLeaf(pubKey)));

  const entries = registrants.map(({ pubKeyHex, bondAmount }, index) => ({
    pubKeyHex,
    bondAmount,
    proof: tree.getProof(index).map((entry) => ({
      siblingHex: toHex(entry.sibling),
      goesLeft: entry.goesLeft,
    })),
  }));

  process.stdout.write(
    `${JSON.stringify(
      jsonSafe({
        contractAddress: input.contractAddress,
        registrantRootHex: toHex(tree.root),
        registrantCount: entries.length,
        entries,
      }),
    )}\n`,
  );
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
});
