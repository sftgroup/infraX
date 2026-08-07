/**
 * RPC Pool Manager（迁移自 collector/src/services/rpcPool.ts + 扩展）。
 *
 * 能力：
 *  - 每链多端点 round-robin + 30s 健康检查（healthy → degraded → down 自动降级/恢复）
 *  - 令牌桶限流（rpm/rpd）+ 429 退避重试（3 次）
 *  - 通用 JSON-RPC 读调用 call(chain, method, params)
 *  - 交易广播 broadcast(chain, rawTx) → eth_sendRawTransaction
 *  - 广播确认 waitReceipt（eth_getTransactionReceipt 轮询）
 *  - 池状态 status()（脱敏：不含端点 url）
 */
import axios from 'axios';
import { logger } from '../logger';
import { RpcEndpoint, RpcPoolConfig, normalizeChain } from './rpcPoolConfig';

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15_000;

export class ChainRpcError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'rpc_error',
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'ChainRpcError';
  }
}

export class RpcPoolManager {
  private config: RpcPoolConfig;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private roundRobin: Map<string, number> = new Map();

  constructor(config: RpcPoolConfig) {
    this.config = config;
    this.startHealthChecks();
  }

  chains(): string[] {
    return Object.keys(this.config);
  }

  activeEndpoints(chain: string): RpcEndpoint[] {
    const eps = this.config[chain];
    if (!eps) return [];
    return eps.filter((ep) => ep.status !== 'down' && ep.status !== 'degraded');
  }

  totalActiveEndpoints(): number {
    let count = 0;
    for (const chain of Object.keys(this.config)) {
      count += this.activeEndpoints(chain).length;
    }
    return count;
  }

  pickEndpoint(chain: string): RpcEndpoint {
    const activeEps = this.activeEndpoints(chain);
    if (activeEps.length === 0) {
      throw new ChainRpcError(`No active RPC endpoints for chain ${chain}`, 'no_active_endpoint', 503);
    }
    const cursor = this.roundRobin.get(chain) || 0;
    const idx = cursor % activeEps.length;
    this.roundRobin.set(chain, cursor + 1);
    return activeEps[idx];
  }

  splitBlocksAcrossEndpoints(chain: string, blocks: number[]): Array<{ endpoint: RpcEndpoint; blocks: number[] }> {
    const activeEps = this.activeEndpoints(chain);
    if (activeEps.length === 0) {
      throw new ChainRpcError(`No active RPC endpoints for chain ${chain}`, 'no_active_endpoint', 503);
    }
    const size = Math.ceil(blocks.length / activeEps.length);
    return activeEps.map((ep, i) => ({
      endpoint: ep,
      blocks: blocks.slice(i * size, (i + 1) * size),
    }));
  }

  async fetchBlockRange(endpoint: RpcEndpoint, chain: string, fromBlock: number, toBlock: number): Promise<any[]> {
    if (chain === 'solana') {
      return this.fetchSolanaBlocks(endpoint, fromBlock, toBlock);
    }
    const blocks: any[] = [];
    for (let bn = fromBlock; bn <= toBlock; bn++) {
      try {
        const block = await this.fetchBlockWithRetry(endpoint, bn);
        if (block) blocks.push(block);
      } catch (err: any) {
        logger.warn(`[rpc-pool] Failed to fetch block ${bn} on ${chain} via ${endpoint.key}`, { error: err.message });
      }
    }
    return blocks;
  }

  async fetchLogs(endpoint: RpcEndpoint, params: { address?: string; topics?: string[]; fromBlock: number; toBlock: number }): Promise<any[]> {
    return this.rpcCall(endpoint, 'eth_getLogs', [params]);
  }

  async getLatestBlock(chain: string): Promise<number> {
    const activeEps = this.activeEndpoints(chain);
    if (activeEps.length === 0) {
      throw new ChainRpcError(`No active RPC endpoints for chain ${chain}`, 'no_active_endpoint', 503);
    }
    if (chain === 'solana') {
      return this.rpcCall(activeEps[0], 'getSlot', []).then((r: any) => parseInt(r, 10) || 0);
    }
    return this.rpcCall(activeEps[0], 'eth_blockNumber', []).then((hex: string) => parseInt(hex, 16));
  }

  // ================================================================
  // 网关扩展：通用读调用 / 广播 / 确认 / 状态
  // ================================================================

  /**
   * 通用 JSON-RPC 读调用：round-robin 选端点 → 自动重试 → 降级。
   * chain 支持别名（ethereum/eth/mainnet → ethereum，sol/solana → solana）。
   */
  async call(chain: string, method: string, params: any[]): Promise<any> {
    const norm = normalizeChain(chain);
    if (!norm) {
      throw new ChainRpcError(`Unsupported chain: ${chain}`, 'unsupported_chain', 400);
    }
    if (!this.config[norm] || this.config[norm].length === 0) {
      throw new ChainRpcError(`No RPC endpoints configured for chain ${norm}`, 'no_endpoint_config', 503);
    }
    const endpoint = this.pickEndpoint(norm);
    return this.rpcCall(endpoint, method, params);
  }

  /**
   * 交易广播：eth_sendRawTransaction（调用方已签名，网关不持有私钥）。
   */
  async broadcast(chain: string, rawTransaction: string): Promise<string> {
    const norm = normalizeChain(chain);
    if (!norm) {
      throw new ChainRpcError(`Unsupported chain: ${chain}`, 'unsupported_chain', 400);
    }
    if (!rawTransaction || typeof rawTransaction !== 'string') {
      throw new ChainRpcError('rawTransaction is required', 'missing_raw_tx', 400);
    }
    return this.call(norm, 'eth_sendRawTransaction', [rawTransaction]);
  }

