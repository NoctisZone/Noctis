// Tests for cardano-cto-sybil-challenge-submitter.ts's
// CardanoCtoSybilChallengeSubmitter — two real Cardano transactions with two
// different signers: submitChallenge (challenger-wallet-signed, no
// validator spend) and resolveChallenge (governor-signed, spends the
// challenge UTXO and pays out per the Upheld/Rejected split the validator
// itself enforces). Same importOriginal partial-mock strategy as the other
// Lucid submitter tests — only Lucid() and Data.from/to are swapped;
// getAddressDetails/credentialToAddress stay real (pure, deterministic
// address<->credential derivation), so real bech32 addresses are used
// throughout rather than opaque strings.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return {
    ...actual,
    Lucid: vi.fn(),
    Data: {
      ...actual.Data,
      from: vi.fn((d: unknown) => d),
      to: vi.fn((d: unknown) => d),
    },
  };
});

import { credentialToAddress, Lucid, validatorToScriptHash } from '@lucid-evolution/lucid';
import type { ResolveChallengeParams, SubmitChallengeParams } from '../cardano-cto-sybil-challenge-submitter.js';
import { CardanoCtoSybilChallengeSubmitter, toHex } from '../cardano-cto-sybil-challenge-submitter.js';

// The challenge token, derived the way the submitter derives it: the policy is
// the script's OWN hash, because `mint` and `spend` are two handlers of one
// Aiken validator. Nobody else can mint this — which is what makes it evidence
// rather than a claim.
const SCRIPT_HASH = validatorToScriptHash({ type: 'PlutusV3', script: '590000' });
const CHALLENGE_UNIT = SCRIPT_HASH + Buffer.from('sybil', 'utf8').toString('hex');

function fakeBytes(fill: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(fill);
}
function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}

function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const payToAddressCalls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
    return builder;
  });
  // These builders now set a validity range, because the redeemers they build
  // bind their timestamp to it. Recorded like every other call so a test can
  // assert the range actually brackets the timestamp it sent.
  builder.validFrom = vi.fn((...a: unknown[]) => {
    calls.validFrom = a;
    return builder;
  });
  builder.validTo = vi.fn((...a: unknown[]) => {
    calls.validTo = a;
    return builder;
  });
  builder.attach = {
    SpendingValidator: vi.fn((...a: unknown[]) => {
      calls.attachSpendingValidator = a;
      return builder;
    }),
    // Both paths attach this now: the mint on submit is what makes a deposit
    // resolvable at all, and the burn on resolve is required by `spend`.
    MintingPolicy: vi.fn((...a: unknown[]) => {
      calls.attachMintingPolicy = a;
      return builder;
    }),
  };
  builder.mintAssets = vi.fn((...a: unknown[]) => {
    calls.mintAssets = a;
    return builder;
  });
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      calls.payToContract = a;
      return builder;
    }),
    ToAddress: vi.fn((...a: unknown[]) => {
      payToAddressCalls.push(a);
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.complete = vi.fn().mockResolvedValue({
    sign: {
      withWallet: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('sybil-tx-1'),
        }),
      }),
      withPrivateKey: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('sybil-tx-1'),
        }),
      }),
    },
  });
  return { builder, calls, payToAddressCalls };
}

interface FixtureUtxo {
  datum: unknown;
  assets: Record<string, bigint>;
  /** Opt out of the challenge token, to describe a deposit made without one. */
  noChallengeToken?: boolean;
  txHash?: string;
}

/**
 * A real challenge UTXO carries the challenge token — the mint handler puts it
 * there, and `spend` refuses to settle an input without it. A fixture without
 * one describes a deposit the chain can never resolve.
 */
