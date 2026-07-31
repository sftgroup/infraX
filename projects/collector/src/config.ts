import dotenv from 'dotenv';
import path from 'path';

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenv.config({ path: path.resolve(__dirname, '..', envFile) });

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/pocketx_collector',

  // CWallet Internal API (legacy, used by database.ts migration seed)
  cwallet: {
    apiKey: process.env.CWALLET_API_KEY || 'dev-cwallet-key',
  },

  // Admin panel credentials
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'infrax123',
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'debug',

  // Binance Futures — public market data
  binance: {
    futuresRestBase: process.env.BINANCE_FUTURES_REST || 'https://fapi.binance.com',
    futuresWsBase: process.env.BINANCE_FUTURES_WS || 'wss://fstream.binance.com/ws', // 9443 port also works and sometimes has better connectivity
    wsEnabled: process.env.BINANCE_WS_ENABLED !== 'false',
    symbolLimit: parseInt(process.env.BINANCE_SYMBOL_LIMIT || '20', 10),
    aggregateIntervalMs: parseInt(process.env.BINANCE_AGGREGATE_INTERVAL_MS || '60000', 10),
  },

  // OKX ChainOS — DEX token data (v5 wallet API, multi-account)
  okx: {
    apiBase: process.env.OKX_CHAINOS_API || 'https://www.okx.com/api/v5/wallet/token',
    apiKey: process.env.OKX_CHAINOS_API_KEY || '',
    apiSecret: process.env.OKX_CHAINOS_API_SECRET || '',
    apiPassphrase: process.env.OKX_CHAINOS_API_PASSPHRASE || '',
    wsEnabled: process.env.OKX_WS_ENABLED !== 'false',
    tokenLimit: parseInt(process.env.OKX_TOKEN_LIMIT || '100', 10),
    snapshotIntervalMs: parseInt(process.env.OKX_SNAPSHOT_INTERVAL_MS || '60000', 10),
  },

  // OKX OnchainOS Market — v6 DEX Market API (token/meme/signal/balance/history)
  okxMarket: {
    apiBase: process.env.OKX_MARKET_API || 'https://web3.okx.com',
    apiKey: process.env.OKX_MARKET_API_KEY || process.env.OKX_CHAINOS_API_KEY || '',
    apiSecret: process.env.OKX_MARKET_API_SECRET || process.env.OKX_CHAINOS_API_SECRET || '',
    apiPassphrase: process.env.OKX_MARKET_API_PASSPHRASE || process.env.OKX_CHAINOS_API_PASSPHRASE || '',
    wsEnabled: process.env.OKX_MARKET_WS_ENABLED !== 'false',
    // WebSocket: OKX public ticker stream
    wsUrl: process.env.OKX_MARKET_WS_URL || 'wss://ws.okx.com:8443/ws/v5/public',
    wsInstruments: (process.env.OKX_MARKET_WS_INSTRUMENTS || 'ETH-USDT,BTC-USDT,BNB-USDT,SOL-USDT').split(','),
    wsReconnectMs: parseInt(process.env.OKX_MARKET_WS_RECONNECT_MS || '5000', 10),
    wsPingIntervalMs: parseInt(process.env.OKX_MARKET_WS_PING_MS || '20000', 10),
    // Scheduler: which chains to track (comma-separated chainIndex like "1,56,8453")
    schedulerChains: (process.env.OKX_MARKET_SCHED_CHAINS || '1,56,8453').split(',').filter(Boolean),
    // Scheduler: how many top tokens to track candles for (per chain)
    schedulerCandleTokens: parseInt(process.env.OKX_MARKET_CANDLE_TOKENS || '10', 10),
    // Scheduler: candle OHLCV period (5m, 15m, 1H, 4H, 1D)
    schedulerCandlePeriod: process.env.OKX_MARKET_CANDLE_PERIOD || '15m',
    schedulerCandleLimit: parseInt(process.env.OKX_MARKET_CANDLE_LIMIT || '4', 10),
    // Scheduler intervals
    schedulerHotTokensMs: parseInt(process.env.OKX_MARKET_HOT_INTERVAL_MS || '60000', 10),
    schedulerCandlesMs: parseInt(process.env.OKX_MARKET_CANDLE_INTERVAL_MS || '300000', 10),
    schedulerIndexMs: parseInt(process.env.OKX_MARKET_INDEX_INTERVAL_MS || '60000', 10),
    schedulerMempumpMs: parseInt(process.env.OKX_MARKET_MEMPUMP_INTERVAL_MS || '300000', 10),
  },

  // Event reclassifier (raw_event → classified)
  reclassifier: {
    intervalMs: parseInt(process.env.RECLASSIFY_INTERVAL_MS || '30000', 10),
    batchSize: parseInt(process.env.RECLASSIFY_BATCH_SIZE || '500', 10),
    firstRunDelayMs: parseInt(process.env.RECLASSIFY_FIRST_RUN_MS || '10000', 10),
    customSigsRefreshMs: parseInt(process.env.RECLASSIFY_CUSTOM_SIGS_REFRESH_MS || '300000', 10),
  },
};

// Startup safety checks
function validateConfig(): void {
  if (config.nodeEnv === 'production') {
    if (!config.admin.password || config.admin.password === 'infrax123') {
      console.warn('[config] WARNING: Admin panel using default password — change ADMIN_PASSWORD in production');
    }
  }
}
validateConfig();
