import { RpcPoolManager } from './rpcPool';
import { buildRpcPoolConfig, mergeDbEndpoints } from './rpcPoolConfig';
import {
  normalizeBlock,
  normalizeSolanaBlock,
  insertEvents,
  updateCheckpoint,
  getCheckpoint,
  incrementEventCount,
  NormalizedEvent,
} from './normalizer';
import { logger } from '../logger';

/**
 * Full-Chain Block Scanner
 *
 * Every SCAN_INTERVAL_MS:
 *  1. Get latest block from the fastest endpoint
 *  2. Split the block range across active RPC endpoints (epoch allocation)
 *  3. Fetch blocks + logs in parallel
 *  4. Normalize events → insert into events table
 *  5. Update checkpoint
 *
 * Supports 5 chains: sepolia, ethereum, bsc, base, solana
 */

const SCAN_INTERVAL_MS = 10_000; // 10s per cycle
const BLOCKS_PER_CYCLE = 5;      // Max blocks to scan per cycle per chain (reduced for Infura free tier)
const CONFIRMATION_OFFSET = 3;   // Scan up to latest - 3 blocks (avoid reorgs)

// Per-chain blocks-per-cycle overrides (solana: 1 slot has ~3k events)
const BLOCKS_PER_CYCLE_OVERRIDE: Record<string, number> = {
  solana: 1,   // 1 Solana slot ~= 3,500 SPL events, same order as 5 EVM blocks
};

// Chains to scan
const ACTIVE_CHAINS = ['sepolia', 'ethereum', 'bsc', 'base', 'solana'];

export class BlockScanner {
  private rpcPool: RpcPoolManager;
  private scanTimers: Map<string, NodeJS.Timeout> = new Map();
  private scanState: Map<string, { scanning: boolean; lastError: string | null }> = new Map();

  constructor() {
    const config = buildRpcPoolConfig();
    this.rpcPool = new RpcPoolManager(config);
  }

  /**
   * Merge DB-stored RPC endpoints into config
   */
  async init(): Promise<void> {
    const config = buildRpcPoolConfig();
    await mergeDbEndpoints(config);
    // Create new RPC pool manager with DB-merged config
    this.rpcPool.shutdown();
    this.rpcPool = new RpcPoolManager(config);
    console.log(`[scanner] Initialized with ${this.rpcPool.totalActiveEndpoints()} active endpoints`);
  }

  /**
   * Reload RPC config from DB (called after adding/removing endpoints via admin)
   */
  async refreshConfig(): Promise<void> {
    const config = buildRpcPoolConfig();
    await mergeDbEndpoints(config);
    this.rpcPool.shutdown();
    this.rpcPool = new RpcPoolManager(config);
    logger.info(`[scanner] Config refreshed: ${this.rpcPool.totalActiveEndpoints()} active endpoints`);
  }

  /**
   * Start scanning all chains
   */
  async start(): Promise<void> {
    logger.info('[scanner] Block Scanner starting', {
      chains: ACTIVE_CHAINS.length,
      endpoints: this.rpcPool.totalActiveEndpoints(),
    });

    for (const chain of ACTIVE_CHAINS) {
      this.scanState.set(chain, { scanning: false, lastError: null });
      this.scheduleScan(chain);
    }
  }

  /**
   * Schedule periodic scan for a chain
   */
  private scheduleScan(chain: string): void {
    const timer = setInterval(() => {
      this.scanChain(chain);
    }, SCAN_INTERVAL_MS);

    if (timer && 'unref' in timer) timer.unref?.();
    this.scanTimers.set(chain, timer);

    // Initial scan after 3s (let the system settle)
    setTimeout(() => this.scanChain(chain), 3000).unref?.();
  }

