// Every validator is unparameterized, so one script address holds every
// launch's UTXO of that kind and anyone can add another. These cover the two
// things that makes necessary: authenticate by the thread NFT rather than by a
// datum's own claim, and refuse rather than choose when two UTXOs both answer.

import { describe, expect, it, vi } from 'vitest';
import { threadNftAssetName } from '../launch-schemas.js';
import { selectLaunchUtxo } from '../launch-utxo-lookup.js';

// Only `Data.from` is replaced — the fixtures below are already decoded, and a
// real CBOR decode is not what these tests are about. The rest of the module
// has to stay real, because launch-schemas builds its shapes out of Data.Object
// and friends the moment it is imported.
vi.mock('@lucid-evolution/lucid', async () => {
  const actual = await vi.importActual<typeof import('@lucid-evolution/lucid')>('@lucid-evolution/lucid');
  return { ...actual, Data: { ...actual.Data, from: (datum: unknown) => datum } };
});

const LAUNCH = 'a1'.repeat(32);
const OTHER_LAUNCH = 'b2'.repeat(32);
const POLICY = 'c0ffee'.padEnd(56, '0');
const FORGER_POLICY = 'dead'.padEnd(56, '0');
const ADDRESS = 'addr_test1shared';

const unitFor = (policy: string, launch: string) => policy + threadNftAssetName('bondingCurve', launch);

function utxo(opts: {
  launch?: string;
  policy?: string;
  assets?: Record<string, bigint>;
  ref?: string;
  datum?: unknown;
}) {
  const launch = opts.launch ?? LAUNCH;
  const policy = opts.policy ?? POLICY;
  return {
    txHash: opts.ref ?? '00'.repeat(32),
    outputIndex: 0,
    address: ADDRESS,
    assets: opts.assets ?? { [unitFor(policy, launch)]: 1n },
    // `in` rather than `??`, so a test can hand over an explicitly absent
    // datum without it being read as "not specified" and replaced.
    datum: 'datum' in opts ? opts.datum : { launch_id: launch, thread_nft_policy: policy },
  } as never;
}

const find = (utxos: unknown[], expectedPolicy: string) =>
  selectLaunchUtxo<{ launch_id: string; thread_nft_policy: string }>(
    utxos as never,
    ADDRESS,
    LAUNCH,
    'bondingCurve',
    {},
    expectedPolicy,
  );

describe('selectLaunchUtxo', () => {
  it('returns the launch’s own UTXO', () => {
    const found = find([utxo({ launch: OTHER_LAUNCH }), utxo({})], POLICY);
    expect(found.datum.launch_id).toBe(LAUNCH);
  });

  it('ignores a UTXO that claims the launch but carries no thread NFT', () => {
    // The datum alone is a claim, not evidence: anyone may pay a datum of any
    // shape to a shared script address.
    expect(() => find([utxo({ assets: {} })], POLICY)).toThrow(/carries launch/);
  });

  it('ignores a thread NFT minted for a different role', () => {
    const wrongRole = POLICY + threadNftAssetName('vesting', LAUNCH);
    expect(() => find([utxo({ assets: { [wrongRole]: 1n } })], POLICY)).toThrow(/carries launch/);
  });

  it('ignores another launch’s UTXO at the same address', () => {
    expect(() => find([utxo({ launch: OTHER_LAUNCH })], POLICY)).toThrow(/carries launch/);
  });

  // The one that matters, and what the caller-supplied policy changed. A forger
  // can mint under their OWN policy and satisfy a token check derived from the
  // datum — so when the expectation came from the datum, the planted UTXO
  // matched alongside the real one and the lookup could only refuse. Told which
  // policy is genuine, it now resolves instead of stopping.
  it('returns the genuine UTXO when a forged one is planted beside it', () => {
    const genuine = utxo({ ref: '11'.repeat(32) });
    const planted = utxo({ ref: '22'.repeat(32), policy: FORGER_POLICY });
    const found = find([genuine, planted], POLICY);
    expect(found.utxo.txHash).toBe('11'.repeat(32));
    expect(found.datum.thread_nft_policy).toBe(POLICY);
  });

  it('resolves the same pair whichever order the provider returns them in', () => {
    // `utxosAt` ordering is not attacker-proof, and the previous shape took the
    // first match — so order deciding the answer is the exact failure here.
    const genuine = utxo({ ref: '11'.repeat(32) });
    const planted = utxo({ ref: '22'.repeat(32), policy: FORGER_POLICY });
    expect(find([planted, genuine], POLICY).utxo.txHash).toBe('11'.repeat(32));
    expect(find([genuine, planted], POLICY).utxo.txHash).toBe('11'.repeat(32));
  });

  it('ignores a UTXO whose datum names a policy the caller does not expect', () => {
    expect(() => find([utxo({ policy: FORGER_POLICY })], POLICY)).toThrow(/carries launch/);
  });

  it('ignores a UTXO holding the genuine token whose datum names another policy', () => {
    // Datum and value disagreeing is not a UTXO to reason about.
    expect(() =>
      find(
        [
          {
            txHash: '33'.repeat(32),
            outputIndex: 0,
            address: ADDRESS,
            assets: { [unitFor(POLICY, LAUNCH)]: 1n },
            datum: { launch_id: LAUNCH, thread_nft_policy: FORGER_POLICY },
          } as never,
        ],
        POLICY,
      ),
    ).toThrow(/carries launch/);
  });

  // The refusal still has to exist. It is unreachable while the thread NFT is
  // minted by a one-shot policy, and that is a property of the minting policy
  // rather than of this module — so the module keeps its own guard.
  it('still refuses when two UTXOs both carry the genuine token', () => {
    const one = utxo({ ref: '11'.repeat(32) });
    const two = utxo({ ref: '22'.repeat(32) });
    expect(() => find([one, two], POLICY)).toThrow(/Refusing to guess/);
  });

  it('names both candidates so the ambiguity can be investigated', () => {
    const one = utxo({ ref: '11'.repeat(32) });
    const two = utxo({ ref: '22'.repeat(32) });
    expect(() => find([one, two], POLICY)).toThrow(new RegExp(`${'11'.repeat(32)}#0.*${'22'.repeat(32)}#0`));
  });

  describe('the expected policy is required, and must be a real one', () => {
    // An empty string concatenated with an asset name is a unit no UTXO holds,
    // so without this the lookup would report "never minted" for what is really
    // a caller that forgot to pass anything — and the two need to stay apart.
    it.each([
      ['empty', ''],
      ['too short', 'c0ffee'],
      ['not hex', 'z'.repeat(56)],
      ['undefined', undefined as unknown as string],
    ])('rejects a %s policy, naming what it needed', (_label, bad) => {
      expect(() => find([utxo({})], bad)).toThrow(/expected policy id/);
    });

    it('accepts the policy in upper case', () => {
      expect(find([utxo({})], POLICY.toUpperCase()).datum.launch_id).toBe(LAUNCH);
    });
  });

  it('skips a UTXO with no datum at all', () => {
    expect(() => find([utxo({ datum: null })], POLICY)).toThrow(/carries launch/);
  });
});
