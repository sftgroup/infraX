# Session Key Engine 开发方案

> **版本**: v1.0 | **日期**: 2026-07-31 | **作者**: Wayne (team1)
> **关联**: PRD → `infraX/docs/SESSION_KEY_ENGINE_PRD.md`

---

## 1. 架构总览

### 1.1 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Client Layer                               │
│  ┌──────────────────────┐        ┌──────────────────────────────┐  │
│  │ @sftgroup/sk-react   │        │  REST API (各项目后端直调)    │  │
│  │ (React 组件)          │        │  Python / Node.js / Go      │  │
│  └──────────┬───────────┘        └──────────────┬───────────────┘  │
│             │                                    │                  │
└─────────────┼────────────────────────────────────┼──────────────────┘
              │            HTTPS (Bearer Token)     │
┌─────────────▼────────────────────────────────────▼──────────────────┐
│                     Session Key Engine Server (:3500)                │
│                                                                      │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │ AuthModule     │  │ SessionModule  │  │ ExecutionModule      │  │
│  │ ├─ nonce       │  │ ├─ crud        │  │ ├─ permission-check  │  │
│  │ ├─ eip-712     │  │ ├─ lifecycle   │  │ ├─ signer            │  │
│  │ └─ jwt         │  │ └─ list        │  │ └─ broadcast         │  │
│  └────────────────┘  └────────────────┘  └──────────────────────┘  │
│                                                                      │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │ ChainAdapter   │  │ KeyVault       │  │ ConfigModule          │  │
│  │ ├─ evm.ts      │  │ ├─ generate    │  │ ├─ chain-registry     │  │
│  │ └─ sol.ts      │  │ ├─ encrypt     │  │ ├─ contract-whitelist │  │
│  │                │  │ └─ decrypt     │  │ └─ env-loader         │  │
│  └────────────────┘  └────────────────┘  └──────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────┐  ┌───────────────────────────────┐   │
│  │ PostgreSQL               │  │ Redis                          │   │
│  │ ├─ session_keys          │  │ ├─ nonce:{user_id}             │   │
│  │ ├─ session_executions    │  │ └─ lock:session:{id}           │   │
│  │ └─ chain_configs         │  │                                │   │
│  └──────────────────────────┘  └───────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 模块拆分总览

```
session-key-engine/
├── packages/                    # Monorepo (pnpm workspaces)
│   ├── core/                   # 核心类型 + 工具函数
│   ├── evm/                    # EVM 链适配器
│   ├── server/                 # Fastify REST API 微服务
│   └── react/                  # 前端 React 组件库
├── deploy/                     # 部署配置
│   ├── docker/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   └── migrations/
│       └── 001_init.sql
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
└── package.json
```

---

## 2. 各模块详细设计

### 2.1 包 1/4：`@sftgroup/session-key-core`

**职责**：纯类型定义 + 零依赖工具函数，被所有其他包依赖

```
packages/core/
├── src/
│   ├── index.ts              # barrel export
│   ├── types/
│   │   ├── index.ts
│   │   ├── session.ts        # Session, SessionStatus
│   │   ├── chain.ts          # Chain, ChainId
│   │   ├── permission.ts     # PermissionConfig, ContractWhitelist
│   │   ├── execution.ts      # ExecutionRequest, ExecutionResult
│   │   └── api.ts            # API 请求/响应类型
│   ├── utils/
│   │   ├── index.ts
│   │   ├── crypto.ts         # AES-256-GCM 加解密
│   │   ├── nonce.ts          # Nonce 生成
│   │   ├── address.ts        # 地址格式化、checksum
│   │   └── errors.ts         # 统一错误码 + 错误类
│   ├── config/
│   │   ├── index.ts
│   │   ├── defaults.ts       # 默认值常量
│   │   └── env.ts            # 环境变量读取
│   └── __tests__/
│       ├── crypto.test.ts
│       ├── nonce.test.ts
│       └── address.test.ts
├── package.json
└── tsconfig.json
```

#### 核心类型定义 (`types/session.ts`)

