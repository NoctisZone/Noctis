// ============================================================================
// Noctis Zone — Blockfrost API Client
// ============================================================================
// Replaces mock launch data with live Cardano blockchain data via Blockfrost.
// Used by the WordPress frontend and the Noctis API server to display:
//   - Active launches (token mints, bonding curve UTxOs)
//   - Graduated tokens (DEX pool data, LP escrow status)
//   - Creator escrow vesting progress
//   - CTO governance anchor state
//   - ZK certificate anchors
//
// Environment variables:
//   BLOCKFROST_API_KEY  — Blockfrost project key
//   BLOCKFROST_NETWORK  — "preview" | "preprod" | "mainnet" (default: preprod)
//
// Rate limits:
//   Free tier: 10 req/s, 50,000 req/day
//   Paid tier: 100 req/s, 500,000 req/day
//   This client includes automatic rate limiting and retry logic.
// ============================================================================

const BLOCKFROST_BASE_URLS: Record<string, string> = {
  preview: 'https://cardano-preview.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
  mainnet: 'https://cardano.blockfrost.io/api/v0',
};

const RATE_LIMIT_DELAY_MS = 100; // 10 req/s
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ============================================================================
// TYPES
// ============================================================================

export interface BlockfrostConfig {
  apiKey: string;
  network: 'preview' | 'preprod' | 'mainnet';
}

export interface AddressUtxo {
  tx_hash: string;
  tx_index: number;
  output_index: number;
  amount: Array<{ unit: string; quantity: string }>;
  address: string;
  data_hash: string | null;
  inline_datum: string | null;
  reference_script_hash: string | null;
}

export interface AssetMetadata {
  name: string;
  ticker?: string;
  description?: string;
  logo?: string;
  url?: string;
  decimals?: number;
}

export interface AssetInfo {
  asset: string;
  policy_id: string;
  asset_name: string;
  fingerprint: string;
  quantity: string;
  initial_mint_tx_hash: string;
  mint_or_burn_count: number;
  onchain_metadata: AssetMetadata | null;
  metadata: AssetMetadata | null;
}

export interface TxMetadata {
  tx_hash: string;
  metadata: Array<{ label: string; json_metadata: unknown }>;
}

// Real Blockfrost `/addresses/{address}` response shape (fields we use only).
// `stake_address` is nullable — null for Byron addresses and enterprise
// addresses (no staking part encoded in the address itself).
export interface AddressInfo {
  address: string;
  stake_address: string | null;
  type: 'byron' | 'shelley';
}

// Real Blockfrost `/addresses/{address}/transactions` response shape.
export interface AddressTransaction {
  tx_hash: string;
  tx_index: number;
  block_height: number;
  block_time: number;
}

// Real Blockfrost `/txs/{hash}/utxos` response shape (fields we use only).
/** A transaction's place in the chain: its block, and its index within it. */
export interface TxPosition {
  block_height: number;
  index: number;
}

export interface TxUtxos {
  hash: string;
  inputs: Array<{
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    /** The output this input spends — how a UTXO chain is walked backward. */
    tx_hash?: string;
    output_index?: number;
    /** The datum of the UTXO being SPENT: the state as it stood before. */
    inline_datum?: string | null;
    /**
     * Blockfrost returns reference and collateral entries in this same array,
     * flagged. A reference input is never spent, so anything walking inputs as
     * evidence of what a transaction consumed has to drop both.
     */
    reference?: boolean;
    collateral?: boolean;
  }>;
  outputs: Array<{
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    output_index?: number;
    inline_datum?: string | null;
    /** True for a collateral return output, which a successful spend has none of. */
    collateral?: boolean;
  }>;
}

export interface EpochInfo {
  epoch: number;
  begin_time: string;
  end_time: string;
  first_block_time: number;
  last_block_time: number;
}

export interface BlockInfo {
  time: number;
  height: number;
  hash: string;
  slot: number;
  epoch: number;
  epoch_slot: number;
  slot_leader: string;
  size: number;
  tx_count: number;
  output: string;
  fees: string;
  block_vrf: string;
}

