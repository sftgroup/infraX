// E-1a：PaymasterClient + estimateUserOpGas 单测
// 覆盖：直连模式 stub/data RPC 请求与响应解析；relay 代理 body 契约；
//       estimateUserOpGas 编排（stub → 估算 → 正式 data）
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Address, Hex } from 'viem';
import { PaymasterClient } from '../src/paymaster.js';
import { estimateUserOpGas } from '../src/utils/gas.js';
import type { BundlerConfig, ChainAAConfig, PaymasterConfig, UserOperationV7 } from '../src/types.js';

const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;
const PM_ADDR = '0x00000000000000000000000000000000000000aa' as Address;
const SENDER = '0x0000000000000000000000000000000000000001' as Address;

const PAYMASTER_URL = 'https://api.pimlico.io/v2/84532/rpc?apikey=SECRET';
const RELAY_URL = 'https://relay.invalid';

function makeOp(): UserOperationV7 {
  return {
    sender: SENDER,
    nonce: 0n,
    callData: '0x',
    callGasLimit: 100000n,
    verificationGasLimit: 100000n,
    preVerificationGas: 21000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 100000000n,
    signature: '0x',
  };
}

function makePaymasterCfg(url = PAYMASTER_URL): PaymasterConfig {
  return { type: 'verifying', url };
}

const CTX = { chain: 'base-sepolia', entryPoint: ENTRYPOINT, chainId: 84532, policyId: 'pol_1' };

/** 模拟 fetch：记录请求，返回预设 JSON */
function mockFetch(response: unknown) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 200, json: async () => response };
  }));
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('PaymasterClient', () => {
  it('直连模式：stub 请求含 userOp/entryPoint/chainId/policyId，解析 paymaster+data+gas 字段', async () => {
    const calls = mockFetch({
      result: { paymaster: PM_ADDR, data: '0xdead', verificationGasLimit: '0x5208', preVerificationGas: '0x1234' },
    });
    const pm = new PaymasterClient(makePaymasterCfg());
    const r = await pm.getPaymasterStubData(makeOp(), CTX);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(PAYMASTER_URL);
    expect(calls[0].body.method).toBe('pimlico_getPaymasterStubData');
    expect(calls[0].body.params[0]).toMatchObject({ sender: SENDER, callData: '0x' });
    expect(calls[0].body.params[1]).toBe(ENTRYPOINT);
    expect(calls[0].body.params[2]).toBe('0x14a34'); // 84532 hex
    expect(calls[0].body.params[3]).toBe('pol_1');

    expect(r.op.paymaster).toBe(PM_ADDR);
    expect(r.op.paymasterData).toBe('0xdead');
    expect(r.op.paymasterVerificationGasLimit).toBe(21000n);
    expect(r.op.preVerificationGas).toBe(0x1234n);
  });

  it('直连模式：getPaymasterData 只返回 paymaster+data（真实计费签名）', async () => {
    const calls = mockFetch({ result: { paymaster: PM_ADDR, data: '0xbeef' } });
    const pm = new PaymasterClient(makePaymasterCfg());
    const r = await pm.getPaymasterData(makeOp(), CTX);

    expect(calls[0].body.method).toBe('pimlico_getPaymasterData');
    expect(r.op.paymaster).toBe(PM_ADDR);
    expect(r.op.paymasterData).toBe('0xbeef');
    expect(r.op.paymasterVerificationGasLimit).toBeUndefined();
  });

  it('relay 代理模式：请求发往 relay 且 body 带 chain 路由字段', async () => {
    const calls = mockFetch({ result: { paymaster: PM_ADDR, data: '0xcafe' } });
    const pm = new PaymasterClient(makePaymasterCfg(), RELAY_URL);
    await pm.getPaymasterData(makeOp(), CTX);

    expect(calls[0].url).toBe(RELAY_URL);
    expect(calls[0].body.chain).toBe('base-sepolia');
    expect(calls[0].body.method).toBe('pimlico_getPaymasterData');
    expect(calls[0].body.params.length).toBe(4);
  });

  it('自定义 headers：构造级注入 X-API-Key（relay 鉴权），config.headers 优先', async () => {
    const calls = mockFetch({ result: { paymaster: PM_ADDR, data: '0xbeef' } });
    const pm = new PaymasterClient(makePaymasterCfg(), RELAY_URL, { 'X-API-Key': 'client-key' });
    await pm.getPaymasterData(makeOp(), CTX);
    expect(calls[0].headers['X-API-Key']).toBe('client-key');
    expect(calls[0].headers['content-type']).toBe('application/json');

    // config.headers 优先于构造级
    const calls2 = mockFetch({ result: { paymaster: PM_ADDR, data: '0xbeef' } });
    const pm2 = new PaymasterClient(
      { type: 'verifying', url: PAYMASTER_URL, headers: { 'X-API-Key': 'config-key' } },
      RELAY_URL,
      { 'X-API-Key': 'client-key' },
    );
    await pm2.getPaymasterData(makeOp(), CTX);
    expect(calls2[0].headers['X-API-Key']).toBe('config-key');
  });

  it('paymaster RPC 失败（HTTP 非 2xx）抛错且透传服务端消息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ message: 'policy not found' }),
    })));
    const pm = new PaymasterClient(makePaymasterCfg());
    await expect(pm.getPaymasterData(makeOp(), CTX)).rejects.toThrow(/policy not found/);
  });
});