  /**
   * 广播确认：轮询 eth_getTransactionReceipt 直至有回执或超时。
   * 返回 {confirmed, txHash, receipt|null, reason?}。
   */
  async waitReceipt(chain: string, txHash: string, timeoutMs = 30_000, intervalMs = 3_000): Promise<any> {
    const norm = normalizeChain(chain);
    if (!norm) {
      throw new ChainRpcError(`Unsupported chain: ${chain}`, 'unsupported_chain', 400);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = await this.call(norm, 'eth_getTransactionReceipt', [txHash]);
      if (receipt) {
        return { confirmed: true, txHash, receipt, reason: null };
      }
      await sleep(intervalMs);
    }
    return { confirmed: false, txHash, receipt: null, reason: 'timeout' };
  }

  /**
   * 池状态（脱敏：仅暴露 key/status/provider，不暴露 url —— url 可能含 API key）。
   */
  status(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [chain, eps] of Object.entries(this.config)) {
      out[chain] = {
        total: eps.length,
        active: this.activeEndpoints(chain).length,
        endpoints: eps.map((e) => ({
          key: e.key,
          provider: e.provider,
          tier: e.tier,
          status: e.status,
        })),
      };
    }
    return out;
  }

  shutdown(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    logger.info('[rpc-pool] RPC Pool Manager shut down');
  }

  // ================================================================
  // 内部
  // ================================================================

  private async fetchSolanaBlocks(endpoint: RpcEndpoint, fromSlot: number, toSlot: number): Promise<any[]> {
    const blocks: any[] = [];
    for (let slot = fromSlot; slot <= toSlot; slot++) {
      try {
        const result = await this.rpcCall(endpoint, 'getBlock', [
          slot,
          { maxSupportedTransactionVersion: 0, transactionDetails: 'full', rewards: false } as any,
        ]);
        if (result) blocks.push(result);
      } catch (err: any) {
        logger.warn(`[rpc-pool] Failed to fetch solana slot ${slot} via ${endpoint.key}`, { error: err.message });
      }
    }
    return blocks;
  }

  private async fetchBlockWithRetry(endpoint: RpcEndpoint, blockNumber: number): Promise<any> {
    const hexBlock = '0x' + blockNumber.toString(16);
    const [block, logs] = await Promise.all([
      this.rpcCall(endpoint, 'eth_getBlockByNumber', [hexBlock, true]),
      this.rpcCall(endpoint, 'eth_getLogs', [{ fromBlock: hexBlock, toBlock: hexBlock }]),
    ]);
    return { block, logs, blockNumber };
  }

  private async rpcCall(endpoint: RpcEndpoint, method: string, params: any[]): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (endpoint.tokens.remaining <= 0) {
          const resetDelay = endpoint.tokens.resetAt - Date.now();
          if (resetDelay > 0) {
            await sleep(Math.min(resetDelay, 5000));
          }
          endpoint.tokens.remaining = endpoint.rateLimit.rpd;
          endpoint.tokens.resetAt = Date.now() + 86400_000;
        }

        const response = await axios.post(
          endpoint.url,
          { jsonrpc: '2.0', id: Date.now(), method, params },
          { timeout: REQUEST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
        );

        endpoint.tokens.remaining--;
        endpoint.status = 'healthy';

        if (response.data.error) {
          throw new Error(`RPC error: ${response.data.error.message || JSON.stringify(response.data.error)}`);
        }
        return response.data.result;
      } catch (err: any) {
        lastError = err;
        const status = err.response?.status;
        if (status === 429) {
          logger.warn(`[rpc-pool] 429 on ${endpoint.key}, retrying in ${attempt * 2}s`);
          await sleep(attempt * 2000);
          continue;
        }
        if (attempt < MAX_RETRIES) {
          await sleep(attempt * 1000);
        }
      }
    }

    this.markEndpointDegraded(endpoint);
    throw lastError || new Error(`RPC call ${method} failed after ${MAX_RETRIES} attempts`);
  }

  private markEndpointDegraded(endpoint: RpcEndpoint): void {
    if (endpoint.status === 'healthy') {
      endpoint.status = 'degraded';
      logger.warn(`[rpc-pool] Endpoint degraded: ${endpoint.key}`);
    } else if (endpoint.status === 'degraded') {
      endpoint.status = 'down';
      logger.error(`[rpc-pool] Endpoint down: ${endpoint.key}`);
    }
  }

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(() => {
      void this.runHealthChecks();
    }, HEALTH_CHECK_INTERVAL_MS);
    if (this.healthCheckTimer && 'unref' in this.healthCheckTimer) {
      this.healthCheckTimer.unref?.();
    }
  }

  private async runHealthChecks(): Promise<void> {
    for (const [chain, endpoints] of Object.entries(this.config)) {
      for (const ep of endpoints) {
        try {
          const method = chain === 'solana' ? 'getHealth' : 'eth_blockNumber';
          const result = await this.rpcCall(ep, method, []);
          const ok = chain === 'solana' ? result === 'ok' : parseInt(result, 16) > 0;
          if (ok) {
            if (ep.status !== 'healthy') logger.info(`[rpc-pool] Endpoint recovered: ${ep.key} (${chain})`);
            ep.status = 'healthy';
          }
        } catch {
          if (ep.status === 'healthy') {
            ep.status = 'degraded';
            logger.warn(`[rpc-pool] Endpoint degraded: ${ep.key} (${chain})`);
          } else if (ep.status === 'degraded') {
            ep.status = 'down';
            logger.error(`[rpc-pool] Endpoint down: ${ep.key} (${chain})`);
          }
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