function asChainUtxos(utxos: FixtureUtxo[] | undefined) {
  return (utxos ?? []).map((u, i) => ({
    txHash: u.txHash ?? i.toString(16).padStart(2, '0').repeat(32),
    outputIndex: 0,
    ...u,
    assets: u.noChallengeToken ? u.assets : { [CHALLENGE_UNIT]: 1n, ...u.assets },
  }));
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  opts: {
    utxos?: FixtureUtxo[];
    walletAddress?: string;
    governorPrivateKey?: string;
  } = {},
) {
  const fakeLucid = {
    selectWallet: { fromAPI: vi.fn(), fromPrivateKey: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(asChainUtxos(opts.utxos)),
    wallet: () => ({
      address: vi.fn().mockResolvedValue(opts.walletAddress ?? addrFor(fakeKeyHash(0xaa))),
    }),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return {
    submitter: new CardanoCtoSybilChallengeSubmitter({
      blockfrostProjectId: 'proj',
      blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      network: 'Preprod',
      compiledScriptCbor: '590000',
      governorPrivateKey: opts.governorPrivateKey,
    }),
    fakeLucid,
  };
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

function baseSubmitParams(overrides: Partial<SubmitChallengeParams> = {}): SubmitChallengeParams {
  return {
    launchId: fakeBytes(1),
    governorPubKeyHash: fakeBytes(2),
    challengedVoterKey: fakeBytes(3),
    challengedProposalId: fakeBytes(4),
    bondAmountLovelace: 25_000_000n,
    evidenceHash: fakeBytes(5),
    treasuryPubKeyHash: fakeBytes(6),
    opsPubKeyHash: fakeBytes(7),
    ...overrides,
  };
}

describe('CardanoCtoSybilChallengeSubmitter.submitChallenge', () => {
  it('throws when the connected wallet has no resolvable payment key hash', async () => {
    const { builder } = makeFakeTxBuilder();
    // A REAL reward address: it parses cleanly and its paymentCredential is
    // genuinely undefined, which is the one shape that reaches the guard.
    //
    // This test previously used a malformed address, which Lucid's own parser
    // rejected first — so it passed on 'No address type matched' and never
    // reached the submitter's check at all. Asserting the message is what
    // makes the difference visible; a bare assertion cannot tell the two
    // apart, and did not.
    const { submitter } = makeSubmitter(builder, {
      walletAddress: 'stake_test1uqqt6jvxvg4z4j7cq790uwklt9ja50ng85dwzz265xfljkcvqc5xh',
    });

    await expect(submitter.submitChallenge({} as never, baseSubmitParams())).rejects.toThrow(
      /no resolvable payment key hash/,
    );
  });

  it('deposits the bond at the script address with the correct datum, no SpendingValidator attach (deposit needs no redeemer)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const challengerKeyHash = fakeKeyHash(0xbb);
    const { submitter } = makeSubmitter(builder, {
      walletAddress: addrFor(challengerKeyHash),
    });

    const params = baseSubmitParams({ bondAmountLovelace: 25_000_000n });
    const result = await submitter.submitChallenge({} as never, params);

    expect(result.txHash).toBe('sybil-tx-1');
    expect(calls.attachSpendingValidator).toBeUndefined();
    expect(calls.collectFrom).toBeUndefined();

    const [, payload, assets] = calls.payToContract as [
      string,
      { value: Record<string, unknown> },
      Record<string, bigint>,
    ];
    expect(assets.lovelace).toBe(25_000_000n);
    expect(payload.value.challenger_key_hash).toBe(challengerKeyHash);
    expect(payload.value.launch_id).toBe(toHex(params.launchId));
    expect(payload.value.evidence_hash).toBe(toHex(params.evidenceHash));
    expect(payload.value.bond_amount).toBe(25_000_000n);
  });

  it("signs via selectWallet.fromAPI with the challenger's own wallet, not a fixed key", async () => {
    const { builder } = makeFakeTxBuilder();
    const walletApi = { __marker: 'challenger-wallet' };
    const { submitter, fakeLucid } = makeSubmitter(builder);

    await submitter.submitChallenge(walletApi as never, baseSubmitParams());
    expect(fakeLucid.selectWallet.fromAPI).toHaveBeenCalledWith(walletApi);
  });

  // Without these the deposit still builds and still submits — and can never
  // be resolved, because `spend` requires this token on the input it settles.
  // The bond goes in and has no way out, which is the failure these pin.
  it('mints the challenge token, so the deposit can be resolved at all', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder);

    await submitter.submitChallenge({} as never, baseSubmitParams());

    const [minted] = calls.mintAssets as [Record<string, bigint>, string];
    expect(minted[CHALLENGE_UNIT]).toBe(1n);
    expect(calls.attachMintingPolicy).toBeDefined();
  });

  it('puts the token on the challenge output, not in the challenger’s wallet', async () => {
    // `spend` looks for it on the input it settles, so a token minted into the
    // challenger's own change output would satisfy the mint and nothing else.
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder);

    await submitter.submitChallenge({} as never, baseSubmitParams({ bondAmountLovelace: 25_000_000n }));

    const [, , assets] = calls.payToContract as [string, unknown, Record<string, bigint>];
    expect(assets[CHALLENGE_UNIT]).toBe(1n);
    // Exactly the bond, no more: the mint handler compares the output's
    // lovelace against the datum's bond_amount for equality.
    expect(assets.lovelace).toBe(25_000_000n);
  });

  it('brackets submitted_at in a validity range the mint handler will accept', async () => {
    // The mint handler requires the declared timestamp to fall inside the
    // range AND the range to be no wider than 600_000ms — `interval.contains`
    // alone would let a caller widen it and pick any time they liked.
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder);

    await submitter.submitChallenge({} as never, baseSubmitParams());

    const [, payload] = calls.payToContract as [string, { value: { submitted_at: bigint } }];
    const submittedAt = Number(payload.value.submitted_at);
    const [validFrom] = calls.validFrom as [number];
    const [validTo] = calls.validTo as [number];
    expect(validFrom).toBeLessThanOrEqual(submittedAt);
    expect(validTo).toBeGreaterThanOrEqual(submittedAt);
    expect(validTo - validFrom).toBeLessThanOrEqual(600_000);
  });
});

