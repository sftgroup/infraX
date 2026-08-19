// ============================================================================
// aa-relay session 路由（E-3a/b + AA-1/AA-6/AA-7）
// 用户钱包 session：owner=用户 EOA，agent=session key，链上 Kernel validator 强制。
// 拆自原 index.ts（大文件拆分），共享工具/提交流程见 ../helpers.ts。
//   POST /v1/session           创建：生成 session key + 策略落库(product) + 返回 enableCallData
//   GET  /v1/session           查询账户名下 session 列表（含 createdAt + 链上 isBound）
//   POST /v1/session/disable   撤销：本地移除 + 返回三段批量 disable draft（无遗留单调用编码）
//   POST /v1/session/revoke    撤销上链：owner 签名广播三段批量 disable（submitSignedOp）
//   POST /v1/session/replace   轮换阶段 1/2：建新 session + 返回 disable 旧 draft
//   POST /v1/session/replace/submit  轮换阶段 2/2：owner 签名广播 disable 旧 + 移除旧记录
//   POST /v1/session/validate  链下预检（与链上策略一致性，E-3b）
// ============================================================================
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  BundlerClient,
  ExternalWalletSigner,
  FALLBACK_GAS,
  DEFAULT_GAS_PRICE,
  assertValidPolicy,
  buildDisableSessionUserOp,
  createAAClient,
  createKernelAccount,
  encodeEnableSessionCall,
  estimateFeesPerGas,
  isPolicySuperset,
  isSessionModuleInstalled,
  validateSessionCall,
  type SessionPolicy,
  type UserOperationV7,
} from '../../../aa-sdk/src/index.js';
import type { ProductSessionStore } from '../session-store.js';
import { apiResponse, asyncHandler, getChain, submitSignedOp } from '../helpers.js';

