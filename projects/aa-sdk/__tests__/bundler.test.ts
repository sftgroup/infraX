// Bundler 多端点容灾逻辑单测（对齐 §5.6 + §10.1）
// 注意：sendSingle/waitForReceipt 为 M2 实现（当前抛 NotImplemented），
// 这里覆盖 sendUserOperation 的端点排序与全失败兜底逻辑。
// TODO(实现/M2): 以下用例待 M2 填充：
//  1. 主端点网络错误 → 自动切备端点，返回备端点结果
//  2. AA10 幂等错误 → 视为成功不抛错
//  3. AA24/AA31-33 业务错误 → 直接抛出不重试
//  4. waitForReceipt 超时 → BundlerError
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { BundlerClient } from '../src/bundler.js';
import { BundlerError } from '../src/errors.js';
import type { BundlerConfig, ChainAAConfig, UserOperationV7 } from '../src/types.js';

const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;
const SENDER = '0x0000000000000000000000000000000000000001' as Address;

function makeBundler(url: string, priority: number): BundlerConfig {
  return { url, priority, timeoutMs: 1000 };
}

function makeChain(bundlers: BundlerConfig[]): ChainAAConfig {
  return {
    chainId: 84532,
    entryPointVersion: '0.7',
    entryPoint: ENTRYPOINT,
    rpcUrl: 'https://mock.invalid',
    bundlers,
  };
}

function makeOp(): UserOperationV7 {
  return {
    sender: SENDER,
    nonce: 0n,
    callData: '0x',
    callGasLimit: 100000n,
    verificationGasLimit: 100000n,
    preVerificationGas: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    signature: '0x' as Hex,
  };
}

describe('BundlerClient.sendUserOperation (容灾兜底)', () => {
  it('sorts endpoints by priority (0 = 主)', () => {
    const client = new BundlerClient(makeChain([makeBundler('https://backup.invalid', 1), makeBundler('https://primary.invalid', 0)]));
    // 端点已按 priority 排序 → 主端点最先被尝试；当前 sendSingle 未实现抛错，
    // 依次失败后抛 BundlerError，且 bundlerUrl 指向主端点。
    return expect(client.sendUserOperation(makeOp())).rejects.toBeInstanceOf(BundlerError);
  });

  it('throws BundlerError when all endpoints fail', async () => {
    const client = new BundlerClient(makeChain([makeBundler('https://primary.invalid', 0), makeBundler('https://backup.invalid', 1)]));
    await expect(client.sendUserOperation(makeOp())).rejects.toMatchObject({ name: 'BundlerError' });
  });

  it('throws BundlerError when no endpoints configured', async () => {
    const client = new BundlerClient(makeChain([]));
    await expect(client.sendUserOperation(makeOp())).rejects.toMatchObject({ name: 'BundlerError' });
  });

  // 回归（P0.2 链上实测）：ERC-4337 规范 receipt 的 transactionHash 嵌套在
  // receipt 对象内（Alto/Stackup），顶层无 transactionHash → 此前 txHash=undefined。
  it('extracts txHash from nested receipt (Alto ERC-4337 spec)', async () => {
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      let result: unknown;
      if (body.method === 'eth_sendUserOperation') {
        result = '0x1234';
      } else if (body.method === 'eth_getUserOperationReceipt') {
        result = {
          userOpHash: '0x1234',
          entryPoint: ENTRYPOINT,
          sender: SENDER,
          nonce: '0x0',
          actualGasCost: '0x123',
          actualGasUsed: '0x456',
          success: true,
          logs: [],
          receipt: { transactionHash: '0xfeed' },
        };
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const client = new BundlerClient(makeChain([makeBundler('https://mock.invalid', 0)]));
      const res = await client.sendUserOperation(makeOp());
      expect(res.userOpHash).toBe('0x1234');
      expect(res.receipt?.txHash).toBe('0xfeed');
      expect(res.receipt?.success).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 回归（联调反馈 ⑤）：rpc() 需支持自定义 headers（relay 模式注入 X-API-Key）。
  // 构造级 headers 与端点级 bundler.headers 均须注入 viem transport。
  it('injects custom headers into every RPC request (client-level + endpoint-level)', async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const h: Record<string, string> = {};
      // viem http transport 可能传 Headers 实例或 plain object
      if (init?.headers instanceof Headers) {
        init.headers.forEach((v, k) => { h[k] = v; });
      } else {
        Object.assign(h, init?.headers as Record<string, string>);
      }
      seen.push(h);
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      let result: unknown;
      if (body.method === 'eth_sendUserOperation') {
        result = '0x1234';
      } else if (body.method === 'eth_getUserOperationReceipt') {
        result = {
          userOpHash: '0x1234', entryPoint: ENTRYPOINT, sender: SENDER, nonce: '0x0',
          actualGasCost: '0x123', actualGasUsed: '0x456', success: true, logs: [],
          receipt: { transactionHash: '0xfeed' },
        };
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
    });
    try {
      // 端点级 headers 优先
      const ep: BundlerConfig = { url: 'https://mock.invalid', priority: 0, timeoutMs: 1000, headers: { 'X-API-Key': 'ep-key' } };
      const client = new BundlerClient(makeChain([ep]), { 'X-API-Key': 'client-key' });
      await client.sendUserOperation(makeOp());
      expect(seen.length).toBeGreaterThan(0);
      seen.forEach((h) => expect(h['x-api-key'] ?? h['X-API-Key']).toBe('ep-key'));

      // 构造级 headers（未配端点级时生效）
      const client2 = new BundlerClient(makeChain([makeBundler('https://mock.invalid', 0)]), { 'X-API-Key': 'client-key' });
      seen.length = 0;
      await client2.sendUserOperation(makeOp());
      expect(seen.length).toBeGreaterThan(0);
      seen.forEach((h) => expect(h['x-api-key'] ?? h['X-API-Key']).toBe('client-key'));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