describe('CardanoCtoSybilChallengeSubmitter.resolveChallenge', () => {
  const challengerKeyHash = fakeKeyHash(0xcc);
  const payoutKeyHash = fakeKeyHash(0xdd);

  function challengeDatum(overrides: Record<string, unknown> = {}) {
    return {
      launch_id: toHex(fakeBytes(1)),
      governor_pub_key_hash: toHex(fakeBytes(2)),
      challenged_voter_key: toHex(fakeBytes(3)),
      challenged_proposal_id: toHex(fakeBytes(4)),
      challenger_key_hash: challengerKeyHash,
      bond_amount: 25_000_000n,
      submitted_at: 1000n,
      evidence_hash: toHex(fakeBytes(5)),
      payout_pub_key_hash: payoutKeyHash,
      ...overrides,
    };
  }

  function baseResolveParams(overrides: Partial<ResolveChallengeParams> = {}): ResolveChallengeParams {
    return {
      launchId: fakeBytes(1),
      challengedVoterKey: fakeBytes(3),
      challengedProposalId: fakeBytes(4),
      upheld: true,
      currentTimestamp: 5000n,
      ...overrides,
    };
  }

  it('throws when governorPrivateKey was not configured', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      utxos: [{ datum: challengeDatum(), assets: {} }],
    });

    await expect(submitter.resolveChallenge(baseResolveParams())).rejects.toThrow(/requires governorPrivateKey/);
  });

  it('throws when no open challenge UTXO matches the voter/proposal pair', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [
        {
          datum: challengeDatum({ challenged_voter_key: toHex(fakeBytes(99)) }),
          assets: {},
        },
      ],
    });

    await expect(submitter.resolveChallenge(baseResolveParams())).rejects.toThrow(
      /No open cto_sybil_challenge UTXO carrying the challenge token/,
    );
  });

  it('Upheld: pays the FULL bond back to the challenger', async () => {
    const { builder, payToAddressCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [{ datum: challengeDatum({ bond_amount: 25_000_000n }), assets: {} }],
    });

    const result = await submitter.resolveChallenge(baseResolveParams({ upheld: true }));

    expect(result.txHash).toBe('sybil-tx-1');
    expect(payToAddressCalls).toHaveLength(1);
    const [addr, assets] = payToAddressCalls[0] as [string, Record<string, bigint>];
    expect(addr).toBe(addrFor(challengerKeyHash));
    expect(assets.lovelace).toBe(25_000_000n);
  });

  it('Rejected: pays the WHOLE bond to the one address the datum names', async () => {
    const { builder, payToAddressCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      // An odd amount, because the arithmetic this replaced floored a share
      // and handed the remainder to a second address. Nothing rounds now, and
      // an amount that does not divide by 100 is where that would show.
      utxos: [{ datum: challengeDatum({ bond_amount: 999n }), assets: {} }],
    });

    await submitter.resolveChallenge(baseResolveParams({ upheld: false }));

    expect(payToAddressCalls).toHaveLength(1);
    const [payoutAddr, payoutAssets] = payToAddressCalls[0] as [string, Record<string, bigint>];
    expect(payoutAddr).toBe(addrFor(payoutKeyHash));
    expect(payoutAssets.lovelace).toBe(999n);
  });

  it('builds the ResolveChallenge redeemer with upheld/current_timestamp and requires the governor as signer', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [{ datum: challengeDatum(), assets: {} }],
    });

    await submitter.resolveChallenge(baseResolveParams({ upheld: false, currentTimestamp: 12345n }));

    const redeemer = calls.collectFrom![1] as {
      upheld: boolean;
      current_timestamp: bigint;
    };
    expect(redeemer.upheld).toBe(false);
    expect(redeemer.current_timestamp).toBe(12345n);
    expect(calls.addSigner).toEqual([toHex(fakeBytes(2))]); // datum.governor_pub_key_hash
  });

  // cto_sybil_challenge.ak is unparameterized, so every challenge across every
  // launch shares one address and its datum is written by whoever paid it
  // there. These pin the token half of that, on both sides of the pair.
  it('burns the challenge token, which `spend` requires of the same transaction', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [{ datum: challengeDatum(), assets: {} }],
    });

    await submitter.resolveChallenge(baseResolveParams());

    const [minted] = calls.mintAssets as [Record<string, bigint>, string];
    expect(minted[CHALLENGE_UNIT]).toBe(-1n);
    expect(calls.attachMintingPolicy).toBeDefined();
  });

  it('refuses a deposit that never minted the token', async () => {
    // Exactly what the builder used to produce: a bond and a datum, nothing
    // else. The chain cannot settle it, so neither will this.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [{ datum: challengeDatum(), assets: {}, noChallengeToken: true }],
    });

    await expect(submitter.resolveChallenge(baseResolveParams())).rejects.toThrow(/carrying the challenge token/);
  });

  it('refuses to choose when two open challenges name the same voter and proposal', async () => {
    // The asset name is shared by every challenge, so both carry a genuine
    // token and neither is distinguishable by it. A decoy could otherwise
    // absorb a resolution — and its payout — meant for the real one.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [
        { datum: challengeDatum(), assets: {}, txHash: '11'.repeat(32) },
        { datum: challengeDatum({ bond_amount: 1_000_000n }), assets: {}, txHash: '22'.repeat(32) },
      ],
    });

    await expect(submitter.resolveChallenge(baseResolveParams())).rejects.toThrow(/Refusing to guess/);
  });
});