// Noctis-specific types
export interface NoctisLaunchData {
  launchId: string;
  tokenPolicyId: string;
  tokenName: string;
  tokenTicker: string;
  tokenDescription: string;
  tokenLogo: string | null;
  creatorAddress: string;
  tier: 'A' | 'B' | 'C';
  state: 'darkveil' | 'curve' | 'graduated' | 'cancelled';
  graduationTimestamp: number | null;
  lpEscrowLocked: boolean;
  lpEscrowLockedUntil: number | null;
  ctoTriggered: boolean;
  zkCertAnchored: boolean;
  zkCertHash: string | null;
  totalSupply: string;
  currentPrice: string | null;
  tokensSold: string | null;
  tokensRemaining: string | null;
  raisedAda: string | null;
}

// ============================================================================
// BLOCKFROST CLIENT
// ============================================================================

export class BlockfrostClient {
  private baseUrl: string;
  private apiKey: string;
  private lastRequestTime = 0;

  constructor(config: BlockfrostConfig) {
    this.baseUrl = BLOCKFROST_BASE_URLS[config.network] ?? BLOCKFROST_BASE_URLS.preprod;
    this.apiKey = config.apiKey;
  }

  // --- Core request method with rate limiting + retry ---

  private async request<T>(path: string, retries: number = MAX_RETRIES): Promise<T> {
    // Rate limit: ensure at least RATE_LIMIT_DELAY_MS between requests
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < RATE_LIMIT_DELAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS - elapsed));
    }

    try {
      this.lastRequestTime = Date.now();
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          project_id: this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 429) {
        // Rate limited — wait and retry
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          return this.request<T>(path, retries - 1);
        }
        throw new Error('Blockfrost rate limit exceeded');
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Blockfrost API error ${response.status}: ${error}`);
      }

      return response.json() as Promise<T>;
    } catch (err) {
      if (retries > 0 && err instanceof TypeError) {
        // Network error — retry
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        return this.request<T>(path, retries - 1);
      }
      throw err;
    }
  }

  // --- Address UTxOs ---

  /**
   * One page of UTXOs at an address.
   *
   * `order` matters more than it looks on any long-lived address. Blockfrost
   * defaults to ascending, so page 1 is the OLDEST hundred — which for an
   * address that has been written to for years returns historical UTXOs and
   * never the current ones. Anything reading present state (an oracle's latest
   * publication, say) must ask for 'desc'.
   */
  async getAddressUtxos(address: string, order: 'asc' | 'desc' = 'asc'): Promise<AddressUtxo[]> {
    return this.request<AddressUtxo[]>(`/addresses/${address}/utxos?order=${order}`);
  }

  async getAddressUtxosAll(address: string): Promise<AddressUtxo[]> {
    // Paginate through all UTxOs (100 per page)
    let allUtxos: AddressUtxo[] = [];
    let page = 1;
    while (true) {
      const batch = await this.request<AddressUtxo[]>(`/addresses/${address}/utxos?page=${page}&order=asc`);
      allUtxos = allUtxos.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    return allUtxos;
  }

  // --- Asset info ---

  async getAssetInfo(asset: string): Promise<AssetInfo> {
    return this.request<AssetInfo>(`/assets/${asset}`);
  }

  async getAssetAddresses(asset: string): Promise<Array<{ address: string; quantity: string }>> {
    let allAddresses: Array<{ address: string; quantity: string }> = [];
    let page = 1;
    while (true) {
      const batch = await this.request<Array<{ address: string; quantity: string }>>(
        `/assets/${asset}/addresses?page=${page}&order=asc`,
      );
      allAddresses = allAddresses.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    return allAddresses;
  }

  // --- Transaction metadata ---

  async getTxMetadata(txHash: string): Promise<TxMetadata> {
    return this.request<TxMetadata>(`/txs/${txHash}/metadata`);
  }

  async getTxInfo(txHash: string): Promise<unknown> {
    return this.request<unknown>(`/txs/${txHash}`);
  }

  async getTxUtxos(txHash: string): Promise<TxUtxos> {
    return this.request<TxUtxos>(`/txs/${txHash}/utxos`);
  }

  /**
   * Where a transaction sits in the chain's own record of what happened first:
   * its block, and its position within that block.
   *
   * Typed narrowly rather than reusing `getTxInfo`, because this pair is what
   * the venue's published fill order rests on. That order is a property anyone
   * can re-derive from the chain, so the figures behind it have to be read
   * from the transaction rather than inferred from the order a provider
   * happened to return its results in.
   */
  async getTxPosition(txHash: string): Promise<TxPosition> {
    const info = await this.request<TxPosition>(`/txs/${txHash}`);
    return { block_height: info.block_height, index: info.index };
  }

  // --- Address info (eligibility check #4 — stake key match) ---

  /**
   * Base address details, including the stake credential encoded in the
   * address itself (no signature required to read it — it's public bytes,
   * not a private key). Used by checkStakeKeyMatch to compare a
   * registrant's stake key against the creator's, without needing any
   * wallet-signed attestation.
   */
  async getAddress(address: string): Promise<AddressInfo> {
    return this.request<AddressInfo>(`/addresses/${address}`);
  }

  // --- Address transaction history (eligibility checks #1/#5) ---

  /**
   * Paginate through ALL of an address's transactions, oldest first.
   * Used by checkWalletAge (earliest tx = wallet age) and
   * checkNoDirectAdaFlow (scan for a specific counterparty).
   */
  async getAddressTransactionsAll(address: string): Promise<AddressTransaction[]> {
    let all: AddressTransaction[] = [];
    let page = 1;
    while (true) {
      const batch = await this.request<AddressTransaction[]>(
        `/addresses/${address}/transactions?page=${page}&order=asc&count=100`,
      );
      all = all.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    return all;
  }

  // --- Latest block / epoch ---

  async getLatestBlock(): Promise<BlockInfo> {
    return this.request<BlockInfo>('/blocks/latest');
  }

  async getLatestEpoch(): Promise<EpochInfo> {
    return this.request<EpochInfo>('/epochs/latest');
  }

  // --- Noctis-specific queries ---

  /**
   * Query the LP Escrow contract UTxO to check lock status
   * Returns null if no UTxO found at the script address
   */
  async getLpEscrowState(scriptAddress: string): Promise<{
    locked: boolean;
    lockUntil: number | null;
    state: string;
  } | null> {
    const utxos = await this.getAddressUtxos(scriptAddress);
    if (utxos.length === 0) return null;

    // Parse the inline datum to extract lock state
    // The datum is CBOR-encoded — in production, use a CBOR decoder
    // For now, we check if the UTxO exists (which means LP is locked)
    return {
      locked: true,
      lockUntil: null, // Parse from datum in production
      state: 'Locked',
    };
  }

  /**
   * Query the ZK Anchor contract UTxO to check certificate status
   */
  async getZkCertAnchor(scriptAddress: string): Promise<{ anchored: boolean; proofHash: string | null } | null> {
    const utxos = await this.getAddressUtxos(scriptAddress);
    if (utxos.length === 0) return { anchored: false, proofHash: null };

    // Parse the inline datum for the proof bundle hash
    return {
      anchored: true,
      proofHash: null, // Parse from datum in production
    };
  }

  /**
   * Query the CTO Governance anchor UTxO
   */
  async getCtoGovernanceState(
    scriptAddress: string,
  ): Promise<{ triggered: boolean; communityWallet: string | null } | null> {
    const utxos = await this.getAddressUtxos(scriptAddress);
    if (utxos.length === 0) return null;

    return {
      triggered: false, // Parse from datum in production
      communityWallet: null,
    };
  }

  /**
   * Fetch all Noctis launch data by scanning for token mints with the
   * Noctis policy ID pattern. In production, this would use a chain indexer
   * (e.g., db-sync or a custom indexer) rather than Blockfrost pagination.
   */
  async getActiveLaunches(noctisPolicyId: string): Promise<NoctisLaunchData[]> {
    // Get all assets under the Noctis policy
    let assets: Array<{ asset: string; quantity: string }> = [];
    let page = 1;
    while (true) {
      const batch = await this.request<Array<{ asset: string; quantity: string }>>(
        `/assets/policy/${noctisPolicyId}?page=${page}&order=asc`,
      );
      assets = assets.concat(batch);
      if (batch.length < 100) break;
      page++;
    }

    // Fetch metadata for each asset to build launch data
    const launches: NoctisLaunchData[] = [];
    for (const asset of assets) {
      try {
        const info = await this.getAssetInfo(asset.asset);
        const metadata = info.onchain_metadata ?? info.metadata;

        launches.push({
          launchId: `${info.policy_id}.${info.asset_name}`,
          tokenPolicyId: info.policy_id,
          tokenName: info.asset_name,
          tokenTicker: metadata?.ticker ?? '',
          tokenDescription: metadata?.description ?? '',
          tokenLogo: metadata?.logo ?? null,
          creatorAddress: '', // Extract from mint tx
          tier: 'B', // Extract from metadata
          state: 'graduated', // Determine from UTxO analysis
          graduationTimestamp: null,
          lpEscrowLocked: false,
          lpEscrowLockedUntil: null,
          ctoTriggered: false,
          zkCertAnchored: false,
          zkCertHash: null,
          totalSupply: info.quantity,
          currentPrice: null,
          tokensSold: null,
          tokensRemaining: null,
          raisedAda: null,
        });
      } catch (err) {
        // Skip assets that can't be fetched
        console.error(`Failed to fetch asset ${asset.asset}:`, err);
      }
    }

    return launches;
  }

  /**
   * Get the current slot leader schedule (for timing estimates)
   */
  async getCurrentSlot(): Promise<number> {
    const block = await this.getLatestBlock();
    return block.slot;
  }

  /**
   * Get the current POSIX time from the latest block
   */
  async getCurrentTime(): Promise<number> {
    const block = await this.getLatestBlock();
    return block.time;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create a Blockfrost client from environment variables
 */
export function createBlockfrostClient(): BlockfrostClient {
  const apiKey = process.env.BLOCKFROST_API_KEY;
  if (!apiKey) {
    throw new Error('BLOCKFROST_API_KEY environment variable is required');
  }

  const network = (process.env.BLOCKFROST_NETWORK ?? 'preprod') as 'preview' | 'preprod' | 'mainnet';

  return new BlockfrostClient({ apiKey, network });
}

// ============================================================================
// FALLBACK PROVIDER INTERFACE
// ============================================================================

/**
 * Fallback provider for when Blockfrost is unavailable.
 * Reads from a local cache file or returns mock data.
 * This implements the fallback pattern described in INTEGRATION_GUIDE.md.
 */
export interface ChainDataProvider {
  getAddressUtxos(address: string): Promise<AddressUtxo[]>;
  getAssetInfo(asset: string): Promise<AssetInfo>;
  getLatestBlock(): Promise<BlockInfo>;
  getActiveLaunches(policyId: string): Promise<NoctisLaunchData[]>;
}

/**
 * Mock provider for demoLand mode — returns deterministic mock data
 */
export class MockChainProvider implements ChainDataProvider {
  async getAddressUtxos(_address: string): Promise<AddressUtxo[]> {
    return [];
  }

  async getAssetInfo(asset: string): Promise<AssetInfo> {
    return {
      asset,
      policy_id: asset.slice(0, 56),
      asset_name: asset.slice(56),
      fingerprint: 'asset1mock',
      quantity: '1000000000',
      initial_mint_tx_hash: 'mock_tx_hash',
      mint_or_burn_count: 1,
      onchain_metadata: {
        name: 'Mock Token',
        ticker: 'MOCK',
        description: 'Mock token for demoLand mode',
        decimals: 6,
      },
      metadata: null,
    };
  }

  async getLatestBlock(): Promise<BlockInfo> {
    return {
      time: Math.floor(Date.now() / 1000),
      height: 0,
      hash: 'mock_block_hash',
      slot: 0,
      epoch: 0,
      epoch_slot: 0,
      slot_leader: 'mock_slot_leader',
      size: 0,
      tx_count: 0,
      output: '0',
      fees: '0',
      block_vrf: 'mock_vrf',
    };
  }

  async getActiveLaunches(_policyId: string): Promise<NoctisLaunchData[]> {
    return [
      {
        launchId: 'mock.launch.1',
        tokenPolicyId: 'mock_policy_id',
        tokenName: 'MOCK',
        tokenTicker: 'MOCK',
        tokenDescription: 'Mock launch for demoLand',
        tokenLogo: null,
        creatorAddress: 'addr_mock_creator',
        tier: 'B',
        state: 'curve',
        graduationTimestamp: null,
        lpEscrowLocked: false,
        lpEscrowLockedUntil: null,
        ctoTriggered: false,
        zkCertAnchored: true,
        zkCertHash: 'mock_proof_hash',
        totalSupply: '1000000000',
        currentPrice: '0.0001',
        tokensSold: '750000000',
        tokensRemaining: '250000000',
        raisedAda: '75000',
      },
    ];
  }
}

/**
 * Get the appropriate chain data provider based on environment.
 * In demoLand mode, returns MockChainProvider.
 * In realDeal mode, returns BlockfrostClient.
 */
export function getChainProvider(): ChainDataProvider {
  const isDemoMode = process.env.NOCTIS_MODE === 'demoLand';
  if (isDemoMode) {
    return new MockChainProvider();
  }
  return createBlockfrostClient() as unknown as ChainDataProvider;
}
