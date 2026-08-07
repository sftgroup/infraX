// Session Key 签名器单测（P3.1，INFRAX_HANDOVER §6.1 映射 execute 接口）
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { SessionKeySigner } from '../src/signers/session-key.js';
import { createSigner } from '../src/signers/types.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const TARGET = '0x2222222222222222222222222222222222222222' as Address;
const USER_OP_HASH = `0x${'11'.repeat(32)}` as Hex;
const MESSAGE = `0x${'22'.repeat(32)}` as Hex;
const TX_HASH = `0x${'44'.repeat(32)}` as Hex;
const ENGINE_URL = 'http://engine.example:3500';
const TOKEN = 'test-token';
const SESSION_ID = 'sess_abc123';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** mock fetch：记录调用，返回固定 ApiResponse<ExecuteResult> */
function makeFetch(
  payload: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fn: ReturnType<typeof vi.fn>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { ok = true, status = 200 } = opts;
    return { ok, status, json: async () => payload };
  });
  return { fn, calls };
}

function okPayload(status: 'success' | 'failed' = 'success', extra: Record<string, unknown> = {}) {
  return {
    code: 200,
    data: {
      executionId: 'exec_1',
      txHash: status === 'success' ? TX_HASH : '',
      status,
      gasUsed: status === 'success' ? '21000' : undefined,
      errorReason: status === 'failed' ? 'CONTRACT_FORBIDDEN' : undefined,
      ...extra,
    },
    message: status === 'success' ? 'Transaction sent' : 'Transaction failed',
  };
}

function makeSigner(options: Record<string, unknown> = {}) {
  return new SessionKeySigner(ADDRESS, ENGINE_URL, TOKEN, {
    sessionId: SESSION_ID,
    chain: 'base',
    to: TARGET,
    ...options,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('SessionKeySigner', () => {
  it('exposes type session-key and resolved address', () => {
    const signer = makeSigner();
    expect(signer.type).toBe('session-key');
    expect(signer.address).toBe(ADDRESS);
  });

  it('signUserOp POSTs execute with userOpHash as data and returns txHash', async () => {
    const { fn, calls } = makeFetch(okPayload());
    vi.stubGlobal('fetch', fn);
    const signer = makeSigner();

    const txHash = await signer.signUserOp(USER_OP_HASH);

    expect(txHash).toBe(TX_HASH);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ENGINE_URL}/api/v1/execute`);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      sessionId: SESSION_ID,
      chain: 'base',
      to: TARGET,
      data: USER_OP_HASH,
    });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('signMessage POSTs execute with message as data', async () => {
    const { fn, calls } = makeFetch(okPayload());
    vi.stubGlobal('fetch', fn);
    const signer = makeSigner();

    const txHash = await signer.signMessage(MESSAGE);

    expect(txHash).toBe(TX_HASH);
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({ data: MESSAGE });
  });

  it('defaults to signer address when no target given', async () => {
    const { fn, calls } = makeFetch(okPayload());
    vi.stubGlobal('fetch', fn);
    const signer = new SessionKeySigner(ADDRESS, ENGINE_URL, TOKEN, { sessionId: SESSION_ID });

    await signer.signUserOp(USER_OP_HASH);

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.to).toBe(ADDRESS);
    expect(body.chain).toBe('eth'); // chain 缺省 'eth'
  });

  it('setSession() injects sessionId after construction', async () => {
    const { fn, calls } = makeFetch(okPayload());
    vi.stubGlobal('fetch', fn);
    const signer = new SessionKeySigner(ADDRESS, ENGINE_URL, TOKEN, { to: TARGET });

    await expect(signer.signUserOp(USER_OP_HASH)).rejects.toThrow(/missing sessionId/);

    signer.setSession(SESSION_ID);
    await signer.signUserOp(USER_OP_HASH);
    expect(calls).toHaveLength(1);
  });

  it('throws when sessionId missing', async () => {
    vi.stubGlobal('fetch', makeFetch(okPayload()).fn);
    const signer = new SessionKeySigner(ADDRESS, ENGINE_URL, TOKEN);
    await expect(signer.signUserOp(USER_OP_HASH)).rejects.toThrow(/missing sessionId/);
  });

  it('throws when engine URL missing (no env)', async () => {
    vi.stubEnv('SESSION_KEY_ENGINE_URL', '');
    const signer = new SessionKeySigner(ADDRESS, undefined, TOKEN, { sessionId: SESSION_ID });
    await expect(signer.signUserOp(USER_OP_HASH)).rejects.toThrow(/missing engine URL/);
  });

  it('falls back to SESSION_KEY_ENGINE_URL/TOKEN env', async () => {
    const { fn, calls } = makeFetch(okPayload());
    vi.stubGlobal('fetch', fn);
    vi.stubEnv('SESSION_KEY_ENGINE_URL', ENGINE_URL);
    vi.stubEnv('SESSION_KEY_ENGINE_TOKEN', TOKEN);
    const signer = new SessionKeySigner(ADDRESS, undefined, undefined, { sessionId: SESSION_ID });

    await signer.signUserOp(USER_OP_HASH);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ENGINE_URL}/api/v1/execute`);
  });

  it('throws with errorReason when Engine reports failed status', async () => {
    vi.stubGlobal('fetch', makeFetch(okPayload('failed')).fn);
    const signer = makeSigner();
    await expect(signer.signUserOp(USER_OP_HASH)).rejects.toThrow(/CONTRACT_FORBIDDEN/);
  });

  it('throws with message on non-200 response', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({ code: 400, message: 'sessionId, chain, to, data required' }, { ok: false, status: 400 }).fn,
    );
    const signer = makeSigner();
    await expect(signer.signUserOp(USER_OP_HASH)).rejects.toThrow(/sessionId, chain, to, data required/);
  });

  it('throws when txHash is empty in response', async () => {
    vi.stubGlobal('fetch', makeFetch(okPayload('success', { txHash: '' })).fn);
    const signer = makeSigner();
    await expect(signer.signUserOp(USER_OP_HASH)).rejects.toThrow(/empty txHash/);
  });

  it('throws with timeout message when engine is unresponsive', async () => {
    const neverFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    vi.stubGlobal('fetch', neverFetch);
    const signer = new SessionKeySigner(ADDRESS, ENGINE_URL, TOKEN, {
      sessionId: SESSION_ID,
      timeoutMs: 20,
    });
    await expect(signer.signUserOp(USER_OP_HASH)).rejects.toThrow(/timeout after 20ms/);
  });
});

describe('createSigner 工厂（sessionKeyEngine 路由）', () => {
  it('returns SessionKeySigner when sessionKeyEngine provided', async () => {
    vi.stubGlobal('fetch', makeFetch(okPayload()).fn);
    const signer = await createSigner({
      sessionKeyEngine: {
        address: ADDRESS,
        url: ENGINE_URL,
        token: TOKEN,
        sessionId: SESSION_ID,
        chain: 'base',
        to: TARGET,
      },
    });
    expect(signer.type).toBe('session-key');
    expect(signer.address).toBe(ADDRESS);
    expect(await signer.signUserOp(USER_OP_HASH)).toBe(TX_HASH);
  });

  it('prefers privateKey over sessionKeyEngine', async () => {
    const signer = await createSigner({
      privateKey: `0x${'aa'.repeat(32)}` as Hex,
      sessionKeyEngine: { address: ADDRESS, url: ENGINE_URL, token: TOKEN, sessionId: SESSION_ID },
    });
    expect(signer.type).toBe('private-key');
  });
});
