// E-1d：MpcSigner 单测（对接 MPC 服务 sign-digest / sign-message）
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Address, Hex } from 'viem';
import { MpcSigner } from '../src/signers/mpc.js';

const SERVICE = 'http://127.0.0.1:9104';
const TOKEN = 'mpc_token_1';
const ADDR = '0xbe9da94489410fc33e13244bb9fae42d3d945edc' as Address;
const SIG = '0x' + 'ab'.repeat(65) as Hex;

/** 模拟 fetch：记录请求，返回签名信封 */
function mockMpc(signature: Hex) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ code: 0, message: 'ok', data: { signature, address: ADDR } }) };
  }));
  return calls;
}

beforeEach(() => vi.unstubAllGlobals());

describe('MpcSigner', () => {
  it('signUserOp：POST /api/v2/mpc/sign-digest，body 为 { token, digest }，返回签名', async () => {
    const calls = mockMpc(SIG);
    const signer = new MpcSigner(ADDR, SERVICE, TOKEN);
    const hash = '0x' + '11'.repeat(32) as Hex;
    const sig = await signer.signUserOp(hash);

    expect(sig).toBe(SIG);
    expect(calls[0].url).toBe(`${SERVICE}/api/v2/mpc/sign-digest`);
    expect(calls[0].body).toEqual({ token: TOKEN, digest: hash });
    // 与 Kernel ECDSA validator 期望的 65B serialized 格式一致
    expect(sig.startsWith('0x')).toBe(true);
    expect(sig.length).toBe(2 + 65 * 2);
  });

  it('signMessage：POST /api/v2/mpc/sign-message（EIP-191 由服务端 hashMessage）', async () => {
    const calls = mockMpc(SIG);
    const signer = new MpcSigner(ADDR, SERVICE, TOKEN);
    const sig = await signer.signMessage('0x68656c6c6f' as Hex); // 'hello'

    expect(sig).toBe(SIG);
    expect(calls[0].url).toBe(`${SERVICE}/api/v2/mpc/sign-message`);
    expect(calls[0].body.token).toBe(TOKEN);
    expect(calls[0].body.message).toBe('0x68656c6c6f');
  });

  it('MPC 服务 4xx 抛错且透传消息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: 401, message: 'session expired' }),
    })));
    const signer = new MpcSigner(ADDR, SERVICE, TOKEN);
    await expect(signer.signUserOp('0x' + '22'.repeat(32) as Hex)).rejects.toThrow(/session expired/);
  });

  it('serviceUrl 尾部斜杠容错', async () => {
    const calls = mockMpc(SIG);
    const signer = new MpcSigner(ADDR, `${SERVICE}/`, TOKEN);
    await signer.signUserOp('0x' + '33'.repeat(32) as Hex);
    expect(calls[0].url).toBe(`${SERVICE}/api/v2/mpc/sign-digest`);
  });
});