export function sessionRoutes(store: ProductSessionStore): Router {
  const sessionStore = store;
  const router = Router();

  // POST /v1/session —— 创建 / 复用（AA-6 B2）
  router.post('/v1/session', asyncHandler(async (req: any, res: any) => {
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
      network: cfg.network,
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
      const existing = await sessionStore.list(product, account.address, cfg.network);
      const candidate = existing.find((e) => isPolicySuperset({ existing: e, requested: policy }));
      if (candidate) {
        // 复用：返回既有 sessionId/sessionKey，零额外链上交易（复用即再次下发 key，调用方为同 owner）
        const withKey = await sessionStore.getWithKey(product, candidate.sessionId, cfg.network);
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
  router.get('/v1/session', asyncHandler(async (req: any, res: any) => {
    const account = req.query.account;
    const product = req.query.product ?? 'default';
    if (!account) return res.status(400).json(apiResponse(null, 'account required', 1001));
    const cfg = getChain(req.query.chain);
    const policies = await sessionStore.list(product, account as Address, cfg.network);
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
  // 不再返回单调用 disableCallData（encodeDisableSessionCall 遗留编码：onUninstall 空实现
  // 不删链上记录 + 重 enable 会 AA23）；撤销统一走三段批量 draft（buildDisableSessionUserOp，
  // disableSession + uninstallModule + invalidateNonce），调用方签名后 POST /v1/session/revoke 上链。
  router.post('/v1/session/disable', asyncHandler(async (req: any, res: any) => {
    const { chain, product = 'default', account, sessionId } = req.body || {};
    if (!account || !sessionId) return res.status(400).json(apiResponse(null, 'account + sessionId required', 1001));
    const cfg = getChain(chain);
    const found = (await sessionStore.list(product, account as Address, cfg.network)).some((p) => p.sessionId === sessionId);
    await sessionStore.remove(product, sessionId, cfg.network);
    // 上链撤销 draft（估 gas/fee 后重算 hash；失败则 draft=null，调用方仍可先本地停用）
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
      draft,
    }, 'session disabled'));
  }));

  // POST /v1/session/revoke —— AA-1 阶段 2：带签名上链撤销（owner 签名 disable UserOp）
  // 统一提交流程见 helpers.submitSignedOp（校验+计费+广播+结算），不再重复实现。
  router.post('/v1/session/revoke', asyncHandler(async (req: any, res: any) => {
    const { chain, account, owner, sessionId, userOpHash, signature, op, wait } = req.body || {};
    if (!account || !owner || !sessionId || !userOpHash || !signature || !op) {
      return res.status(400).json(apiResponse(null, 'account + owner + sessionId + userOpHash + signature + op required', 1001));
    }
    const cfg = getChain(chain);
    const result = await submitSignedOp({
      chain, cfg, account: account as Address, owner: owner as Address, sessionId,
      userOpHash: userOpHash as Hex, signature: signature as Hex, op, wait, chargeLabel: 'revoke',
    });
    res.json(apiResponse(result, 'session revoked'));
  }));

  // POST /v1/session/replace —— AA-7 阶段 1：构建"两笔轮换"第①笔 disable draft
  //  ⚠️ 单笔 replace（uninstall+invalidate+install 一次 UserOp）在 Kernel v3.0-beta 上不可行
  //     （root-mode installModule 不设置 allowedSelectors → validateUserOp revert InvalidValidator
  //      → EntryPoint 报 AA24），链上 E2E 实证（aa-session-replace-e2e.ts 12/12）。正确轮换 = 两笔：
  //       ① root-mode [disableSession(旧) + uninstallModule + invalidateNonce(cur+1)]（owner 签）
  //       ② ENABLE-mode enable 新 session（owner 签 digest + agent 签 op；digest 绑定 ① 后
  //          currentNonce，必须在 ① 上链确认后再构建 → 本端点只返回 ①）
  // body: { chain, product='default', owner, oldSessionId, permissions, validUntil, validAfter }
  // 流程：
  //   ① owner EOA 派生账户（counterfactual）
  //   ② 生成新 session key + 策略，落库（新 session 即刻可复用）
  //   ③ 链上探测是否已绑定 session validator（残留/未部署判定）
  //   ④ 构建 disable draft（估 gas/fee 后重算 userOpHash）—— owner 对 disableDraft.userOpHash
  //      签名后 POST /v1/session/replace/submit 广播 ①；确认后再取 ② enable draft
  router.post('/v1/session/replace', asyncHandler(async (req: any, res: any) => {
    const { chain, product = 'default', owner, oldSessionId, permissions, validUntil, validAfter } = req.body || {};
    if (!owner || !oldSessionId || !Array.isArray(permissions) || permissions.length === 0 || !validUntil) {
      return res.status(400).json(apiResponse(null, 'owner + oldSessionId + permissions + validUntil required', 1001));
    }
    const cfg = getChain(chain);
    // ① 派生账户（counterfactual；owner EOA 无需签名，服务端无窗口 provider 不会触发）
    const ownerSigner = new ExternalWalletSigner(
      { request: () => { throw new Error('no provider on server'); } } as any,
      owner as Address,
    );
    const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
    // ② 生成新 session key + 策略（落库持久化 sessionKey，供后续复用）
    const privateKey = generatePrivateKey();
    const signer = privateKeyToAccount(privateKey).address;
    const policy: SessionPolicy = {
      network: cfg.network,
      sessionId: toHex(randomBytes(32)),
      signer,
      validAfter: BigInt(validAfter ?? 0),
      validUntil: BigInt(validUntil),
      permissions,
    };
    assertValidPolicy(policy);
    await sessionStore.save(product, policy, account.address, privateKey);
    // ③ 链上绑定探测（旧 session 是否在链上 → 是否真的需要轮换）
    let isBound = false;
    try {
      isBound = await isSessionModuleInstalled({ client: createAAClient(cfg), chainConfig: cfg, account: account.address });
    } catch (e: any) {
      console.warn(`[aa-relay] replace bound probe failed (${chain}): ${e.message}`);
    }
    // ④ 构建 ① disable draft（估 gas/fee 后重算 hash；失败则 disableDraft=null）
    let disableDraft = null;
    try {
      const client = createAAClient(cfg);
      const draft0 = await buildDisableSessionUserOp({
        client, chainConfig: cfg, account: account.address, sessionId: oldSessionId,
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
      disableDraft = await buildDisableSessionUserOp({
        client, chainConfig: cfg, account: account.address, sessionId: oldSessionId, gas: { ...gas, ...fee },
      });
    } catch (e: any) {
      console.warn(`[aa-relay] replace disable draft build failed (${chain}): ${e.message}`);
    }
    res.json(apiResponse({
      product,
      accountAddress: account.address,
      isDeployed: account.isDeployed,
      isBound,
      oldSessionId,
      sessionId: policy.sessionId,
      signer,
      sessionKey: privateKey,
      validAfter: policy.validAfter.toString(),
      validUntil: policy.validUntil.toString(),
      permissions: policy.permissions,
      disableDraft,
    }, 'session replace draft (step 1/2: disable old)'));
  }));

  // POST /v1/session/replace/submit —— AA-7 阶段 2：带签名上链轮换（owner 签名 disable 旧）
  // 广播成功（链上已 uninstall）后移除旧 session 记录（新 session 阶段 1 已落库）；
  // ② enable 新 session 由调用方用 SDK buildEnableSessionUserOp 走 /v1/userops 上链。
  router.post('/v1/session/replace/submit', asyncHandler(async (req: any, res: any) => {
    const { chain, product = 'default', account, owner, oldSessionId, userOpHash, signature, op, wait } = req.body || {};
    if (!account || !owner || !oldSessionId || !userOpHash || !signature || !op) {
      return res.status(400).json(apiResponse(null, 'account + owner + oldSessionId + userOpHash + signature + op required', 1001));
    }
    const cfg = getChain(chain);
    const result = await submitSignedOp({
      chain, cfg, account: account as Address, owner: owner as Address, sessionId: oldSessionId,
      userOpHash: userOpHash as Hex, signature: signature as Hex, op, wait, chargeLabel: 'replace',
      onSuccess: async () => {
        // ⑤ 移除旧 session（链上已 uninstall；新 session 阶段 1 已落库）
        await sessionStore.remove(product, oldSessionId, cfg.network).catch(() => undefined);
      },
    });
    res.json(apiResponse(result, 'session replaced'));
  }));

  // POST /v1/session/validate —— 链下预检（E-3b：与链上模块策略一致）
  router.post('/v1/session/validate', asyncHandler(async (req: any, res: any) => {
    const { policy, call, nowSec } = req.body || {};
    if (!policy || !call) return res.status(400).json(apiResponse(null, 'policy + call required', 1001));
    const now = BigInt(nowSec ?? Math.floor(Date.now() / 1000));
    const result = validateSessionCall(policy, call, now);
    if (result.ok) return res.json(apiResponse({ ok: true }, 'allowed'));
    res.json(apiResponse({ ok: false, reason: result.reason }, `denied: ${result.reason}`, 1001));
  }));

  return router;
}
