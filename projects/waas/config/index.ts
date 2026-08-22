import dotenv from 'dotenv';
import path from 'path';

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenv.config({ path: path.resolve(__dirname, '..', '..', envFile) });

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/infrax_waas',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Email (verification code)
  email: {
    provider: process.env.EMAIL_PROVIDER || 'dev',
    from: process.env.EMAIL_FROM || 'noreply@infrax.io',
  },

  // SMS (legacy, kept for compat)
  sms: {
    provider: process.env.SMS_PROVIDER || 'console',
    apiKey: process.env.SMS_API_KEY || '',
    apiSecret: process.env.SMS_API_SECRET || '',
  },

  // CWallet Internal API
  cwallet: {
    baseUrl: process.env.CWALLET_BASE_URL || 'http://localhost:8080/api/internal',
    apiKey: process.env.CWALLET_API_KEY || 'dev-cwallet-key',
  },

  // Gas Pool
  gasPool: {
    privateKey: process.env.GAS_POOL_PRIVATE_KEY || '',
    address: process.env.GAS_POOL_ADDRESS || '',
    // W-4: 广播前 gas 熔断阈值（原生单位，如 0.05 ETH/BNB）；余额低于该值暂停自动广播
    alertThreshold: parseFloat(process.env.GAS_POOL_ALERT_THRESHOLD || '0.05'),
  },

  // Supported chains
  supportedChains: (process.env.SUPPORTED_CHAINS || 'eth,bsc,base').split(','),

  // Risk control
  risk: {
    singleLimitDefault: parseFloat(process.env.RISK_SINGLE_LIMIT_DEFAULT || '10000'),
    dailyLimitDefault: parseFloat(process.env.RISK_DAILY_LIMIT_DEFAULT || '50000'),
    newUserLimitDefault: parseFloat(process.env.RISK_NEW_USER_LIMIT_DEFAULT || '1000'),
    newUserHours: parseInt(process.env.RISK_NEW_USER_HOURS || '24', 10),
    // W-5: 非稳定币历史流水折算 USD 的保守倍数（无法逐笔回查历史价格时的兜底）
    usdConservativeMultiplier: parseFloat(process.env.RISK_USD_CONSERVATIVE_MULTIPLIER || '2000'),
  },

  // Signature strategy
  sig: {
    autoSignMax: parseFloat(process.env.SIG_AUTO_SIGN_MAX || '100'),
    confirmMin: parseFloat(process.env.SIG_CONFIRM_MIN || '100'),
    confirmMax: parseFloat(process.env.SIG_CONFIRM_MAX || '10000'),
    approvalMin: parseFloat(process.env.SIG_APPROVAL_MIN || '10000'),
  },

  // Webhook
  webhook: {
    retryMax: parseInt(process.env.WEBHOOK_RETRY_MAX || '3', 10),
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10),
  },

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  },

  // HD Wallet (BIP44)
  hdWalletSeed: process.env.HD_WALLET_SEED || '',
  walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || '',
  masterWalletAddresses: process.env.MASTER_WALLET_ADDRESSES || '{}',
  hotWalletAddresses: process.env.HOT_WALLET_ADDRESSES || '{}',

  // Block scanner
  blockScanner: {
    intervalMs: parseInt(process.env.BLOCK_SCAN_INTERVAL_MS || '12000', 10),
    confirmations: parseInt(process.env.BLOCK_SCAN_CONFIRMATIONS || '1', 10),
  },
  minConfirmations: process.env.MIN_CONFIRMATIONS || '{"1":12,"11155111":3,"56":12,"8453":12}',

  // W-10: 显式 DRY_RUN 开关（模拟广播，不触碰链上）
  dryRun: process.env.DRY_RUN === 'true',

  // W-11/W-16: 归集与冷热分离
  sweep: {
    // 定时执行器间隔（处理 pending sweep_records + 广播重试）
    workerIntervalMs: parseInt(process.env.SWEEP_WORKER_INTERVAL_MS || '30000', 10),
    // 链上余额 ≥ 该原生数额才建 sweep 记录
    dustThreshold: parseFloat(process.env.SWEEP_DUST_THRESHOLD || '0.001'),
    // 原生转账保留的 gas reserve（按 21000 gas × 实时 gasPrice 计算后叠加此值）
    gasReserve: parseFloat(process.env.SWEEP_GAS_RESERVE || '0.0005'),
  },
  // W-16: 热钱包单地址余额上限（原生单位），超出自动归冷（master wallet）
  hotWallet: {
    coldSweepThreshold: parseFloat(process.env.HOT_WALLET_COLD_SWEEP_THRESHOLD || '5.0'),
  },

  // Sepolia on-chain contracts (deployed 2026-07-01)
  contracts: {
    safeProxyFactory: process.env.SAFE_PROXY_FACTORY_ADDRESS || '0xda90bf313778216cd124b33d543654f90c81c30f',
    gasSponsor: process.env.GAS_SPONSOR_ADDRESS || '0x5648429416e2a37a71745dae79f7559b55871e30',
    safeSingleton: process.env.SAFE_SINGLETON_ADDRESS || '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  },

  // Fee configuration
  feeConfig: {
    defaultMinFee: process.env.FEE_DEFAULT_MIN_FEE || '0',
    defaultMaxFee: process.env.FEE_DEFAULT_MAX_FEE || '0',
  },

  // DC-10: 链上 RPC 网关（全仓唯一链上 RPC 读/广播入口，与 WAAS 解耦）。
  // 读/广播分级 key：读 key 仅 /v1/rpc、广播 key 仅 /v1/broadcast（读 key 无法触达广播端点）。
  chainRpcGateway: {
    baseUrl: process.env.CHAIN_RPC_URL || '',
    readKey: process.env.CHAIN_RPC_READ_KEY || '',
    broadcastKey: process.env.CHAIN_RPC_BROADCAST_KEY || '',
  },

  // MQ-10 补充 D: Admin login credentials (env-driven; missing => fail-closed, no default password)
  admin: {
    username: process.env.ADMIN_USER || '',
    password: process.env.ADMIN_PASS || '',
  },

  // MQ-12: 通用支付引擎（@0xinfrax/payments 独立服务 infrax-payments :9132）。
  // 用户套餐购买统一走通用支付通道（chain escrow / fiat Stripe / x402），waas 仅保留业务状态。
  payments: {
    baseUrl: process.env.PAYMENTS_URL || '',
    apiKey: process.env.PAYMENTS_API_KEY || '',
    webhookSecret: process.env.PAYMENTS_WEBHOOK_SECRET || '',
    defaultChain: process.env.PAYMENTS_CHAIN || 'oxachain',
    defaultRail: process.env.PAYMENTS_DEFAULT_RAIL || 'chain',
    fiatPeriod: (process.env.PAYMENTS_FIAT_PERIOD || 'month') as 'day' | 'week' | 'month' | 'year',
    // 链上套餐 → waas 业务套餐对齐表（planId 为 SubscriptionManager.getPlan 的 id）
    planIdMap: JSON.parse(process.env.PAYMENTS_PLAN_ID_MAP || '{"free":0,"pro":1,"enterprise":2}') as Record<string, number>,
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'debug',
};

// Startup safety checks
function validateConfig(): void {
  const errors: string[] = [];
  if (!config.cwallet.apiKey || config.cwallet.apiKey === 'dev-cwallet-key') {
    errors.push('CWALLET_API_KEY is not set or using default value');
  }
  // W-13: 私钥/HD seed 缺失时生产必须 fail-closed（禁止静默降级 dev 钱包）
  if (config.nodeEnv === 'production') {
    if (!config.hdWalletSeed) {
      errors.push('HD_WALLET_SEED is not set in production (fail-closed: refusing dev wallet)');
    }
    if (!config.walletEncryptionKey) {
      errors.push('WALLET_ENCRYPTION_KEY is not set in production (fail-closed: refusing dev encryption)');
    }
  }
  if (config.nodeEnv === 'production' && errors.length > 0) {
    throw new Error(`Unsafe production config:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
  if (errors.length > 0) {
    console.warn('[config] WARNING: Using default credentials:', errors.join(', '));
  }
}
validateConfig();
