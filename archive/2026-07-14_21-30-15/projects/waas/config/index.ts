import dotenv from 'dotenv';
import path from 'path';

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenv.config({ path: path.resolve(__dirname, '..', '..', envFile) });

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/pocketx_waas',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Email (verification code)
  email: {
    provider: process.env.EMAIL_PROVIDER || 'dev',
    from: process.env.EMAIL_FROM || 'noreply@pocketx.io',
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
  },

  // Supported chains
  supportedChains: (process.env.SUPPORTED_CHAINS || 'eth,polygon,arbitrum,optimism,bsc,base').split(','),

  // Risk control
  risk: {
    singleLimitDefault: parseFloat(process.env.RISK_SINGLE_LIMIT_DEFAULT || '10000'),
    dailyLimitDefault: parseFloat(process.env.RISK_DAILY_LIMIT_DEFAULT || '50000'),
    newUserLimitDefault: parseFloat(process.env.RISK_NEW_USER_LIMIT_DEFAULT || '1000'),
    newUserHours: parseInt(process.env.RISK_NEW_USER_HOURS || '24', 10),
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

  // RPC URLs per chain — Non-Custodial wallet queries chain directly
  chainRpc: {
    sepolia: process.env.SEPOLIA_RPC_URL || 'https://1rpc.io/sepolia',
    eth: process.env.ETH_RPC_URL || process.env.SEPOLIA_RPC_URL || 'https://1rpc.io/sepolia',
    base: process.env.BASE_RPC_URL || '',
    bsc: process.env.BSC_RPC_URL || '',
    polygon: process.env.POLYGON_RPC_URL || '',
    arbitrum: process.env.ARBITRUM_RPC_URL || '',
    optimism: process.env.OPTIMISM_RPC_URL || '',
  },
  // SEPOLIA_RPC_URL (legacy compat)
  sepoliaRpcUrl: process.env.SEPOLIA_RPC_URL || 'https://1rpc.io/sepolia',
  ethRpcUrl: process.env.ETH_RPC_URL || '',
  bscRpcUrl: process.env.BSC_RPC_URL || '',
  baseRpcUrl: process.env.BASE_RPC_URL || '',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'debug',
};

// Startup safety checks
function validateConfig(): void {
  const errors: string[] = [];
  if (!config.cwallet.apiKey || config.cwallet.apiKey === 'dev-cwallet-key') {
    errors.push('CWALLET_API_KEY is not set or using default value');
  }
  if (config.nodeEnv === 'production' && errors.length > 0) {
    throw new Error(`Unsafe production config:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
  if (errors.length > 0) {
    console.warn('[config] WARNING: Using default credentials:', errors.join(', '));
  }
}
validateConfig();
