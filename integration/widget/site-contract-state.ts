// ============================================================================
// Noctis — reading a Midnight contract's state through the site
// ============================================================================
// A page that reads Midnight without a wallet asks an indexer directly. That
// works while the site's indexer is one a browser may call with no key. An
// indexer that needs a key (Blockfrost) is reached only through the site's own
// route, `np/v1/midnight/contract-state`, which asks it the same question the
// Midnight.js provider asks, `contractAction(address) { state }`, with the key
// the browser never sees, and returns the state as hex. This decodes that hex
// exactly as the provider does, so what the page reads is the same either way.
//
// Only `queryContractState` is offered: the wallet-free governance read is the
// one thing that goes through it.
// ============================================================================

import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';

export type ContractStateReader = Pick<PublicDataProvider, 'queryContractState'>;

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('The site returned a contract state that is not hex.');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A reader that asks the site's route for each contract's current state. */
export function siteContractStateReader(stateUrl: string, fetchImpl: typeof fetch = fetch): ContractStateReader {
  return {
    async queryContractState(address) {
      const url = `${stateUrl}${stateUrl.includes('?') ? '&' : '?'}address=${encodeURIComponent(address)}`;
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      const body = (await res.json().catch(() => ({}))) as { state?: string | null; message?: string };
      if (!res.ok) throw new Error(body.message ?? `The site could not read contract ${address} (${res.status}).`);
      return body.state ? ContractState.deserialize(hexToBytes(body.state)) : null;
    },
  };
}
