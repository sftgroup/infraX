// ============================================================================
// aa-relay 共享工具与中间件（E-1c/E-1b/AA-1 重构）
// 职责：① 入站 apikey 校验（静态 AA_RELAY_API_KEY + 外部 ar_ key 实时校验）；
//       ② 通用响应/参数/错误工具；③ bundler 多端点广播与错误分类；
//       ④ submitSignedOp —— 带签名 UserOp 的统一"校验+计费+广播+结算"提交流程
//       （/v1/session/revoke 与 /v1/session/replace/submit 共用，消除重复）。
// ============================================================================
import { createClient, http, type Address, type Hex } from 'viem';
import { randomUUID } from 'node:crypto';
import type { UserOperationV7 } from '../../aa-sdk/src/index.js';
import { getChainConfig, userOpToRpc } from '../../aa-sdk/src/index.js';
import { verifyDisableSignature, getUserOpHash } from '../../aa-sdk/src/index.js';
import { createKernelAccount, ExternalWalletSigner, BundlerClient } from '../../aa-sdk/src/index.js';
import type { ChainAAConfig } from '../../aa-sdk/src/index.js';
import { aaChargeConfigured, aaFees, estimateUserOpGasWei, chargeUserOp, settleUserOp } from './billing.js';

const RELAY_KEY = process.env.AA_RELAY_API_KEY || '';

// E-1c: 外部 apikey 实时校验（data /api-keys/verify，chain-rpc 同款 fail-closed 模式）
//   AA_RELAY_API_KEY                 静态本地 bridge key（内部服务调用，保留）
//   AA_API_KEY_VERIFY_URL            data 服务 URL（如 https://infrax.0xainet.top/api/data 或 http://127.0.0.1:9112）
//   AA_API_KEY_VERIFY_KEY            调 data 的鉴权 key（DATA_API_KEY，Bearer）
//   AA_API_KEY_VERIFY_SCOPE          签发 scope（默认 aa-relay → ar_ 前缀 key）
// 未配置 VERIFY_URL → 仅静态 key；配置后外部 key（ar_）实时校验，静态 key 仍放行。
const AA_API_KEY_VERIFY = {
  url: (process.env.AA_API_KEY_VERIFY_URL || '').replace(/\/+$/, ''),
  key: process.env.AA_API_KEY_VERIFY_KEY || '',
  scope: process.env.AA_API_KEY_VERIFY_SCOPE || 'aa-relay',
};

