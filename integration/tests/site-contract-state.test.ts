import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { describe, expect, it, vi } from 'vitest';
import { siteContractStateReader } from '../widget/site-contract-state.js';

const ADDRESS = 'ab'.repeat(32);
const STATE = new ContractState();
const STATE_HEX = Buffer.from(STATE.serialize()).toString('hex');

function answering(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & {
    mock: { calls: unknown[][] };
  };
}

describe('siteContractStateReader', () => {
  it("decodes the route's state the way the indexer provider does", async () => {
    const fetchImpl = answering(200, { state: STATE_HEX });
    const read = await siteContractStateReader(
      'https://site.example/wp-json/np/v1/midnight/contract-state',
      fetchImpl,
    ).queryContractState(ADDRESS);
    expect(read).not.toBeNull();
    expect(Buffer.from((read as ContractState).serialize()).toString('hex')).toBe(STATE_HEX);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://site.example/wp-json/np/v1/midnight/contract-state?address=${ADDRESS}`,
    );
  });

  it('adds the address to a route that already carries a query', async () => {
    const fetchImpl = answering(200, { state: STATE_HEX });
    await siteContractStateReader(
      'https://site.example/?rest_route=/np/v1/midnight/contract-state',
      fetchImpl,
    ).queryContractState(ADDRESS);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://site.example/?rest_route=/np/v1/midnight/contract-state&address=${ADDRESS}`,
    );
  });

  it('reads no contract as null, as the provider does', async () => {
    await expect(
      siteContractStateReader('/s', answering(200, { state: null })).queryContractState(ADDRESS),
    ).resolves.toBeNull();
  });

  it('says what the route said when it refuses, and refuses a state that is not hex', async () => {
    await expect(
      siteContractStateReader(
        '/s',
        answering(429, { message: 'Too many reads; try again shortly.' }),
      ).queryContractState(ADDRESS),
    ).rejects.toThrow('Too many reads; try again shortly.');
    await expect(
      siteContractStateReader('/s', answering(200, { state: 'zz' })).queryContractState(ADDRESS),
    ).rejects.toThrow(/not hex/);
  });
});