  /**
   * Scan a single chain: fetch latest blocks → normalize → insert
   */
  async scanChain(chain: string): Promise<void> {
    const state = this.scanState.get(chain);
    if (!state || state.scanning) return;

    state.scanning = true;

    try {
      const activeEps = this.rpcPool.activeEndpoints(chain);
      if (activeEps.length === 0) {
        logger.warn(`[scanner] No active endpoints for ${chain}, skipping cycle`);
        state.scanning = false;
        return;
      }

      // 1. Get latest block
      const latestBlock = await this.rpcPool.getLatestBlock(chain);
      const safeLatest = latestBlock - CONFIRMATION_OFFSET;

      // 2. Get checkpoint
      const checkpoint = await getCheckpoint(chain, 'block_scanner');
      const batchSize = BLOCKS_PER_CYCLE_OVERRIDE[chain] ?? BLOCKS_PER_CYCLE;
      const fromBlock = checkpoint > 0 ? checkpoint + 1 : Math.max(safeLatest - batchSize, 0);

      if (fromBlock > safeLatest) {
        state.scanning = false;
        return; // Nothing new to scan
      }

      const toBlock = Math.min(safeLatest, fromBlock + batchSize - 1);
      const blockCount = toBlock - fromBlock + 1;

      // 3. Generate block numbers
      const blocks = Array.from({ length: blockCount }, (_, i) => fromBlock + i);

      // 4. Round-robin: pick one endpoint per cycle
      const endpoint = this.rpcPool.pickEndpoint(chain);

      // 5. Fetch + normalize + insert
      const totalInserted = await this.fetchAndProcessBlockRange(chain, endpoint, blocks);

      // 6. Update checkpoint + event count (count first to avoid drift)
      if (totalInserted > 0) {
        await incrementEventCount(chain, totalInserted);
        logger.info(`[scanner] ${chain}: ${fromBlock}→${toBlock} via ${endpoint.key} (${blockCount} blocks, ${totalInserted} events)`);
      }
      await updateCheckpoint(chain, 'block_scanner', toBlock);
      state.lastError = null;
    } catch (err: any) {
      state.lastError = err.message;
      logger.error(`[scanner] Cycle failed for ${chain}`, { error: err.message });
    } finally {
      state.scanning = false;
    }
  }

  /**
   * Fetch a range of blocks and process them
   */
  private async fetchAndProcessBlockRange(
    chain: string,
    endpoint: any,
    blocks: number[]
  ): Promise<number> {
    let totalInserted = 0;

    for (const blockNum of blocks) {
      try {
        const rawBlock = await this.rpcPool.fetchBlockRange(endpoint, chain, blockNum, blockNum);
        if (rawBlock.length > 0) {
          const normalized = chain === 'solana'
            ? normalizeSolanaBlock(rawBlock[0])
            : normalizeBlock(rawBlock[0], chain);
          if (normalized.length > 0) {
            const inserted = await insertEvents(normalized);
            totalInserted += inserted;
          }
        }
      } catch (err: any) {
        logger.warn(`[scanner] Error processing block ${blockNum} on ${chain}`, {
          error: err.message,
          endpoint: endpoint.key,
        });
      }
    }

    return totalInserted;
  }

  /**
   * Get health status for monitoring
   */
  getHealth(): Record<string, any> {
    const collectors: any[] = [];

    for (const chain of ACTIVE_CHAINS) {
      const state = this.scanState.get(chain);
      collectors.push({
        name: 'block_scanner',
        chain,
        status: state?.scanning ? 'scanning' : 'idle',
        error: state?.lastError || null,
      });
    }

    return {
      collectors,
      endpoints: this.rpcPool.totalActiveEndpoints(),
    };
  }

  /**
   * Shutdown the scanner
   */
  shutdown(): void {
    for (const [chain, timer] of this.scanTimers.entries()) {
      clearInterval(timer);
      logger.info(`[scanner] Stopped scanning ${chain}`);
    }
    this.rpcPool.shutdown();
  }
}

// Singleton
let scannerInstance: BlockScanner | null = null;

export function getScanner(): BlockScanner {
  if (!scannerInstance) {
    scannerInstance = new BlockScanner();
  }
  return scannerInstance;
}