/** 外部签发 key 实时校验：POST {url}/api-keys/verify（fail-closed，5s 超时）。 */
async function matchExternalKey(key: string): Promise<boolean> {
  if (!AA_API_KEY_VERIFY.url || !AA_API_KEY_VERIFY.key) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${AA_API_KEY_VERIFY.url}/api-keys/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${AA_API_KEY_VERIFY.key}`,
      },
      body: JSON.stringify({ api_key: key, scope: AA_API_KEY_VERIFY.scope }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

// 入站鉴权：Bearer / X-API-Key / X-Service-Key 三选一。
// ① 静态本地 key（AA_RELAY_API_KEY）优先；② 配置了 AA_API_KEY_VERIFY_URL 时，
//    外部签发 key（ar_）经 data /api-keys/verify 实时校验（E-1c）；③ 均未配置 → 开放（开发模式）。
export async function authMw(req: any, res: any, next: any) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const key = (bearer || req.headers['x-api-key'] || req.headers['x-service-key'] || '').trim();
  if (!key) {
    if (!RELAY_KEY && !AA_API_KEY_VERIFY.url) return next();
    res.status(401).json({ code: 401, message: 'unauthorized', data: null });
    return;
  }
  if (RELAY_KEY && key === RELAY_KEY) return next();
  if (AA_API_KEY_VERIFY.url && (await matchExternalKey(key))) return next();
  res.status(401).json({ code: 401, message: 'unauthorized', data: null });
}

export function asyncHandler(fn: any) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** 递归将对象/数组中的 BigInt 转为字符串（JSON.stringify 不支持 BigInt，res.json 会抛 "Do not know how to serialize a BigInt"） */
function jsonSafe(v: any): any {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) out[k] = jsonSafe(x);
    return out;
  }
  return v;
}

export function apiResponse(data: any = null, message = 'success', code = 0) {
  return { code, message, data: jsonSafe(data) };
}

export function getChain(chain: string): ChainAAConfig {
  if (!chain || typeof chain !== 'string') {
    throw Object.assign(new Error('chain required (e.g. oxachain)'), { statusCode: 400 });
  }
  try {
    return getChainConfig(chain, process.env);
  } catch (e: any) {
    throw Object.assign(new Error(`unknown or misconfigured chain '${chain}': ${e.message}`), { statusCode: 400 });
  }
}

// RPC 格式 UserOp（hex 字段）→ SDK UserOperationV7（bigint 字段）
export function normalizeOp(op: Record<string, any>): UserOperationV7 {
  const b = (v: any): bigint =>
    v === undefined || v === null ? 0n : typeof v === 'bigint' ? v : BigInt(v);
  const o: any = {
    sender: op.sender,
    nonce: b(op.nonce),
    callData: op.callData,
    callGasLimit: b(op.callGasLimit),
    verificationGasLimit: b(op.verificationGasLimit),
    preVerificationGas: b(op.preVerificationGas),
    maxFeePerGas: b(op.maxFeePerGas),
    maxPriorityFeePerGas: b(op.maxPriorityFeePerGas),
    signature: op.signature,
  };
  if (op.factory) o.factory = op.factory;
  if (op.factoryData) o.factoryData = op.factoryData;
  if (op.paymaster) {
    o.paymaster = op.paymaster;
    o.paymasterVerificationGasLimit = b(op.paymasterVerificationGasLimit);
    o.paymasterPostOpGasLimit = b(op.paymasterPostOpGasLimit);
    o.paymasterData = op.paymasterData;
  }
  return o;
}

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

// ============================================================================
// submitSignedOp —— 带 owner 签名 UserOp 的统一提交流程（AA-1/AA-7 重构去重）
// 步骤：① owner 派生账户一致性（防篡改）→ ② 签名校验（ECDSA recoverAddress）
//       → ③ op 实际 userOpHash === 已签名 userOpHash（防篡改/错配）
//       → ④ A-10 计费预扣（固定次数费 + 预估 gas，subscriber = 智能账户）
//       → ⑤ 广播：wait=false 仅返回 hash；否则等收据并按 actualGasCost 结算退差
//       → 广播失败 / bundler 业务拒绝 → 全额退还预扣
// onSuccess 在广播成功后、响应前执行（如移除旧 session 记录）。
// ============================================================================
export interface SubmitSignedOpParams {
  chain: string;
  cfg: ChainAAConfig;
  account: Address;
  owner: Address;
  sessionId?: string; // 仅用于派生校验错误提示
  userOpHash: Hex;
  signature: Hex;
  op: Record<string, any>;
  wait?: boolean;
  /** 计费参考前缀（aa:revoke / aa:replace 等），用于账本追溯 */
  chargeLabel: string;
  onSuccess?: (res: { userOpHash: Hex; bundlerUrl: string; receipt: any }) => Promise<void> | void;
}

export async function submitSignedOp(params: SubmitSignedOpParams): Promise<{ userOpHash: Hex; bundlerUrl: string; receipt: any }> {
  const { cfg, account, owner, userOpHash, signature, op, wait, chargeLabel, onSuccess } = params;
  // ① owner 派生账户一致性（ExternalWalletSigner 只用于地址派生，无 provider 调用）
  const ownerSigner = new ExternalWalletSigner(
    { request: () => { throw new Error('no provider on server'); } } as any,
    owner,
  );
  const derived = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  if (derived.address.toLowerCase() !== String(account).toLowerCase()) {
    throw Object.assign(new Error('owner does not derive the given account'), { statusCode: 400 });
  }
  // ② 签名校验（owner 对 userOpHash 的 ECDSA；eth_sign 原始签名，viem recoverAddress）
  const valid = await verifyDisableSignature({ userOpHash, signature, owner });
  if (!valid) {
    throw Object.assign(new Error('signature verification failed'), { statusCode: 400 });
  }
  // ③ 组装待广播 UserOp（draft op 无签名）：校验 op 实际 hash 一致（防篡改）+ 注入 owner 签名
  const userOp = normalizeOp(op);
  const opHash = getUserOpHash(userOp, cfg.entryPoint, cfg.chainId);
  if (opHash.toLowerCase() !== String(userOpHash).toLowerCase()) {
    throw Object.assign(new Error('op does not match signed userOpHash'), { statusCode: 400 });
  }
  userOp.signature = signature;
  // ④ A-10 计费预扣
  const subscriber = String(account).toLowerCase();
  let chargeTotal = 0n;
  let chargeRef = '';
  if (aaChargeConfigured()) {
    const fixed = BigInt(aaFees().userop.feeWei);
    const gasEst = estimateUserOpGasWei(userOp);
    chargeTotal = fixed + gasEst;
    if (chargeTotal > 0n) {
      chargeRef = `aa:${chargeLabel}:${randomUUID()}`;
      await chargeUserOp(subscriber, chargeRef, chargeTotal); // 402/503 直接抛（asyncHandler → 错误处理器）
    }
  }
  // ⑤ 广播（wait=false 直接返回 hash；否则等收据）
  if (wait === false) {
    try {
      const res = await broadcast(cfg, userOp);
      await onSuccess?.({ ...res, receipt: null });
      return { ...res, receipt: null };
    } catch (e) {
      // 广播失败 → 全额退还预扣
      if (chargeTotal > 0n) {
        try { await settleUserOp(subscriber, chargeRef, chargeTotal, 0n); }
        catch (bErr: any) { console.warn(`[aa-relay] ${chargeLabel} refund failed:`, bErr.message); }
      }
      throw e;
    }
  }
  const client = new BundlerClient(cfg);
  try {
    const result = await client.sendUserOperation(userOp, {
      waitTimeoutMs: 120_000,
      onBroadcast: (h: any) => console.log(`[aa-relay] ${chargeLabel} ${params.chain} userOpHash=${h} accepted`),
    });
    // 收据后按 actualGasCost 结算退差（多退少补）；结算失败仅告警
    if (chargeTotal > 0n && result.receipt) {
      try {
        await settleUserOp(subscriber, chargeRef, chargeTotal, BigInt(aaFees().userop.feeWei) + result.receipt.actualGasCost);
      } catch (bErr: any) {
        console.warn(`[aa-relay] ${chargeLabel} gas settle failed:`, bErr.message);
      }
    }
    const res = { userOpHash: result.userOpHash, bundlerUrl: result.bundlerUrl, receipt: result.receipt ?? null };
    await onSuccess?.(res);
    return res;
  } catch (e: any) {
    if (isBundlerBusinessError(e)) {
      // bundler 业务拒绝（交易未执行）→ 全额退还预扣
      if (chargeTotal > 0n) {
        try { await settleUserOp(subscriber, chargeRef, chargeTotal, 0n); }
        catch (bErr: any) { console.warn(`[aa-relay] ${chargeLabel} refund failed:`, bErr.message); }
      }
      throw Object.assign(new Error(`bundler: ${rpcErrorMessage(e)}`), { statusCode: 400 });
    }
    throw e;
  }
}
