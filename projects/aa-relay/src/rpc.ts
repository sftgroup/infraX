// ============================================================================
// aa-relay Bundler RPC 客户端与错误分类（helpers.ts 拆分：单一职责）
// ① rpcClient：轻量 viem JSON-RPC client；② 业务/网络错误分类；
// ③ broadcast：多 bundler 容灾广播；④ waitForUserOpReceipt：收据轮询（异步结算用）。
// ============================================================================
import { createClient, http, type Address, type Hex } from 'viem';
import type { UserOperationV7 } from '../../aa-sdk/src/index.js';
import { userOpToRpc } from '../../aa-sdk/src/index.js';
import type { ChainAAConfig } from '../../aa-sdk/src/index.js';

type RpcClient = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

export function rpcClient(url: string, timeoutMs = 30_000): RpcClient {
  return createClient({ transport: http(url, { timeout: timeoutMs }) }) as unknown as RpcClient;
}

// bundler 业务错误（JSON-RPC 错误码如 -32500/FailedOp/AA20）→ 400 简洁透传；
// 网络错误（fetch failed / 连接失败，code 为字符串或 undefined）→ 切换备端点。
// 错误可能包在 cause 链里且 cause 可能是数组（BundlerError.cause = [err]），用队列 BFS 遍历。
// viem 2.x：RpcError（数字 code）→ RpcRequestError（JSON-RPC 层包装，业务错误）；
//           HttpRequestError（HTTP/网络层，区分网络故障）。toAAError 保留数字 code 与 cause 链。
export function isBundlerBusinessError(e: any): boolean {
  const isNet = (msg: string) => /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|other side closed/i.test(msg);
  const queue: any[] = [e];
  let guard = 0;
  while (queue.length && guard++ < 30) {
    const cur = queue.shift();
    if (!cur) continue;
    if (typeof cur.code === 'number') return true; // JSON-RPC 错误码（负数）
    if (cur.name === 'HttpRequestError') {
      const msg = rpcErrorMessage(cur);
      if (isNet(msg)) return false;
      return true; // HTTP 层已成功响应 JSON-RPC error → 业务错误
    }
    if (cur.name === 'RpcRequestError') return true; // JSON-RPC 响应错误 = bundler 业务拒绝
    if (Array.isArray(cur.cause)) queue.push(...cur.cause);
    else if (cur.cause && cur.cause !== cur) queue.push(cur.cause); // 防自引用
  }
  return false;
}

// 从错误链中提取最有业务含义的消息（跳过 viem "RPC Request failed" 噪声包装）
export function rpcErrorMessage(e: any): string {
  const queue: any[] = [e];
  let best = '';
  let guard = 0;
  while (queue.length && guard++ < 30) {
    const cur = queue.shift();
    if (!cur) continue;
    const msg = cur?.shortMessage || cur?.message || '';
    if (msg && !/^RPC Request failed/.test(msg) && !/^Error: /i.test(msg)) best = msg;
    if (Array.isArray(cur.cause)) queue.push(...cur.cause);
    else if (cur.cause && cur.cause !== cur) queue.push(cur.cause);
  }
  return best || String(e?.message || e);
}

// 广播-only（wait=false）：多 bundler 容灾，成功即返回 userOpHash
export async function broadcast(cfg: ChainAAConfig, op: UserOperationV7): Promise<{ userOpHash: Hex; bundlerUrl: string }> {
  const endpoints = [...cfg.bundlers].sort((a, b) => a.priority - b.priority);
  const errors: string[] = [];
  for (const ep of endpoints) {
    try {
      const client = rpcClient(ep.url, ep.timeoutMs);
      const hash = (await client.request({
        method: 'eth_sendUserOperation',
        params: [userOpToRpc(op), cfg.entryPoint],
      })) as Hex;
      return { userOpHash: hash, bundlerUrl: ep.url };
    } catch (e: any) {
      if (isBundlerBusinessError(e)) {
        throw Object.assign(new Error(`${ep.url}: ${rpcErrorMessage(e)}`), { statusCode: 400 });
      }
      errors.push(`${ep.url}: ${rpcErrorMessage(e)}`);
    }
  }
  throw Object.assign(new Error(`all bundlers failed (${errors.join(' | ')})`), { statusCode: 502 });
}

// P1-2: 等待 UserOp 收据（异步结算用；多 bundler 轮询 eth_getUserOperationReceipt，不重复广播）。
// 超时返回 null（调用方按预扣额保留，不自动退差，避免双重扣减/对账歧义）。
export async function waitForUserOpReceipt(cfg: ChainAAConfig, hash: Hex, timeoutMs = 120_000): Promise<any | null> {
  const endpoints = [...cfg.bundlers].sort((a, b) => a.priority - b.priority);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const ep of endpoints) {
      try {
        const client = rpcClient(ep.url, ep.timeoutMs);
        const r = (await client.request({ method: 'eth_getUserOperationReceipt', params: [hash] })) as any;
        if (r) return r;
      } catch { /* 单端点失败继续下一端点 */ }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return null;
}
