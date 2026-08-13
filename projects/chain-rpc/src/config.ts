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
  supportedChains: (process.env.CHAIN_RPC_CHAINS || 'sepolia,ethereum,bsc,base,oxa,solana,polygon,arbitrum,optimism,xlayer')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // ── 广播确认轮询 ─────────────────────────────────────
  broadcastWaitSec: parseFloat(process.env.CHAIN_RPC_WAIT_SEC || '30'),
  broadcastIntervalMs: parseInt(process.env.CHAIN_RPC_WAIT_INTERVAL_MS || '3000', 10),

  // ── 池参数可配置（DC-7） ──────────────────────────────
  healthIntervalMs: parseInt(process.env.CHAIN_RPC_HEALTH_INTERVAL_MS || '30000', 10),
  maxRetries: parseInt(process.env.CHAIN_RPC_MAX_RETRIES || '3', 10),
  requestTimeoutMs: parseInt(process.env.CHAIN_RPC_REQUEST_TIMEOUT_MS || '15000', 10),

  // A-11: DEX 交易执行 RPC ───────────────────────────
  // 聚合器：OKX OnchainOS DEX Aggregator V6 首选（需 OKX DEX 签名鉴权），1inch 回退（需 DEX_API_KEY）
  dexAggregatorUrl: (process.env.DEX_AGGREGATOR_URL || 'https://web3.okx.com').trim(),
  dexApiKey: process.env.DEX_API_KEY || '',
  // OKX V6 签名鉴权（prehash = ts + METHOD + requestPath，HMAC-SHA256 → Base64）；
  // 支持凭证池（A-11 多账号轮询）：OKX_DEX_KEYS_JSON 为 JSON 数组
  //   [{"apiKey":"..","apiSecret":"..","apiPassphrase":".."}, ...]
  // 未配置时回退单组 OKX_DEX_* → OKX_CHAINOS_*（与 collector 共用凭证）
  okxDex: {
    apiKey: process.env.OKX_DEX_API_KEY || process.env.OKX_CHAINOS_API_KEY || '',
    apiSecret: process.env.OKX_DEX_API_SECRET || process.env.OKX_CHAINOS_API_SECRET || '',
    apiPassphrase: process.env.OKX_DEX_API_PASSPHRASE || process.env.OKX_CHAINOS_API_PASSPHRASE || '',
  },
  // 多账号凭证池（轮询 + failover）。解析失败/为空 → 空数组，运行时回退 okxDex 单组
  okxDexKeys: ((): Array<{ apiKey: string; apiSecret: string; apiPassphrase: string }> => {
    try {
      const raw = JSON.parse(process.env.OKX_DEX_KEYS_JSON || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .map((k: any) => ({
          apiKey: String(k?.apiKey || ''),
          apiSecret: String(k?.apiSecret || ''),
          apiPassphrase: String(k?.apiPassphrase || ''),
        }))
        .filter((k) => k.apiKey && k.apiSecret && k.apiPassphrase);
    } catch {
      return [];
    }
  })(),
  // A-11.6: approve/swap 构建白名单链集（联动 RPC-3 链补齐；Solana quote 先行二期）
  dexSupportedChains: (process.env.DEX_SUPPORTED_CHAINS || 'ethereum,bsc,base,arbitrum,polygon,xlayer')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // gasLimit 预估上限保护（防超长 calldata 滥用）
  dexMaxApproveGas: parseInt(process.env.DEX_MAX_APPROVE_GAS || '200000', 10),
  dexMaxSwapGas: parseInt(process.env.DEX_MAX_SWAP_GAS || '1500000', 10),

  // ── 端点级开关 ───────────────────────────────────────
  enableExternalVerify: boolOr(process.env.CHAIN_RPC_ENABLE_EXTERNAL_VERIFY, false),

  // ── 可观测（DC-9） ────────────────────────────────────
  // 请求日志端点细分：是否记录 RPC 方法名 / params（含地址哈希，默认关）/ 跳过 /health
  logMethod: boolOr(process.env.CHAIN_RPC_LOG_METHOD, true),
  logParams: boolOr(process.env.CHAIN_RPC_LOG_PARAMS, false),
  logSkipHealth: boolOr(process.env.CHAIN_RPC_LOG_SKIP_HEALTH, true),
  // /v1/status 端点 URL 显示模式：none（默认，脱敏无 url）| host（仅 host）| full（完整 url + query key 打码）
  statusUrlMode: (process.env.CHAIN_RPC_STATUS_URL_MODE || 'none').toLowerCase(),
};