describe('estimateUserOpGas（E-1a 编排）', () => {
  function makeChain(): ChainAAConfig {
    return {
      chainId: 84532,
      entryPointVersion: '0.7',
      entryPoint: ENTRYPOINT,
      rpcUrl: 'https://mock.invalid',
      bundlers: [{ url: 'https://bundler.invalid', priority: 0, timeoutMs: 1000 }] as BundlerConfig[],
      paymaster: makePaymasterCfg(),
    };
  }

  it('无 paymaster：一次估算填充 gas 字段', async () => {
    // stub BundlerClient.estimateUserOperationGas
    const est = vi.fn().mockResolvedValue({
      callGasLimit: 123456n,
      verificationGasLimit: 654321n,
      preVerificationGas: 30000n,
    });
    const client = { estimateUserOperationGas: est } as any;
    const op = makeOp();
    const r = await estimateUserOpGas(op, { client });

    expect(est).toHaveBeenCalledTimes(1);
    expect(r.op.callGasLimit).toBe(123456n);
    expect(r.op.verificationGasLimit).toBe(654321n);
    expect(r.op.preVerificationGas).toBe(30000n);
    expect(r.op.paymaster).toBeUndefined();
  });

  it('有 paymaster：stub → 估算 → 正式 data，两次 paymaster 调用', async () => {
    const stubCall = vi.fn().mockResolvedValue({
      op: { paymaster: PM_ADDR, paymasterData: '0xstub', paymasterVerificationGasLimit: 21000n, preVerificationGas: 42000n },
    });
    const dataCall = vi.fn().mockResolvedValue({
      op: { paymaster: PM_ADDR, paymasterData: '0xreal' },
    });
    const pm = { getPaymasterStubData: stubCall, getPaymasterData: dataCall } as any;
    const est = vi.fn().mockResolvedValue({
      callGasLimit: 123456n,
      verificationGasLimit: 654321n,
      preVerificationGas: 30000n,
    });
    const client = { estimateUserOperationGas: est } as any;

    const op = makeOp();
    const r = await estimateUserOpGas(op, { client, paymaster: pm, paymasterCtx: CTX });

    // stub → estimate（带 stub paymaster 字段）→ 正式 data
    expect(stubCall).toHaveBeenCalledTimes(1);
    expect(est).toHaveBeenCalledTimes(1);
    expect(dataCall).toHaveBeenCalledTimes(1);
    // 估算入参应含 stub paymaster（paymaster 参与验证阶段估算）
    const estInput = est.mock.calls[0][0];
    expect(estInput.paymaster).toBe(PM_ADDR);
    expect(estInput.paymasterData).toBe('0xstub');
    // 最终 op：正式 data 覆盖 stub；估算 gas 填充
    expect(r.op.paymasterData).toBe('0xreal');
    expect(r.op.paymasterVerificationGasLimit).toBe(21000n);
    expect(r.op.callGasLimit).toBe(123456n);
    expect(r.op.preVerificationGas).toBe(30000n);
  });
});
