// darkveil-claim-widget.test.ts
//
// The claim page's entry: what it hands the claim flow, and what it refuses
// before anything is built. The flow is mocked here; the referenced spend it
// builds is covered in tier-b-curve-referenced.test.ts.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const flowed = vi.fn();

vi.mock('../widget/claim-flow.js', () => ({
  claimTierBTokens: (...args: unknown[]) => flowed(...args),
}));

interface Widget {
  configure(cfg: unknown): void;
  claim(request: { launchIdHex: string; walletApi: unknown; params: unknown }): Promise<{ txHash: string }>;
}

const events: string[] = [];
let widget: Widget;

const PAGE_CONFIG = {
  blockfrostProjectId: '',
  blockfrostUrl: 'https://noctis.example/wp-json/np/v1/blockfrost-proxy',
  network: 'Preprod',
  compiledScriptCbor: '5901',
  threadNftPolicyId: 'ff'.repeat(28),
  referenceScript: { txHash: 'ab'.repeat(32), outputIndex: 0, scriptHash: 'cd'.repeat(28) },
};
const PARAMS = {
  dvAmount: 100n,
  salt: new Uint8Array(32).fill(3),
  merkleProof: [{ sibling: new Uint8Array(32).fill(4), goesLeft: true }],
  buyerKeyHash: new Uint8Array(28).fill(0x11),
  leafIndex: 2,
};

beforeAll(async () => {
  const win = {
    dispatchEvent: (e: Event) => {
      events.push(e.type);
      return true;
    },
  } as unknown as Window & { NoctisDarkVeilClaim: Widget };
  vi.stubGlobal('window', win);
  await import('../widget/darkveil-claim-widget-entry.js');
  widget = win.NoctisDarkVeilClaim;
});

beforeEach(() => {
  flowed.mockReset();
});

describe('the DarkVeil claim widget', () => {
  it('announces itself once loaded, so a page that fetched it on demand can go on', () => {
    expect(widget).toBeDefined();
    expect(events).toEqual(['noctis-darkveil-claim-ready']);
  });

  it('refuses a claim before the page has configured it', async () => {
    await expect(widget.claim({ launchIdHex: 'ee'.repeat(32), walletApi: {}, params: PARAMS })).rejects.toThrow(
      /configure\(\) must be called/,
    );
    expect(flowed).not.toHaveBeenCalled();
  });

  it('refuses a page that cannot name the published curve script, before building anything', async () => {
    for (const referenceScript of [undefined, null]) {
      widget.configure({ ...PAGE_CONFIG, referenceScript });
      await expect(widget.claim({ launchIdHex: 'ee'.repeat(32), walletApi: {}, params: PARAMS })).rejects.toThrow(
        /Claims are not open yet/,
      );
    }
    expect(flowed).not.toHaveBeenCalled();
  });

  it('builds the referenced claim from the page config and the launch, with the wallet it was given', async () => {
    widget.configure(PAGE_CONFIG);
    flowed.mockResolvedValue({ txHash: 'tx-1' });
    const wallet = { __wallet: true };
    await expect(widget.claim({ launchIdHex: '0aff', walletApi: wallet, params: PARAMS })).resolves.toEqual({
      txHash: 'tx-1',
    });
    expect(flowed).toHaveBeenCalledOnce();
    const [config, walletApi, params] = flowed.mock.calls[0] as [Record<string, unknown>, unknown, unknown];
    expect(config).toEqual({
      blockfrostProjectId: '',
      blockfrostUrl: PAGE_CONFIG.blockfrostUrl,
      network: 'Preprod',
      compiledScriptCbor: '5901',
      threadNftPolicyId: PAGE_CONFIG.threadNftPolicyId,
      referenceScript: PAGE_CONFIG.referenceScript,
      launchId: new Uint8Array([0x0a, 0xff]),
    });
    expect(walletApi).toBe(wallet);
    expect(params).toBe(PARAMS);
  });

  it('refuses a launch id that is not hex', async () => {
    widget.configure(PAGE_CONFIG);
    await expect(widget.claim({ launchIdHex: 'xyz', walletApi: {}, params: PARAMS })).rejects.toThrow(/not hex/);
    expect(flowed).not.toHaveBeenCalled();
  });
});
