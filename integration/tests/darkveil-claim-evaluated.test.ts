// A DarkVeil claim from a browser wallet, judged by the real curve validator.
//
// The buyer's connected wallet reaches the curve as a CIP-30 object, and the
// claim names the published curve script, which Mesh builds against. Here the
// wallet is a CIP-30 stand-in over coins held in memory, the curve and its
// reference script are served from memory, the allocation is a real tree, and
// Mesh's offline evaluator (Scalus) runs the compiled curve validator against
// the claim the submitter builds. A claim that comes back with a measured
// budget has been accepted by it; one with a wrong salt must not.
//
// Lucid is replaced only where the submitter reads the chain (the curve UTXO
// and the wallet's address), and Mesh's Blockfrost provider only by the
// in-memory one. Everything between — the pricing, the cap proof, the
// continuing datum, the payout and its tag, the referenced build, the wallet's
// coin selection and collateral — is the code a browser runs.

import { Data, type UTxO } from '@lucid-evolution/lucid';
import type { UTxO as MeshUTxO } from '@meshsdk/core';
import { Address, deserializeTx, toTxUnspentOutput } from '@meshsdk/core-cst';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chain: { curve: UTxO | null; provider: unknown } = { curve: null, provider: null };

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return {
    ...actual,
    Blockfrost: vi.fn(),
    Lucid: vi.fn(async () => ({
      selectWallet: { fromAPI: vi.fn() },
      utxosAt: async () => (chain.curve ? [chain.curve] : []),
      // The buyer's wallet address, which pays from the same key it signs with.
      wallet: () => ({ address: async () => (await import('./support/takeover-chain.js')).PAYER_ADDRESS }),
    })),
  };
});

vi.mock('@meshsdk/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meshsdk/core')>();
  return {
    ...actual,
    // The submitter makes its own provider from the page's Blockfrost URL;
    // here that provider is the in-memory chain.
    BlockfrostProvider: class {
      constructor() {
        // biome-ignore lint/correctness/noConstructorReturn: stands the in-memory provider in for Blockfrost's
        return chain.provider as never;
      }
    },
  };
});

import { CapAccumulator } from '../cap-accumulator-tree.js';
import { testBit } from '../claim-bitmap.js';
import { buildDvAllocationTree } from '../dv-allocation-tree.js';
import { buildGenesisDatums } from '../genesis-datums.js';
import {
  type BondingCurveTierBDatumData,
  BondingCurveTierBDatumSchema,
  threadNftAssetName,
} from '../launch-schemas.js';
import { scriptHashOf } from '../reference-script.js';
import { LucidTierBCurveSubmitter } from '../tier-b-curve-submitter.js';
import {
  at,
  BLUEPRINT,
  COLLATERAL,
  datumCborAt,
  evaluatingProvider,
  FUNDS,
  launchScript,
  PAYER,
  PAYER_ADDRESS,
  quantityIn,
  referenceOutput,
} from './support/takeover-chain.js';

const CURVE = launchScript('bonding_curve_tier_b.bonding_curve_tier_b.spend');
const TOKEN_POLICY = '33'.repeat(28);
const THREAD_POLICY = '44'.repeat(28);

const genesis = await buildGenesisDatums({
  blueprint: BLUEPRINT as never,
  network: 'preprod',
  tier: 'B',
  creatorPubKeyHashHex: '11'.repeat(28),
  governorPubKeyHashHex: '22'.repeat(28),
  bondPayoutPubKeyHashHex: '55'.repeat(28),
  tokenPolicyIdHex: TOKEN_POLICY,
  tokenBaseNameHex: Buffer.from('VEILD').toString('hex'),
  tokenName: 'Veiled',
  tokenDescription: 'A launch whose DarkVeil buyers claim from the browser.',
  threadNftPolicyIdHex: THREAD_POLICY,
  poolNftPolicyIdHex: '66'.repeat(28),
  basePrice: 3,
  maxPrice: 75,
  creatorAllocPct: 5,
  vestDays: 180,
  genesisTimestampMs: 1_785_000_000_000,
  batcherAllowlistHex: ['ba'.repeat(28)],
});
const TOKEN = TOKEN_POLICY + genesis.tokenAssetNameHex;
const CURVE_THREAD = THREAD_POLICY + threadNftAssetName('bondingCurveTierB', genesis.launchIdHex);
const CURVE_REF = referenceOutput(CURVE, 0xd1);

// Three buyers, the connected wallet among them. Its index is wherever the
// tree's own ordering puts it, which is the index the claim must use.
const BUYER_VKH = Uint8Array.from(Buffer.from(PAYER, 'hex'));
const BUYER_SALT = new Uint8Array(32).fill(0x5a);
const DV_AMOUNT = 1_000_000n;
const TREE = buildDvAllocationTree([
  { vkh: BUYER_VKH, dvAmount: DV_AMOUNT, salt: BUYER_SALT },
  { vkh: new Uint8Array(28).fill(0x71), dvAmount: 2_000_000n, salt: new Uint8Array(32).fill(0x01) },
  { vkh: new Uint8Array(28).fill(0x72), dvAmount: 3_000_000n, salt: new Uint8Array(32).fill(0x02) },
]);
const LEAF = TREE.leafIndexOf(BUYER_VKH);

