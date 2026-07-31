export interface AppConfig {
  port: number;
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  redis: { host: string; port: number; password?: string };
  encryptionKey: string;
  jwtSecret: string;
  apiTokens: string[];
  chains: Record<string, string>;
}

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env: ${key}`);
  return val;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  cached = {
    port:        parseInt(process.env.PORT || '3500', 10),
    db: {
      host:      env('DB_HOST', 'localhost'),
      port:      parseInt(env('DB_PORT', '5432'), 10),
      database:  env('DB_NAME', 'session_key_engine'),
      user:      env('DB_USER', 'postgres'),
      password:  env('DB_PASSWORD', ''),
    },
    redis: {
      host:      env('REDIS_HOST', 'localhost'),
      port:      parseInt(env('REDIS_PORT', '6379'), 10),
      password:  process.env.REDIS_PASSWORD || undefined,
    },
    encryptionKey: env('ENCRYPTION_KEY'),
    jwtSecret:     env('JWT_SECRET'),
    apiTokens:     (process.env.API_TOKENS || 'dev-token').split(',').filter(Boolean),
    chains: {
      eth:       env('ETH_RPC_URL'),
      bsc:       env('BSC_RPC_URL'),
      base:      env('BASE_RPC_URL'),
      polygon:   env('POLYGON_RPC_URL'),
      arbitrum:  env('ARBITRUM_RPC_URL'),
      optimism:  env('OPTIMISM_RPC_URL'),
      xlayer:    env('XLAYER_RPC_URL'),
      sol:       env('SOL_RPC_URL'),
    },
  };
  return cached;
}