```typescript
export type SessionStatus = 'active' | 'revoked' | 'expired' | 'quota_exhausted';

export type Chain = 'eth' | 'bsc' | 'base' | 'polygon' | 'arbitrum' | 'optimism' | 'xlayer' | 'sol';

export interface PermissionConfig {
  contracts: string[];           // 合约白名单地址
  functions?: string[];          // 函数 selector 白名单（4字节hex），空=允许全部
}

export interface SessionKey {
  id: string;                    // UUID v4
  userId: string;                // 用户钱包地址
  chain: Chain;
  sessionAddress: string;        // Session Key 公钥地址
  sessionKeyEnc: string;         // AES-256-GCM 加密的私钥
  validFrom: Date;
  validUntil: Date;
  permissions: PermissionConfig;
  maxPerTx: string;              // 单笔上限 (USDC, decimal string)
  maxTotal: string;              // 累计上限
  totalSpent: string;            // 已用额度
  status: SessionStatus;
  createdAt: Date;
  revokedAt?: Date;
}

export interface SessionExecution {
  id: string;
  sessionId: string;
  txHash: string;
  contract: string;
  functionSig: string;
  value: string;
  status: 'pending' | 'success' | 'failed';
  errorReason?: string;
  executedAt: Date;
}
```

#### 加解密工具 (`utils/crypto.ts`)

```typescript
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * AES-256-GCM 加密
 * @param plaintext - 明文
 * @param key - 32字节密钥（从环境变量 ENCRYPTION_KEY 读取）
 * @returns base64(iv + ciphertext + authTag)
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

export function decrypt(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(buf.length - TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/** 从环境变量读取加密密钥，验证长度 */
export function loadEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY not set');
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return buf;
}
```

#### 错误码 (`utils/errors.ts`)

```typescript
export class AppError extends Error {
  constructor(
    public code: number,
    public errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  INVALID_SIGNATURE:   { code: 401, msg: 'Invalid signature' },
  SESSION_NOT_FOUND:   { code: 404, msg: 'Session not found' },
  SESSION_EXPIRED:     { code: 403, msg: 'Session expired' },
  SESSION_REVOKED:     { code: 403, msg: 'Session revoked' },
  CONTRACT_FORBIDDEN:  { code: 403, msg: 'Contract not whitelisted' },
  FUNCTION_FORBIDDEN:  { code: 403, msg: 'Function not whitelisted' },
  QUOTA_EXHAUSTED:     { code: 403, msg: 'Quota exhausted' },
  PER_TX_EXCEEDED:     { code: 403, msg: 'Exceeds per-transaction limit' },
  CHAIN_UNSUPPORTED:   { code: 400, msg: 'Chain not supported' },
  TX_FAILED:           { code: 502, msg: 'Transaction failed on chain' },
} as const;
```

---

### 2.2 包 2/4：`@sftgroup/session-key-evm`

**职责**：EVM 链适配——钱包签名验证、Session Key 生成、交易签名+广播

**依赖**：`@sftgroup/session-key-core`、`viem`（或 `ethers`）

```
packages/evm/
├── src/
│   ├── index.ts
│   ├── wallet.ts           # 钱包操作（签名验证、Session Key 生成）
│   ├── signer.ts           # 交易签名 + eth_sendRawTransaction
│   ├── providers.ts        # RPC Provider 注册表
│   ├── rpc-registry.ts     # 多链 RPC URL 配置（从环境变量加载）
│   └── __tests__/
│       ├── wallet.test.ts
│       └── signer.test.ts
├── package.json
└── tsconfig.json
```

#### RPC Provider 注册表 (`rpc-registry.ts`)

```typescript
/** 从环境变量加载各链 RPC URL，不硬编码 */
export function buildRpcRegistry(): Record<string, string> {
  return {
    eth:       loadEnv('ETH_RPC_URL'),
    bsc:       loadEnv('BSC_RPC_URL'),
    base:      loadEnv('BASE_RPC_URL'),
    polygon:   loadEnv('POLYGON_RPC_URL'),
    arbitrum:  loadEnv('ARBITRUM_RPC_URL'),
    optimism:  loadEnv('OPTIMISM_RPC_URL'),
    xlayer:    loadEnv('XLAYER_RPC_URL'),
    // Solana 走 @sftgroup/session-key-solana 包
  };
}

function loadEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
}
```

#### 钱包签名验证 (`wallet.ts`)

