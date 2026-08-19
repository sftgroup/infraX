// ============================================================================
// aa-relay — ERC-4337 UserOp 转发网关（E-1c）
// 职责：① 入站 apikey 校验（AA_RELAY_API_KEY）；② UserOp 转发 eth_sendUserOperation
//       （多 bundler 容灾，失败自动切换备端点）；③ 收据查询 eth_getUserOperationReceipt；
//       ④ gas 估算 eth_estimateUserOperationGas。
// 链配置复用 aa-sdk（env AA_{CHAIN}_* 零硬编码）；bundler URL 由服务端注入（apikey 代理）。
// ============================================================================
import express from 'express';
import { createClient, http, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  BundlerClient,
  getChainConfig,
  getEnabledChains,
  userOpToRpc,
  createKernelAccount,
  createAAClient,
  ExternalWalletSigner,
  assertValidPolicy,
  encodeEnableSessionCall,
  encodeDisableSessionCall,
  validateSessionCall,
  buildDisableSessionUserOp,
  verifyDisableSignature,
  getUserOpHash,
  isSessionModuleInstalled,
  isPolicySuperset,
  estimateFeesPerGas,
  FALLBACK_GAS,
  DEFAULT_GAS_PRICE,
  type ChainAAConfig,
  type UserOperationV7,
  type SessionPolicy,
} from '../../aa-sdk/src/index.js';
import { PostgresSessionStore } from './session-store.js';
// A-10: session 订阅计费（UserOp 次数费 + paymaster gas 代付按实际结算）
import { aaChargeConfigured, escrowConfigured, aaFees, estimateUserOpGasWei, chargeUserOp, settleUserOp, aaLedgerBalance, aaPlansInfo, AABillingError } from './billing.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

function cors() {
  return (_req: any, res: any, next: any) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Service-Key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

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

// E-3a/b：session 持久化存储（Postgres，多租户 product 维度，重启不失效）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ubuntu@localhost:5432/pocketx_mpc',
});
const sessionStore = new PostgresSessionStore(pool);
sessionStore.initTables().catch((e) => console.error('[aa-relay] session table init error:', e.message));

// GET /health 免鉴权（供监控/负载均衡）
app.get('/health', (_req: any, res: any) => {
  const chains = getEnabledChains(process.env);
  const bundlers: Record<string, string[]> = {};
  for (const c of chains) {
    try {
      bundlers[c] = getChainConfig(c, process.env).bundlers.map((b) => b.url);
    } catch (e: any) {
      bundlers[c] = [`ERROR: ${e.message}`];
    }
  }
  res.json({ status: 'ok', service: 'aa-relay', chains, bundlers });
});

