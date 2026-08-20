// ============================================================================
// aa-relay 共享工具（E-1c/E-1b/AA-1 重构，2026-08-21 审查 #6 拆分后精简版）
// 职责：① 通用响应/参数工具；② 链配置解析；③ RPC UserOp → SDK UserOperationV7。
// 入站鉴权见 ./auth.ts；bundler RPC/错误分类见 ./rpc.ts；计费编排见 ./submit.ts。
// ============================================================================
import type { Address } from 'viem';
import type { UserOperationV7 } from '../../aa-sdk/src/index.js';
import { getChainConfig } from '../../aa-sdk/src/index.js';
import type { ChainAAConfig } from '../../aa-sdk/src/index.js';

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
    sender: op.sender as Address,
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