```typescript
import { verifyTypedData, generatePrivateKey, privateKeyToAccount } from 'viem';
import { encrypt } from '@sftgroup/session-key-core';
import type { PermissionConfig } from '@sftgroup/session-key-core';

/** 构建 EIP-712 签名消息 */
export function buildAuthMessage(params: {
  nonce: string;
  chain: string;
  permissions: PermissionConfig;
  validUntil: number;
  maxPerTx: string;
  maxTotal: string;
}) {
  return {
    domain: { name: 'Session Key Engine', version: '1', chainId: params.chain },
    types: {
      SessionAuth: [
        { name: 'nonce', type: 'string' },
        { name: 'sessionAddress', type: 'address' },
        { name: 'contracts', type: 'string' },     // JSON string
        { name: 'validUntil', type: 'uint256' },
        { name: 'maxPerTx', type: 'uint256' },
        { name: 'maxTotal', type: 'uint256' },
      ],
    },
    primaryType: 'SessionAuth',
    message: { /* ... */ },
  };
}

/** 生成 Session Key 密钥对 */
export function generateSessionKey() {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { address: account.address, privateKey: pk };
}
```

---

### 2.3 包 3/4：`session-key-server`（微服务）

**职责**：REST API 微服务，所有业务逻辑

**技术栈**：Fastify + PostgreSQL (pg) + Redis (ioredis)

```
packages/server/
├── src/
│   ├── index.ts              # 入口：启动 Fastify + 注册路由
│   ├── app.ts                # Fastify 实例创建 + 配置
│   ├── config.ts             # 配置加载（环境变量 → 结构化配置）
│   ├── plugins/
│   │   ├── auth.ts           # Bearer Token 认证插件
│   │   ├── db.ts             # PostgreSQL 连接池
│   │   ├── redis.ts          # Redis 客户端
│   │   ├── error-handler.ts  # 全局错误处理
│   │   └── cors.ts           # CORS 配置
│   ├── routes/
│   │   ├── index.ts          # 路由注册
│   │   ├── nonce.ts          # GET /api/v1/nonce
│   │   ├── sessions.ts       # POST/GET/DELETE /api/v1/sessions
│   │   └── execute.ts        # POST /api/v1/execute
│   ├── services/
│   │   ├── auth-service.ts   # 验证签名 + Nonce 管理
│   │   ├── session-service.ts # Session CRUD 业务逻辑
│   │   └── execution-service.ts # 权限校验 + 签名 + 广播
│   ├── repos/
│   │   ├── session-repo.ts   # session_keys 表 CRUD
│   │   └── execution-repo.ts # session_executions 表 CRUD
│   └── __tests__/
│       ├── integration/
│       │   ├── sessions.test.ts
│       │   └── execute.test.ts
│       └── unit/
│           └── auth-service.test.ts
├── package.json
└── tsconfig.json
```

**目录职责说明**：

| 层 | 职责 | 依赖方向 |
|----|------|----------|
| `routes/` | HTTP 请求处理：解析参数 → 调 service → 返回 JSON | service |
| `services/` | 业务逻辑：校验、计算、编排 | repo + core + evm |
| `repos/` | 数据访问：SQL 查询、参数化、返回类型化结果 | db plugin |
| `plugins/` | Fastify 插件：DB 连接、Auth 中间件 | — |

#### 入口文件 (`index.ts`)

