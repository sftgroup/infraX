// ============================================================================
// aa-relay 核心转发路由（E-1c：UserOp 转发 / 收据查询 / gas 估算 / paymaster 代理）
// 拆自原 index.ts（大文件拆分）；鉴权见 ../auth.ts、计费编排见 ../submit.ts。
// ============================================================================
import { Router } from 'express';
import { BundlerClient } from '../../../aa-sdk/src/index.js';
import { apiResponse, asyncHandler, getChain, normalizeOp } from '../helpers.js';
import { isBundlerBusinessError, rpcClient, rpcErrorMessage } from '../rpc.js';
import { runOpWithBilling } from '../submit.js';

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

    // A-10 计费预扣 + 广播 + 结算退差统一编排（billingConfigured 双判定：ledger/escrow）
    const result = await runOpWithBilling({ cfg, chain, userOp, wait, chargeLabel: 'userop' });
    // P1-1: 异步 202 Accepted（语义等价 202 + opHash，消除长连接超时耦合）
    if (wait === false) {
      res.status(202).json(apiResponse(result, 'UserOp accepted'));
      return;
    }
    res.json(apiResponse(result, 'UserOp sent'));
  }));

  // GET /v1/userops/:hash（状态机 + 收据查询；P2-2：pending/confirmed/reverted，主端点失败切备）
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
        // P2-2 状态机：无收据 = 广播中/未上链 → pending；有收据按 success 判定 confirmed/reverted
        const status = !r
          ? 'pending'
          : (r.success ?? (r.receipt ? r.receipt.status !== '0x0' : true))
            ? 'confirmed'
            : 'reverted';
        return res.json(apiResponse({ status, receipt: r ?? null }, `UserOp ${status}`));
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
