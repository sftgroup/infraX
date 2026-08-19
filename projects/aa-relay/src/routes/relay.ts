// ============================================================================
// aa-relay 核心转发路由（E-1c：UserOp 转发 / 收据查询 / gas 估算 / paymaster 代理）
// 拆自原 index.ts（大文件拆分），共享工具见 ../helpers.ts。
// ============================================================================
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { BundlerClient } from '../../../aa-sdk/src/index.js';
import { aaChargeConfigured, aaFees, estimateUserOpGasWei, chargeUserOp, settleUserOp } from '../billing.js';
import {
  apiResponse,
  asyncHandler,
  broadcast,
  getChain,
  isBundlerBusinessError,
  normalizeOp,
  rpcClient,
  rpcErrorMessage,
} from '../helpers.js';

export function relayRoutes(): Router {
  const router = Router();

  // POST /v1/userops
  router.post('/v1/userops', asyncHandler(async (req: any, res: any) => {
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
        onBroadcast: (hash: any) => console.log(`[aa-relay] ${chain} userOpHash=${hash} accepted`),
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
  router.get('/v1/userops/:hash', asyncHandler(async (req: any, res: any) => {
    const { hash } = req.params;
    const cfg = getChain(req.query.chain);
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
  router.post('/v1/estimate', asyncHandler(async (req: any, res: any) => {
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
  router.post('/v1/paymaster', asyncHandler(async (req: any, res: any) => {
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

  return router;
}
