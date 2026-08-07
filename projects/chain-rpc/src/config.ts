/**
 * chain-rpc 配置 — env-var driven（与全栈统一契约）。
 *
 * 鉴权分级（读写分离）：
 *   CHAIN_RPC_READ_KEY      读权限 key（Bearer / X-API-Key / X-Service-Key 三选一）
 *   CHAIN_RPC_BROADCAST_KEY 广播权限 key（写，权限高于读；广播端点仅认此 key）
 * 可选：配置 DATA_SERVICE_URL + DATA_API_KEY 后支持 data 服务统一签发的
 *   dx_/mx_ 等外部 key 实时校验（scope=rpc 读 / scope=rpc_broadcast 广播）。
 */
import dotenv from 'dotenv';
dotenv.config();

function boolOr(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  port: parseInt(process.env.PORT || '9130', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // ── 鉴权分级 ─────────────────────────────────────────
  readKey: process.env.CHAIN_RPC_READ_KEY || '',
  broadcastKey: process.env.CHAIN_RPC_BROADCAST_KEY || '',
  // 外部签发 key 实时校验（data 服务 /api-keys/verify）
  verifyUrl: (process.env.DATA_SERVICE_URL || '').trim(),
  verifyKey: process.env.DATA_API_KEY || '',

  // ── RPC 端点池 ───────────────────────────────────────
  // 端点来源：rpc-pool.json 基线 → 链 env URL（SEPOLIA/ETH/BSC/BASE/OXA/SOLANA_RPC_URL）→ INFRAX_RPC_POOL 全量覆盖
  supportedChains: (process.env.CHAIN_RPC_CHAINS || 'sepolia,ethereum,bsc,base,oxa,solana')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // ── 广播确认轮询 ─────────────────────────────────────
  broadcastWaitSec: parseFloat(process.env.CHAIN_RPC_WAIT_SEC || '30'),
  broadcastIntervalMs: parseInt(process.env.CHAIN_RPC_WAIT_INTERVAL_MS || '3000', 10),

  // ── 端点级开关 ───────────────────────────────────────
  enableExternalVerify: boolOr(process.env.CHAIN_RPC_ENABLE_EXTERNAL_VERIFY, false),
};