// 入站鉴权：Bearer / X-API-Key / X-Service-Key 三选一。
// ① 静态本地 key（AA_RELAY_API_KEY）优先；② 配置了 AA_API_KEY_VERIFY_URL 时，
//    外部签发 key（ar_）经 data /api-keys/verify 实时校验（E-1c）；③ 均未配置 → 开放（开发模式）。
async function authMw(req: any, res: any, next: any) {
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
app.use(authMw);

function asyncHandler(fn: any) {
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

function apiResponse(data: any = null, message = 'success', code = 0) {
  return { code, message, data: jsonSafe(data) };
}

function getChain(chain: string): ChainAAConfig {
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
function normalizeOp(op: Record<string, any>): UserOperationV7 {
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

function rpcClient(url: string, timeoutMs = 30_000): RpcClient {
  return createClient({ transport: http(url, { timeout: timeoutMs }) }) as unknown as RpcClient;
}

// bundler 业务错误（JSON-RPC 错误码如 -32500/FailedOp/AA20）→ 400 简洁透传；
// 网络错误（fetch failed / 连接失败，code 为字符串或 undefined）→ 切换备端点。
// 错误可能包在 cause 链里且 cause 可能是数组（BundlerError.cause = [err]），用队列 BFS 遍历。
// viem 2.x：RpcError（数字 code）→ RpcRequestError（JSON-RPC 层包装，业务错误）；
//           HttpRequestError（HTTP/网络层，区分网络故障）。toAAError 保留数字 code 与 cause 链。
function isBundlerBusinessError(e: any): boolean {
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
function rpcErrorMessage(e: any): string {
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
async function broadcast(cfg: ChainAAConfig, op: UserOperationV7): Promise<{ userOpHash: Hex; bundlerUrl: string }> {
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

// POST /v1/userops
app.post('/v1/userops', asyncHandler(async (req: any, res: any) => {
  const { chain, op, wait } = req.body || {};
  if (!op || !op.sender || !op.callData) {
    return res.status(400).json(apiResponse(null, 'op.sender + op.callData required', 1001));
  }
  const cfg = getChain(chain);
  const userOp = normalizeOp(op);

  // A-10: session 订阅计费——广播前预扣（固定次数费 + 预估 gas）；subscriber = 智能账户
  const subscriber = userOp.sender.toLowerCase();
  let chargeTotal = 0n;
  let chargeRef = '';
  if (aaChargeConfigured()) {
    const fixed = BigInt(aaFees().userop.feeWei);
    const gasEst = estimateUserOpGasWei(userOp);
    chargeTotal = fixed + gasEst;
    if (chargeTotal > 0n) {
      chargeRef = `aa:userop:${randomUUID()}`;
      await chargeUserOp(subscriber, chargeRef, chargeTotal); // 402/503 直接抛（asyncHandler → 错误处理器）
    }
  }

  if (wait === false) {
    try {
      const { userOpHash, bundlerUrl } = await broadcast(cfg, userOp);
      return res.json(apiResponse({ userOpHash, bundlerUrl, receipt: null }, 'UserOp broadcast'));
    } catch (e) {
      // A-10: 广播失败 → 全额退还预扣
      if (chargeTotal > 0n) {
        try { await settleUserOp(subscriber, chargeRef, chargeTotal, 0n); }
        catch (bErr: any) { console.warn('[aa-relay] userop refund failed:', bErr.message); }
      }
      throw e;
    }
  }

  const client = new BundlerClient(cfg);
  try {
    const result = await client.sendUserOperation(userOp, {
      waitTimeoutMs: 120_000,
      onBroadcast: (hash) => console.log(`[aa-relay] ${chain} userOpHash=${hash} accepted`),
    });
    // A-10: 收据后按 actualGasCost 结算退差（多退少补）；结算失败仅告警
    if (chargeTotal > 0n && result.receipt) {
      try {
        const fixed = BigInt(aaFees().userop.feeWei);
        await settleUserOp(subscriber, chargeRef, chargeTotal, fixed + result.receipt.actualGasCost);
      } catch (bErr: any) {
        console.warn('[aa-relay] userop gas settle failed:', bErr.message);
      }
    }
    res.json(apiResponse({
      userOpHash: result.userOpHash,
      bundlerUrl: result.bundlerUrl,
      receipt: result.receipt ?? null,
    }, 'UserOp sent'));
  } catch (e: any) {
    if (isBundlerBusinessError(e)) {
      // A-10: bundler 业务拒绝（交易未执行）→ 全额退还预扣
      if (chargeTotal > 0n) {
        try { await settleUserOp(subscriber, chargeRef, chargeTotal, 0n); }
        catch (bErr: any) { console.warn('[aa-relay] userop refund failed:', bErr.message); }
      }
      return res.status(400).json(apiResponse(null, `bundler: ${rpcErrorMessage(e)}`, 1001));
    }
    throw e;
  }
}));

// GET /v1/userops/:hash（收据查询，单次；主端点失败切备）
app.get('/v1/userops/:hash', asyncHandler(async (req: any, res: any) => {
  const { hash } = req.params;
  const chain = req.query.chain;
  const cfg = getChain(chain);
  const endpoints = [...cfg.bundlers].sort((a, b) => a.priority - b.priority);
  let lastErr: unknown;
  for (const ep of endpoints) {
    try {
      const client = rpcClient(ep.url, ep.timeoutMs);
      const r = (await client.request({
        method: 'eth_getUserOperationReceipt',
        params: [hash],
      })) as any;
      return res.json(apiResponse({ receipt: r ?? null }));
    } catch (e) {
      lastErr = e;
    }
  }
  throw Object.assign(new Error(`receipt lookup failed: ${rpcErrorMessage(lastErr as any)}`), { statusCode: 502 });
}));

// POST /v1/estimate（UserOp gas 估算）
app.post('/v1/estimate', asyncHandler(async (req: any, res: any) => {
  const { chain, op } = req.body || {};
  if (!op || !op.sender || !op.callData) {
    return res.status(400).json(apiResponse(null, 'op.sender + op.callData required', 1001));
  }
  const cfg = getChain(chain);
  const client = new BundlerClient(cfg);
  try {
    const gas = await client.estimateUserOperationGas(normalizeOp(op));
    res.json(apiResponse({
      callGasLimit: gas.callGasLimit?.toString(),
      verificationGasLimit: gas.verificationGasLimit?.toString(),
      preVerificationGas: gas.preVerificationGas?.toString(),
    }));
  } catch (e: any) {
    if (isBundlerBusinessError(e)) {
      return res.status(400).json(apiResponse(null, `bundler: ${rpcErrorMessage(e)}`, 1001));
    }
    throw e;
  }
}));

// POST /v1/paymaster —— paymaster RPC 代理（E-1a：隐藏 Pimlico apikey，服务端持有）
// 契约：{ chain, method, params }（method ∈ pimlico_getPaymasterData/StubData 等）
// → 转发到该链 AA_{CHAIN}_PAYMASTER_URL；未配置 paymaster 的链返回 400。
app.post('/v1/paymaster', asyncHandler(async (req: any, res: any) => {
  const { chain, method, params } = req.body || {};
  if (!chain || !method || !Array.isArray(params)) {
    return res.status(400).json(apiResponse(null, 'chain + method + params required', 1001));
  }
  const cfg = getChain(chain);
  if (!cfg.paymaster?.url) {
    return res.status(400).json(apiResponse(null, `chain '${chain}' has no paymaster configured`, 1001));
  }
  const client = rpcClient(cfg.paymaster.url);
  try {
    const result = (await client.request({ method, params })) as unknown;
    res.json(apiResponse(result));
  } catch (e: any) {
    if (isBundlerBusinessError(e)) {
      return res.status(400).json(apiResponse(null, `paymaster: ${rpcErrorMessage(e)}`, 1001));
    }
    throw e;
  }
}));

// ============================================================================
// E-3a/b 用户钱包 session（owner=用户 EOA，agent=session key，链上 Kernel validator 强制）
//   POST /v1/session           创建：生成 session key + 策略落库(product) + 返回 enableCallData
//   GET  /v1/session           查询账户名下 session 列表
//   POST /v1/session/disable   撤销：本地移除 + 返回 disableCallData（owner 签名上链后即时失效）
//   POST /v1/session/validate  链下预检（与链上策略一致性，E-3b）
// enable/disable 的链上生效由 owner EOA 签名 UserOp 后经 /v1/userops 完成（验收：链上验证）。
// ============================================================================

// POST /v1/session —— 创建 / 复用（AA-6 B2）
app.post('/v1/session', asyncHandler(async (req: any, res: any) => {
  const { chain, product = 'default', owner, permissions, validUntil, validAfter } = req.body || {};
  if (!owner || !Array.isArray(permissions) || permissions.length === 0 || !validUntil) {
    return res.status(400).json(apiResponse(null, 'owner + permissions + validUntil required', 1001));
  }
  const cfg = getChain(chain);
  // ① 预测智能账户地址（counterfactual；owner EOA 无需签名，服务端无窗口 provider 不会触发）
  const ownerSigner = new ExternalWalletSigner(
    { request: () => { throw new Error('no provider on server'); } } as any,
    owner as Address,
  );
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  // ② 生成 session key（本地 secp256k1）+ 策略
  const privateKey = generatePrivateKey();
  const signer = privateKeyToAccount(privateKey).address;
  const policy: SessionPolicy = {
    network: 'evm',
    sessionId: toHex(randomBytes(32)),
    signer,
    validAfter: BigInt(validAfter ?? 0),
    validUntil: BigInt(validUntil),
    permissions,
  };
  assertValidPolicy(policy);
  // ③ 残留检测（AA-3 链上探测）：账户是否已绑定 session validator（ERC-7579 视图）
  let isBound = false;
  try {
    isBound = await isSessionModuleInstalled({ client: createAAClient(cfg), chainConfig: cfg, account: account.address });
  } catch (e: any) {
    console.warn(`[aa-relay] session bound probe failed (${chain}): ${e.message}`);
  }
  // ④ AA-6 B2：已绑定 → 尝试复用既有兼容 session（同 product 由 list 过滤；复用判断以链上状态为准）
  if (isBound) {
    const existing = await sessionStore.list(product, account.address, 'evm');
    const candidate = existing.find((e) => isPolicySuperset({ existing: e, requested: policy }));
    if (candidate) {
      // 复用：返回既有 sessionId/sessionKey，零额外链上交易（复用即再次下发 key，调用方为同 owner）
      const withKey = await sessionStore.getWithKey(product, candidate.sessionId, 'evm');
      return res.json(apiResponse({
        product,
        accountAddress: account.address,
        isDeployed: account.isDeployed,
        isBound: true,
        needsSessionRevoke: false,
        reused: true,
        sessionId: candidate.sessionId,
        signer: candidate.signer,
        sessionKey: withKey?.sessionKey,
        validAfter: candidate.validAfter.toString(),
        validUntil: candidate.validUntil.toString(),
        permissions: candidate.permissions,
        enableCallData: null, // 无需上链
      }, 'session reused'));
    }
    // 无兼容 session → 409：引导先撤销再 enable（防 L12 AA23 复现）
    return res.status(409).json(apiResponse({
      accountAddress: account.address,
      isBound: true,
      needsSessionRevoke: true,
    }, 'session-conflict: account already bound to an incompatible session; disable + revoke first, then enable again', 1001));
  }
  // ⑤ 未绑定 → 正常创建：落库（持久化 sessionKey 供复用）+ enable 编码（owner 组装 UserOp 签名后发 /v1/userops）
  await sessionStore.save(product, policy, account.address, privateKey);
  const enableCallData = encodeEnableSessionCall({ accountAddress: account.address, policy, chainConfig: cfg });
  res.json(apiResponse({
    product,
    accountAddress: account.address,
    isDeployed: account.isDeployed,
    isBound: false,
    needsSessionRevoke: false,
    sessionId: policy.sessionId,
    signer,
    sessionKey: privateKey,
    validAfter: policy.validAfter.toString(),
    validUntil: policy.validUntil.toString(),
    enableCallData,
  }, 'session created'));
}));

// GET /v1/session —— 查询（AA-5：补 createdAt + 链上 isBound，供调用方选残留 session）
app.get('/v1/session', asyncHandler(async (req: any, res: any) => {
  const account = req.query.account;
  const product = req.query.product ?? 'default';
  if (!account) return res.status(400).json(apiResponse(null, 'account required', 1001));
  const cfg = getChain(req.query.chain);
  const policies = await sessionStore.list(product, account as Address, 'evm');
  // 链上绑定探测（账户级，一次探测供所有 session 行复用；isBound 为账户是否绑定 session validator）
  let isBound = false;
  try {
    isBound = await isSessionModuleInstalled({ client: createAAClient(cfg), chainConfig: cfg, account: account as Address });
  } catch (e: any) {
    console.warn(`[aa-relay] session bound probe failed (${req.query.chain}): ${e.message}`);
  }
  // BigInt 无法被 res.json 序列化 → 时间戳转字符串输出
  res.json(apiResponse(policies.map((p) => ({
    network: p.network,
    sessionId: p.sessionId,
    signer: p.signer,
    validAfter: p.validAfter.toString(),
    validUntil: p.validUntil.toString(),
    permissions: p.permissions,
    createdAt: p.createdAt,
    isBound,
  }))));
}));

// POST /v1/session/disable —— 撤销（AA-1 阶段 1：本地停用 + 返回上链撤销 draft）
// 兼容旧行为：本地 remove + 返回 disableCallData（单调用 uninstall）；
// 新增 AA-1 draft：完整 disable UserOp（root nonce + 批量 uninstall+invalidateNonce，
// 解决 L12 InvalidNonce）。调用方对 draft.userOpHash 签名后 POST /v1/session/revoke 上链。
app.post('/v1/session/disable', asyncHandler(async (req: any, res: any) => {
  const { chain, product = 'default', account, sessionId } = req.body || {};
  if (!account || !sessionId) return res.status(400).json(apiResponse(null, 'account + sessionId required', 1001));
  const cfg = getChain(chain);
  const found = (await sessionStore.list(product, account as Address, 'evm')).some((p) => p.sessionId === sessionId);
  await sessionStore.remove(product, sessionId, 'evm');
  const disableCallData = encodeDisableSessionCall({ accountAddress: account as Address, sessionId, chainConfig: cfg });
  // AA-1: 上链撤销 draft（估 gas/fee 后重算 hash；失败则 draft=null，调用方仍可用单调用 disableCallData）
  let draft = null;
  try {
    const client = createAAClient(cfg);
    const draft0 = await buildDisableSessionUserOp({
      client, chainConfig: cfg, account: account as Address, sessionId,
    });
    let gas: Partial<Pick<UserOperationV7, 'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas' | 'maxPriorityFeePerGas'>> = {};
    try {
      gas = await new BundlerClient(cfg).estimateUserOperationGas(draft0.op);
    } catch {
      gas = { ...FALLBACK_GAS };
    }
    let fee: Record<string, bigint> = {};
    try {
      fee = await estimateFeesPerGas(cfg);
    } catch {
      fee = { maxFeePerGas: DEFAULT_GAS_PRICE, maxPriorityFeePerGas: DEFAULT_GAS_PRICE };
    }
    draft = await buildDisableSessionUserOp({
      client, chainConfig: cfg, account: account as Address, sessionId, gas: { ...gas, ...fee },
    });
  } catch (e: any) {
    console.warn(`[aa-relay] disable draft build failed (${chain}): ${e.message}`);
  }
  res.json(apiResponse({
    accountAddress: account,
    sessionId,
    found,
    disableCallData,
    draft,
  }, 'session disabled'));
}));

// POST /v1/session/revoke —— AA-1 阶段 2：带签名上链撤销（owner 签名 disable UserOp）
// body: { chain, account, owner, sessionId, userOpHash, signature, op, wait? }
//   ① 校验 owner 派生账户 === account（防篡改）
//   ② 校验 recoverAddress(userOpHash, signature) === owner
//   ③ 广播 disable UserOp（root nonce + 批量 uninstall+invalidateNonce），链上彻底撤销
app.post('/v1/session/revoke', asyncHandler(async (req: any, res: any) => {
  const { chain, account, owner, sessionId, userOpHash, signature, op, wait } = req.body || {};
  if (!account || !owner || !sessionId || !userOpHash || !signature || !op) {
    return res.status(400).json(apiResponse(null, 'account + owner + sessionId + userOpHash + signature + op required', 1001));
  }
  const cfg = getChain(chain);
  // ① owner 派生账户一致性（ExternalWalletSigner 只用于地址派生，无 provider 调用）
  const ownerSigner = new ExternalWalletSigner(
    { request: () => { throw new Error('no provider on server'); } } as any,
    owner as Address,
  );
  const derived = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  if (derived.address.toLowerCase() !== String(account).toLowerCase()) {
    return res.status(400).json(apiResponse(null, 'owner does not derive the given account', 1001));
  }
  // ② 签名校验（owner 对 userOpHash 的 ECDSA；eth_sign 原始签名，viem recoverAddress）
  const valid = await verifyDisableSignature({ userOpHash, signature, owner: owner as Address });
  if (!valid) {
    return res.status(400).json(apiResponse(null, 'signature verification failed', 1001));
  }
  // ③ 组装待广播 UserOp（draft op 无签名）：
  //    ③a 校验 op 实际 userOpHash === 已签名 userOpHash（防篡改/错配，先于计费失败快速返回）
  //    ③b 注入 owner 签名（eth_sign 原始 ECDSA 对 digest 签名，Kernel validator ecrecover 校验）
  const userOp = normalizeOp(op);
  const opHash = getUserOpHash(userOp, cfg.entryPoint, cfg.chainId);
  if (opHash.toLowerCase() !== String(userOpHash).toLowerCase()) {
    return res.status(400).json(apiResponse(null, 'op does not match signed userOpHash', 1001));
  }
  userOp.signature = signature;
  const subscriber = String(account).toLowerCase();
  let chargeTotal = 0n;
  let chargeRef = '';
  if (aaChargeConfigured()) {
    const fixed = BigInt(aaFees().userop.feeWei);
    const gasEst = estimateUserOpGasWei(userOp);
    chargeTotal = fixed + gasEst;
    if (chargeTotal > 0n) {
      chargeRef = `aa:revoke:${randomUUID()}`;
      await chargeUserOp(subscriber, chargeRef, chargeTotal);
    }
  }
  if (wait === false) {
    try {
      const { userOpHash: hash, bundlerUrl } = await broadcast(cfg, userOp);
      return res.json(apiResponse({ userOpHash: hash, bundlerUrl, receipt: null }, 'session revoked'));
    } catch (e) {
      if (chargeTotal > 0n) {
        try { await settleUserOp(subscriber, chargeRef, chargeTotal, 0n); }
        catch (bErr: any) { console.warn('[aa-relay] revoke refund failed:', bErr.message); }
      }
      throw e;
    }
  }
  const client = new BundlerClient(cfg);
  try {
    const result = await client.sendUserOperation(userOp, {
      waitTimeoutMs: 120_000,
      onBroadcast: (h) => console.log(`[aa-relay] revoke ${chain} userOpHash=${h} accepted`),
    });
    if (chargeTotal > 0n && result.receipt) {
      try {
        await settleUserOp(subscriber, chargeRef, chargeTotal, BigInt(aaFees().userop.feeWei) + result.receipt.actualGasCost);
      } catch (bErr: any) {
        console.warn('[aa-relay] revoke gas settle failed:', bErr.message);
      }
    }
    res.json(apiResponse({
      userOpHash: result.userOpHash,
      bundlerUrl: result.bundlerUrl,
      receipt: result.receipt ?? null,
    }, 'session revoked'));
  } catch (e: any) {
    if (isBundlerBusinessError(e)) {
      if (chargeTotal > 0n) {
        try { await settleUserOp(subscriber, chargeRef, chargeTotal, 0n); }
        catch (bErr: any) { console.warn('[aa-relay] revoke refund failed:', bErr.message); }
      }
      return res.status(400).json(apiResponse(null, `bundler: ${rpcErrorMessage(e)}`, 1001));
    }
    throw e;
  }
}));

// POST /v1/session/validate —— 链下预检（E-3b：与链上模块策略一致）
app.post('/v1/session/validate', asyncHandler(async (req: any, res: any) => {
  const { policy, call, nowSec } = req.body || {};
  if (!policy || !call) return res.status(400).json(apiResponse(null, 'policy + call required', 1001));
  const now = BigInt(nowSec ?? Math.floor(Date.now() / 1000));
  const result = validateSessionCall(policy, call, now);
  if (result.ok) return res.json(apiResponse({ ok: true }, 'allowed'));
  res.json(apiResponse({ ok: false, reason: result.reason }, `denied: ${result.reason}`, 1001));
}));

// ═══ A-10: session 订阅计费（UserOp 次数费 + paymaster gas 代付）═══

// GET /v1/plans — 套餐价目（公开）
app.get('/v1/plans', (_req: any, res: any) => {
  res.json(apiResponse(aaPlansInfo(), 'AA session billing plans'));
});

// POST /v1/ledger-balance — 智能账户 ledger 余额（REQ-2a：escrow 模式读链上托管，不要求 ledger 配置）
app.post('/v1/ledger-balance', asyncHandler(async (req: any, res: any) => {
  const { account } = req.body || {};
  if (!account) return res.status(400).json(apiResponse(null, 'account required (smart account address)', 1001));
  if (!aaChargeConfigured() && !escrowConfigured()) {
    return res.status(503).json(apiResponse(null, 'AA session billing is not configured (AA_PAYMENTS_URL/AA_PAYMENTS_API_KEY/AA_PLATFORM_ADDRESS or ESCROW_*)', 1007));
  }
  try {
    const balance = await aaLedgerBalance(String(account));
    res.json(apiResponse(balance, 'Ledger balance'));
  } catch (e: any) {
    res.status(e instanceof AABillingError ? e.status : 503)
      .json(apiResponse(null, e?.message || 'ledger balance unavailable', 1007));
  }
}));

// 统一 JSON 错误处理器
app.use((err: any, _req: any, res: any, _next: any) => {
  const status = err instanceof AABillingError
    ? err.status
    : typeof err?.statusCode === 'number' ? err.statusCode
    : typeof err?.status === 'number' ? err.status
    : 500;
  const message = err?.message || 'Internal server error';
  if (status >= 500) console.error('[aa-relay] Error:', err);
  res.status(status).json(apiResponse(null, message.replace(/^\[402\]\s*/, ''), status === 402 ? 1001 : status >= 500 ? 1007 : 1001));
});

const PORT = parseInt(process.env.PORT || '9131', 10);
app.listen(PORT, () => console.log(`aa-relay running on port ${PORT}`));