```typescript
import { buildApp } from './app';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);
  
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`Session Key Engine running on :${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

#### 配置加载 (`config.ts`)

```typescript
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
  encryptionKey: string;    // 32字节 hex
  jwtSecret: string;        // API Token 签发密钥
  apiTokens: string[];      // 允许的接入项目 API Token 列表
  chains: Record<string, string>;  // chain → RPC URL
}

/** 所有配置从环境变量读取，零硬编码 */
export function loadConfig(): AppConfig {
  return {
    port:            parseInt(env('PORT', '3500'), 10),
    db: {
      host:          env('DB_HOST', 'localhost'),
      port:          parseInt(env('DB_PORT', '5432'), 10),
      database:      env('DB_NAME', 'session_key_engine'),
      user:          env('DB_USER', 'postgres'),
      password:      env('DB_PASSWORD', ''),
    },
    redis: {
      host:          env('REDIS_HOST', 'localhost'),
      port:          parseInt(env('REDIS_PORT', '6379'), 10),
      password:      process.env.REDIS_PASSWORD || undefined,
    },
    encryptionKey:   env('ENCRYPTION_KEY'),       // 必须设置
    jwtSecret:       env('JWT_SECRET'),            // 必须设置
    apiTokens:       (process.env.API_TOKENS || '').split(',').filter(Boolean),
    chains: {
      eth:           env('ETH_RPC_URL'),
      bsc:           env('BSC_RPC_URL'),
      base:          env('BASE_RPC_URL'),
      polygon:       env('POLYGON_RPC_URL'),
      arbitrum:      env('ARBITRUM_RPC_URL'),
      optimism:      env('OPTIMISM_RPC_URL'),
      xlayer:        env('XLAYER_RPC_URL'),
      sol:           env('SOL_RPC_URL'),
    },
  };
}

function env(key: string, fallback?: string): string {
  const val = process.env[key] || fallback;
  if (val === undefined) throw new Error(`Missing required env: ${key}`);
  return val;
}
```

#### API 路由设计

| 方法 | 路径 | Auth | 说明 | 请求体 | 响应 |
|------|------|:---:|------|--------|------|
| `GET` | `/api/v1/nonce` | — | 获取一次性 Nonce | query: `?user=0x...` | `{nonce, message}` |
| `POST` | `/api/v1/sessions` | — | 创建 Session | `{signature, chain, permissions, ...}` | `{session_id, ...}` |
| `GET` | `/api/v1/sessions` | Bearer | 列表 | query: `?user=0x...&status=active` | `{sessions: [...]}` |
| `GET` | `/api/v1/sessions/:id` | Bearer | 详情 | — | Session 对象 |
| `DELETE` | `/api/v1/sessions/:id` | Bearer | 撤销 | — | `{ok: true}` |
| `POST` | `/api/v1/execute` | Bearer | 执行交易 | `{session_id, to, data, value}` | `{tx_hash, ...}` |
| `GET` | `/api/v1/health` | — | 健康检查 | — | `{status: "ok"}` |

#### 核心业务逻辑 (`services/execution-service.ts`)

```typescript
import { AppError, Errors, decrypt, loadEncryptionKey } from '@sftgroup/session-key-core';
import { SessionRepo } from '../repos/session-repo';
import { ExecutionRepo } from '../repos/execution-repo';
import { signAndBroadcast } from '@sftgroup/session-key-evm';
import Redis from 'ioredis';

export class ExecutionService {
  constructor(
    private sessionRepo: SessionRepo,
    private executionRepo: ExecutionRepo,
    private redis: Redis,
    private rpcUrls: Record<string, string>,
  ) {}

  async execute(req: { sessionId: string; to: string; data: string; value: string; gasLimit?: string }) {
    // 分布式锁：同一 Session 串行执行
    const lockKey = `lock:session:${req.sessionId}`;
    const locked = await this.redis.set(lockKey, '1', 'NX', 'EX', 30);
    if (!locked) throw new AppError(429, 'SESSION_LOCKED', 'Session is being used');

    try {
      const session = await this.sessionRepo.findById(req.sessionId);
      if (!session) throw new AppError(404, Errors.SESSION_NOT_FOUND.msg);
      if (session.status === 'expired') throw new AppError(403, Errors.SESSION_EXPIRED.msg);
      if (session.status === 'revoked') throw new AppError(403, Errors.SESSION_REVOKED.msg);
      
      // 合约白名单校验
      if (!session.permissions.contracts.includes(req.to.toLowerCase())) {
        throw new AppError(403, Errors.CONTRACT_FORBIDDEN.msg);
      }
      
      // 函数白名单校验（如有配置）
      const selector = req.data.slice(0, 10);
      if (session.permissions.functions?.length && 
          !session.permissions.functions.includes(selector)) {
        throw new AppError(403, Errors.FUNCTION_FORBIDDEN.msg);
      }
      
      // TODO: 额度校验（需要 USDC 价格 Oracle）
      
      // 解密私钥 → 签名 → 广播
      const encryptKey = loadEncryptionKey();
      const privateKey = decrypt(session.sessionKeyEnc, encryptKey);
      const rpcUrl = this.rpcUrls[session.chain];
      
      const { txHash, success, reason } = await signAndBroadcast({
        privateKey,
        chain: session.chain,
        rpcUrl,
        to: req.to,
        data: req.data,
        value: req.value,
        gasLimit: req.gasLimit,
      });
      
      // 记录执行日志
      await this.executionRepo.insert({
        sessionId: req.sessionId,
        txHash,
        contract: req.to,
        functionSig: selector,
        value: req.value,
        status: success ? 'success' : 'failed',
        errorReason: reason,
      });

      return { executionId: crypto.randomUUID(), txHash, status: success ? 'success' : 'failed' };
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
```

---

### 2.4 包 4/4：`@sftgroup/session-key-react`

**职责**：前端 React 组件，嵌入各项目

```
packages/react/
├── src/
│   ├── index.ts                # barrel export
│   ├── components/
│   │   ├── SessionKeyAuth.tsx    # 创建授权页面
│   │   ├── SessionKeyList.tsx    # 授权列表
│   │   ├── SessionKeyDetail.tsx  # 单个详情
│   │   ├── ExpirySelector.tsx    # 有效期选择器
│   │   ├── ContractSelector.tsx  # 合约白名单选择器
│   │   └── PermissionPreview.tsx # 签名预览
│   ├── hooks/
│   │   ├── useSessionKeys.ts     # 获取/管理 session 列表
│   │   ├── useWalletAuth.ts      # 钱包连接 + EIP-712 签名
│   │   └── useEngineClient.ts    # REST API 客户端
│   └── styles/
│       └── index.css
├── package.json
└── tsconfig.json
```

#### 组件接口设计

```typescript
// SessionKeyAuth: 创建授权页面的完整组件
interface SessionKeyAuthProps {
  chain: string;                              // 目标链
  engineUrl: string;                          // REST API 地址（环境变量注入）
  presetContracts?: string[];                 // 预设合约白名单
  onCreated?: (session: Session) => void;
  onError?: (err: Error) => void;
}

// SessionKeyList: 授权列表
interface SessionKeyListProps {
  userAddress: string;
  chain?: string;                             // 按链筛选
  engineUrl: string;
  onRevoke?: (sessionId: string) => void;
}
```

---

### 2.5 数据库 Migration (`deploy/migrations/001_init.sql`)

```sql
-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Session Keys 主表
CREATE TABLE session_keys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         VARCHAR(64)     NOT NULL,
    chain           VARCHAR(16)     NOT NULL,
    session_address VARCHAR(44)     NOT NULL,
    session_key_enc TEXT            NOT NULL,          -- AES-256-GCM 加密的私钥
    valid_from      TIMESTAMP       NOT NULL DEFAULT NOW(),
    valid_until     TIMESTAMP       NOT NULL,
    permissions     JSONB           NOT NULL DEFAULT '{}',
    max_per_tx      DECIMAL(36,18)  NOT NULL,
    max_total       DECIMAL(36,18)  NOT NULL,
    total_spent     DECIMAL(36,18)  NOT NULL DEFAULT 0,
    status          VARCHAR(16)     NOT NULL DEFAULT 'active',
    created_at      TIMESTAMP       NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMP,
    
    CONSTRAINT chk_status CHECK (status IN ('active','revoked','expired','quota_exhausted'))
);

CREATE INDEX idx_session_keys_user ON session_keys(user_id);
CREATE INDEX idx_session_keys_user_chain ON session_keys(user_id, chain);
CREATE INDEX idx_session_keys_status ON session_keys(status);

-- 执行日志表
CREATE TABLE session_executions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID            NOT NULL REFERENCES session_keys(id) ON DELETE CASCADE,
    tx_hash         VARCHAR(66)     NOT NULL,
    contract        VARCHAR(42)     NOT NULL,
    function_sig    VARCHAR(10)     NOT NULL,
    value           DECIMAL(36,18)  NOT NULL DEFAULT 0,
    status          VARCHAR(16)     NOT NULL DEFAULT 'pending',
    error_reason    TEXT,
    executed_at     TIMESTAMP       NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_exec_session ON session_executions(session_id);
CREATE INDEX idx_exec_hash ON session_executions(tx_hash);
```

---

## 3. 环境变量完整清单

```bash
# ===== 服务配置 =====
PORT=3500
NODE_ENV=production

# ===== 数据库 =====
DB_HOST=localhost
DB_PORT=5432
DB_NAME=session_key_engine
DB_USER=postgres
DB_PASSWORD=your-db-password

# ===== Redis =====
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# ===== 安全 =====
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  # 64 hex chars = 32 bytes
JWT_SECRET=your-jwt-secret-min-32-chars

# ===== API Token（接入项目的 Bearer Token，逗号分隔）=====
API_TOKENS=aitrader-token-xxx,aihunter-token-xxx,predx-token-xxx

# ===== RPC URLs（每个链独立的 RPC）=====
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/xxx
BSC_RPC_URL=https://bsc-dataseed.binance.org
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/xxx
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/xxx
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/xxx
OPTIMISM_RPC_URL=https://opt-mainnet.g.alchemy.com/v2/xxx
XLAYER_RPC_URL=https://rpc.xlayer.tech
SOL_RPC_URL=https://api.mainnet-beta.solana.com
```

---

## 4. Docker 部署

### 4.1 Dockerfile

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/evm/package.json packages/evm/
COPY packages/server/package.json packages/server/

RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY packages/core/ packages/core/
COPY packages/evm/ packages/evm/
COPY packages/server/ packages/server/

RUN pnpm run build -r

FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app/packages/server/dist /app/dist
COPY --from=builder /app/node_modules /app/node_modules

ENV NODE_ENV=production
EXPOSE 3500

CMD ["node", "dist/index.js"]
```

### 4.2 docker-compose.yml

```yaml
version: '3.8'

services:
  session-key-engine:
    build:
      context: .
      dockerfile: deploy/docker/Dockerfile
    ports:
      - "3500:3500"
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3500/api/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: session_key_engine
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./deploy/migrations:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
  redisdata:
```

---

## 5. 各项目接入示例

### Python 项目 (AItrader / PredX)

```python
import os
import requests

ENGINE_URL = os.getenv("SESSION_KEY_ENGINE_URL", "http://localhost:3500")
ENGINE_TOKEN = os.getenv("SESSION_KEY_ENGINE_TOKEN")

def execute_trade(session_id: str, to: str, data: str, value: str = "0"):
    resp = requests.post(
        f"{ENGINE_URL}/api/v1/execute",
        json={
            "session_id": session_id,
            "chain": "eth",
            "to": to,
            "data": data,
            "value": value,
        },
        headers={"Authorization": f"Bearer {ENGINE_TOKEN}"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()
```

### Node.js 项目 (AIHunter SaaS)

```typescript
import { SessionKeyClient } from '@sftgroup/session-key-server/client';

const client = new SessionKeyClient({
  baseUrl: process.env.SESSION_KEY_ENGINE_URL!,
  apiKey: process.env.SESSION_KEY_ENGINE_TOKEN!,
});

const result = await client.execute({
  sessionId,
  chain: 'eth',
  to: '0xUniswapRouter',
  data: swapCallData,
  value: '0',
});
```

### React 前端集成

```tsx
import { SessionKeyAuth, SessionKeyList } from '@sftgroup/session-key-react';

// engineUrl 从环境变量注入
const ENGINE_URL = import.meta.env.VITE_SESSION_KEY_ENGINE_URL;

function TradingPage() {
  return (
    <>
      <SessionKeyAuth
        chain="eth"
        engineUrl={ENGINE_URL}
        presetContracts={['0xE592427A0AEce92De3Edee1F18E0157C05861564']}
      />
      <SessionKeyList
        userAddress={walletAddress}
        engineUrl={ENGINE_URL}
      />
    </>
  );
}
```

---

## 6. 开发排期

| # | 任务 | 预估 | 依赖 |
|---|------|------|------|
| 1 | `core` 包：类型 + 加解密 + 错误码 | 0.5天 | — |
| 2 | `evm` 包：签名验证 + RPC 注册表 | 0.5天 | 1 |
| 3 | `server` 数据库 Migration + repo 层 | 0.5天 | 1 |
| 4 | `server` API 路由 + service 层 | 1天 | 1,2,3 |
| 5 | `server` 集成测试 | 0.5天 | 4 |
| 6 | `react` 前端组件库 | 1天 | 1 |
| 7 | Docker 部署配置 + 文档 | 0.5天 | 5 |
| 8 | 各项目接入适配 | 每项目 0.5天 | 5,6 |

**总计**：约 4-6 天

---

## 7. 质量保证

### 7.1 测试策略

| 层级 | 工具 | 覆盖要求 |
|------|------|----------|
| 单元测试 | Vitest | core/evm > 90% |
| 集成测试 | Vitest + Testcontainers | 所有 API 端点 |
| E2E | Playwright | 创建→撤销完整流程 |

### 7.2 安全措施

| # | 措施 |
|---|------|
| S-01 | 私钥 AES-256-GCM 加密，密钥通过 ENCRYPTION_KEY 环境变量注入 |
| S-02 | /api/v1/execute 需 Bearer Token 认证 |
| S-03 | 单 Session Redis 分布式锁防并发 |
| S-04 | 私钥仅在内存中解密，不落盘 |
| S-05 | 合约白名单 + 函数白名单 + 额度三重校验 |
| S-06 | Nonce 30 分钟过期，一次性使用 |
| S-07 | 所有敏感操作日志记录 |

---

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-07-31 | 初稿：开发方案完整版 |
