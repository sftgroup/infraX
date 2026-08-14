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
import { RpcEndpoint, RpcPoolConfig, normalizeChain, CHAIN_IDS } from './rpcPoolConfig';
import { profileFor } from './chainProfiles';

/** DC-7: 池运行参数（env 可配，见 config.ts） */
export interface RpcPoolManagerOptions {
  healthIntervalMs?: number;
  maxRetries?: number;
  requestTimeoutMs?: number;
}

/** DC-9: 仅返回 URL 的 host 部分（不含路径/query，避免暴露 key） */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** DC-9: 完整 URL 但 query 中 key/token/secret/auth 参数值打码为 *** */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of Object.keys(u.searchParams)) {
      if (/key|token|secret|auth/i.test(k)) u.searchParams.set(k, '***');
    }
    return u.toString();
  } catch {
    return url;
  }
}

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
  private readonly healthIntervalMs: number;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;

  constructor(config: RpcPoolConfig, options: RpcPoolManagerOptions = {}) {
    this.config = config;
    this.healthIntervalMs = options.healthIntervalMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
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
    const norm = normalizeChain(chain);
    if (!norm) {
      throw new ChainRpcError(`Unsupported chain: ${chain}`, 'unsupported_chain', 400);
    }
    const activeEps = this.activeEndpoints(norm);
    if (activeEps.length === 0) {
      throw new ChainRpcError(`No active RPC endpoints for chain ${chain}`, 'no_active_endpoint', 503);
    }
    // DC-8: 链类型查表（EVM→eth_blockNumber，Solana→getSlot）
    const p = profileFor(norm);
    return this.rpcCall(activeEps[0], p.latestBlockMethod, []).then((r) => p.latestBlockParse(r));
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
   * DC-5: 返回链上活跃端点的一个 WebSocket URL（http(s)→ws(s)），供订阅代理使用。
   */
  getWsEndpoint(chain: string): string | null {
    const norm = normalizeChain(chain);
    if (!norm) return null;
    try {
      const ep = this.pickEndpoint(norm);
      return ep.url.replace(/^http/, 'ws');
    } catch {
      return null;
    }
  }

  /**
   * 交易广播（调用方已签名，网关不持有私钥）：
   *   EVM    → eth_sendRawTransaction(rawTx)
   *   Solana → sendTransaction(txBase58/Base64)（返回 signature）
   */
  async broadcast(chain: string, rawTransaction: string): Promise<string> {
    const norm = normalizeChain(chain);
    if (!norm) {
      throw new ChainRpcError(`Unsupported chain: ${chain}`, 'unsupported_chain', 400);
    }
    if (!rawTransaction || typeof rawTransaction !== 'string') {
      throw new ChainRpcError('rawTransaction is required', 'missing_raw_tx', 400);
    }
    // DC-8: 链类型查表（EVM→eth_sendRawTransaction，Solana→sendTransaction）
    const p = profileFor(norm);
    return this.call(norm, p.broadcastMethod, [rawTransaction]);
  }

  /**
   * 广播确认轮询：按链类型查表（EVM→eth_getTransactionReceipt；Solana→getSignatureStatuses）。
   * 返回 {confirmed, txHash, receipt|null, reason?}。
   */
  async waitReceipt(chain: string, txHash: string, timeoutMs = 30_000, intervalMs = 3_000): Promise<any> {
    const norm = normalizeChain(chain);
    if (!norm) {
      throw new ChainRpcError(`Unsupported chain: ${chain}`, 'unsupported_chain', 400);
    }
    const p = profileFor(norm);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // RPC-6 轮询容错：上游端点异常/瞬断不应中断等待——吞错续轮，直到超时返回 confirmed:false
      try {
        const result = await this.call(norm, p.receiptMethod, p.receiptParams(txHash));
        if (p.receiptConfirmed(result)) {
          const receipt = p.key === 'solana' ? { signatureStatus: result?.value?.[0] } : result;
          return { confirmed: true, txHash, receipt, reason: null };
        }
      } catch (err: any) {
        logger.debug(`[rpc-pool] waitReceipt poll error (continue until timeout): ${err.message}`);
      }
      await sleep(intervalMs);
    }
    return { confirmed: false, txHash, receipt: null, reason: 'timeout' };
  }

  /**
   * DC-9: 池状态（脱敏策略可配置：none 无 url / host 仅 host / full 完整 url + query key 打码）。
   */
  status(mode: 'none' | 'host' | 'full' = 'none'): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [chain, eps] of Object.entries(this.config)) {
      out[chain] = {
        chainId: CHAIN_IDS[chain] ?? null,
        total: eps.length,
        active: this.activeEndpoints(chain).length,
        endpoints: eps.map((e) => {
          const base: any = {
            key: e.key,
            provider: e.provider,
            tier: e.tier,
            status: e.status,
          };
          if (mode === 'host') base.url = safeHost(e.url);
          else if (mode === 'full') base.url = maskUrl(e.url);
          return base;
        }),
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

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
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
          { timeout: this.requestTimeoutMs, headers: { 'Content-Type': 'application/json' } }
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
        if (attempt < this.maxRetries) {
          await sleep(attempt * 1000);
        }
      }
    }

    this.markEndpointDegraded(endpoint);
    throw lastError || new Error(`RPC call ${method} failed after ${this.maxRetries} attempts`);
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
    }, this.healthIntervalMs);
    if (this.healthCheckTimer && 'unref' in this.healthCheckTimer) {
      this.healthCheckTimer.unref?.();
    }
  }

  private async runHealthChecks(): Promise<void> {
    for (const [chain, endpoints] of Object.entries(this.config)) {
      for (const ep of endpoints) {
        try {
          // DC-8: 健康检查方法按链类型查表（EVM→eth_blockNumber，Solana→getHealth）
          const p = profileFor(chain);
          const result = await this.rpcCall(ep, p.healthMethod, []);
          const ok = p.healthOk(result);
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