/** The curve inside its claim window, opened an hour ago, nobody claimed yet. */
function claimWindowCurve(): UTxO {
  const base = Data.from<BondingCurveTierBDatumData>(genesis.datums.bondingCurve, BondingCurveTierBDatumSchema);
  const datum: BondingCurveTierBDatumData = {
    ...base,
    curve_state: 'DvClaim',
    dv_settled: true,
    dv_allocation_root: Buffer.from(TREE.root).toString('hex'),
    dv_claim_opened_at: BigInt(Date.now() - 3_600_000),
    claimed_bits: '00',
  };
  return {
    txHash: 'd0'.repeat(32),
    outputIndex: 0,
    address: at(CURVE),
    assets: {
      lovelace: 5_000_000n,
      [CURVE_THREAD]: 1n,
      [TOKEN]: datum.curve_supply + datum.lp_reserve_tokens + datum.staking_reserve_tokens,
    },
    datum: Data.to<BondingCurveTierBDatumData>(datum, BondingCurveTierBDatumSchema),
  };
}

function mesh(u: UTxO): MeshUTxO {
  return {
    input: { txHash: u.txHash, outputIndex: u.outputIndex },
    output: {
      address: u.address,
      amount: Object.entries(u.assets).map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
      ...(u.datum ? { plutusData: u.datum } : {}),
    },
  };
}

/** A CIP-30 wallet over in-memory coins. It signs nothing; evaluation needs no signature. */
function cip30Wallet(signed: string[]) {
  const addressHex = Address.fromBech32(PAYER_ADDRESS).toBytes();
  return {
    getUtxos: async () => [COLLATERAL, FUNDS].map((u) => toTxUnspentOutput(u).toCbor()),
    getChangeAddress: async () => addressHex,
    signTx: async (tx: string) => {
      signed.push(tx);
      return 'a0';
    },
    submitTx: async () => 'ca'.repeat(32),
  };
}

function submitter(): LucidTierBCurveSubmitter {
  return new LucidTierBCurveSubmitter({
    blockfrostProjectId: '',
    blockfrostUrl: 'https://noctis.example/wp-json/np/v1/blockfrost-proxy',
    network: 'Preprod',
    compiledScriptCbor: CURVE,
    launchIdHex: genesis.launchIdHex,
    threadNftPolicyId: THREAD_POLICY,
    referenceScript: { txHash: CURVE_REF.input.txHash, outputIndex: 0, scriptHash: scriptHashOf(CURVE) },
  });
}

function params(salt: Uint8Array = BUYER_SALT) {
  return {
    dvAmount: DV_AMOUNT,
    salt,
    merkleProof: TREE.getProof(LEAF),
    buyerKeyHash: BUYER_VKH,
    leafIndex: LEAF,
  };
}

beforeEach(() => {
  chain.curve = claimWindowCurve();
  chain.provider = evaluatingProvider([COLLATERAL, FUNDS, CURVE_REF, mesh(chain.curve)]);
});

describe('a DarkVeil claim from a browser wallet, by the published script', () => {
  it('is accepted by the compiled curve validator', async () => {
    const signed: string[] = [];
    const result = await submitter().claimDarkVeilTokensWithWallet(
      cip30Wallet(signed) as never,
      params(),
      new CapAccumulator(),
    );
    expect(result.txHash).toBe('ca'.repeat(32));
    expect(signed).toHaveLength(1);

    const tx = deserializeTx(signed[0] as string);
    const redeemers = tx.witnessSet().redeemers()?.toCore() ?? [];
    expect(redeemers).toHaveLength(1);
    expect(Number(redeemers[0]?.executionUnits.memory)).toBeGreaterThan(0);
    // Named, not carried: the transaction holds no script of its own.
    expect(tx.witnessSet().plutusV3Scripts()?.size() ?? 0).toBe(0);
    expect(
      tx
        .body()
        .referenceInputs()
        ?.toCore()
        .map((r) => r.txId),
    ).toContain(CURVE_REF.input.txHash);
    // The buyer's key is the one the transaction requires.
    expect(tx.body().requiredSigners()?.toCore()).toEqual([PAYER]);
  });

  it('delivers the allocation and marks it claimed, in the state it leaves', async () => {
    const signed: string[] = [];
    await submitter().claimDarkVeilTokensWithWallet(cip30Wallet(signed) as never, params(), new CapAccumulator());
    const txHex = signed[0] as string;
    const outputs = deserializeTx(txHex).body().outputs();
    const curveAt = outputs.findIndex((o) => o.address().toBech32() === at(CURVE));
    const buyerAt = outputs.findIndex(
      (o, i) => i !== curveAt && o.address().toBech32() === PAYER_ADDRESS && quantityIn(txHex, i, TOKEN) > 0n,
    );
    expect(quantityIn(txHex, buyerAt, TOKEN)).toBe(DV_AMOUNT);
    const after = Data.from<BondingCurveTierBDatumData>(datumCborAt(txHex, curveAt), BondingCurveTierBDatumSchema);
    expect(after.tokens_sold).toBe(DV_AMOUNT);
    expect(testBit(after.claimed_bits, LEAF)).toBe(true);
  });

  it('is refused by the validator when the allocation does not prove', async () => {
    // One byte of the salt changed: the leaf no longer hashes to anything in
    // the root, which only the validator checks.
    const wrong = BUYER_SALT.slice();
    wrong[0] ^= 1;
    await expect(
      submitter().claimDarkVeilTokensWithWallet(cip30Wallet([]) as never, params(wrong), new CapAccumulator()),
    ).rejects.toThrow(/Tx evaluation failed/);
  });
});
