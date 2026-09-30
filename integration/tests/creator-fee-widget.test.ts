// creator-fee-widget.test.ts
//
// The dashboard's claim entry: what it hands the submitter, and what it
// refuses before anything is built. The submitter is mocked here; its own
// tests cover the claim itself.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptAddressOf } from '../reference-script.js';

const built: unknown[] = [];
const claimed = vi.fn();
const readPool = vi.fn();
const placed = vi.fn();

vi.mock('../venue-royalty-withdraw-placer.js', () => ({
  readVenuePoolByNft: (...args: unknown[]) => readPool(...args),
  placeVenueRoyaltyWithdraw: (...args: unknown[]) => placed(...args),
}));

vi.mock('../tier-b-curve-submitter.js', () => ({
  PLATFORM_CHARGE_LOVELACE: 5_000_000n,
  meshBlockfrostProvider: () => ({ mesh: 'provider' }),
  LucidTierBCurveSubmitter: class {
    constructor(config: unknown) {
      built.push(config);
    }
    claimCreatorFeesWithWallet(walletApi: unknown, amount: bigint) {
      return claimed(walletApi, amount);
    }
  },
}));

interface Widget {
  configure(cfg: unknown): void;
  claimChargeLovelace(): string;
  claim(request: {
    launchIdHex: string;
    threadNftPolicyId: string;
    amountLovelace: string;
    walletApi: unknown;
  }): Promise<{ txHash: string }>;
  withdrawRoyalty(request: { poolNft: string; walletApi: unknown }): Promise<Record<string, string>>;
}

function venueCode(title: string): string {
  const all = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'plutus.json'), 'utf8'),
  ).validators as Array<{ title: string; compiledCode: string }>;
  const found = all.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing`);
  return found.compiledCode;
}
const VENUE = {
  poolScriptCbor: venueCode('royalty_pool/swap_order.swap_order.spend'),
  withdrawScriptCbor: venueCode('royalty_pool/withdraw_order.withdraw_order.spend'),
};

const events: string[] = [];
let widget: Widget;

const PAGE_CONFIG = {
  blockfrostUrl: 'https://noctis.example/wp-json/np/v1/blockfrost-proxy',
  blockfrostProjectId: 'proxy',
  network: 'Preprod',
  curveScriptCbor: '5901',
  referenceScript: { txHash: 'ab'.repeat(32), outputIndex: 0, scriptHash: 'cd'.repeat(28) },
};
const LAUNCH = { launchIdHex: 'ee'.repeat(32), threadNftPolicyId: 'ff'.repeat(28) };

beforeAll(async () => {
  const win = {
    dispatchEvent: (e: Event) => {
      events.push(e.type);
      return true;
    },
  } as unknown as Window & { NoctisCreatorFees: Widget };
  vi.stubGlobal('window', win);
  await import('../widget/creator-fee-widget-entry.js');
  widget = win.NoctisCreatorFees;
});

beforeEach(() => {
  built.length = 0;
  claimed.mockReset();
  readPool.mockReset();
  placed.mockReset();
});

describe('the creator-fee widget', () => {
  it('announces itself once loaded, so a page that fetched it on demand can go on', () => {
    expect(widget).toBeDefined();
    expect(events).toEqual(['noctis-creator-fees-ready']);
  });

  it('names the platform charge the claiming wallet pays', () => {
    expect(widget.claimChargeLovelace()).toBe('5000000');
  });

  it('refuses a claim before the page has configured it', async () => {
    await expect(widget.claim({ ...LAUNCH, amountLovelace: '1000000', walletApi: {} })).rejects.toThrow(
      /configure\(\) must be called/,
    );
    expect(built).toEqual([]);
  });

  it('builds the referenced claim from the page config and the launch, with the wallet it was given', async () => {
    widget.configure(PAGE_CONFIG);
    claimed.mockResolvedValue({ txHash: 'tx-1' });
    const wallet = { __wallet: true };
    await expect(widget.claim({ ...LAUNCH, amountLovelace: '7000000', walletApi: wallet })).resolves.toEqual({
      txHash: 'tx-1',
    });
    expect(built).toEqual([
      {
        blockfrostProjectId: 'proxy',
        blockfrostUrl: PAGE_CONFIG.blockfrostUrl,
        network: 'Preprod',
        compiledScriptCbor: '5901',
        launchIdHex: LAUNCH.launchIdHex,
        threadNftPolicyId: LAUNCH.threadNftPolicyId,
        referenceScript: PAGE_CONFIG.referenceScript,
      },
    ]);
    expect(claimed).toHaveBeenCalledWith(wallet, 7_000_000n);
  });

  it('refuses an empty claim before building anything', async () => {
    widget.configure(PAGE_CONFIG);
    await expect(widget.claim({ ...LAUNCH, amountLovelace: '0', walletApi: {} })).rejects.toThrow(/nothing to claim/);
    expect(built).toEqual([]);
    expect(claimed).not.toHaveBeenCalled();
  });
});

describe('withdrawing the pool royalty', () => {
  it('says it is not open where the site does not fill withdraws', async () => {
    widget.configure(PAGE_CONFIG);
    await expect(widget.withdrawRoyalty({ poolNft: 'aa', walletApi: {} })).rejects.toThrow(/not open on this site/);
    expect(readPool).not.toHaveBeenCalled();
  });

  it('reads the pool at the deployed pool address and places the request at the request address', async () => {
    widget.configure({ ...PAGE_CONFIG, venue: VENUE });
    const pool = { __pool: true };
    readPool.mockResolvedValue(pool);
    placed.mockResolvedValue({
      txHash: 'tx-9',
      draft: {
        withdrawData: { withdraw_royalty_x: 9_000_000n, withdraw_royalty_y: 400n, ex_fee: 2_000_000n },
        payoutAddress: 'addr_test1vcreator',
      },
    });
    const wallet = { __wallet: true };
    await expect(widget.withdrawRoyalty({ poolNft: 'aabb', walletApi: wallet })).resolves.toEqual({
      txHash: 'tx-9',
      takeLovelace: '9000000',
      takeTokens: '400',
      feeLovelace: '2000000',
      payoutAddress: 'addr_test1vcreator',
    });
    expect(readPool).toHaveBeenCalledWith(expect.any(Function), scriptAddressOf(VENUE.poolScriptCbor, 0), 'aabb');
    expect(placed).toHaveBeenCalledWith({
      api: wallet,
      pool,
      network: 'preprod',
      requestAddress: scriptAddressOf(VENUE.withdrawScriptCbor, 0),
      provider: { mesh: 'provider' },
    });
  });
});
