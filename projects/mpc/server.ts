// PocketX MPC Server — email-based MPC key shard management
// Standalone Express service, independent of other PocketX modules
import express from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import crypto from 'crypto';
import { ethers } from 'ethers';
import nodemailer from 'nodemailer';
import { createAuthMiddleware } from '../shared/auth-express';
import { GatewayProvider } from './gatewayProvider';

// M4 生产修复：undici 默认 headersTimeout(300s) < CGGMP trusted_dealer prime 生成
// （慢机实测可达 5min+，Node 20 单核）→ 全局 dispatcher 放大超时，否则 tssImport
// (fetch 9201 /v1/import) 长请求会被 undici 掐断报 "TSS key split failed: fetch failed"。
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 1_800_000, bodyTimeout: 1_800_000 }));

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// 统一平台鉴权契约（Bearer / X-API-Key / X-Service-Key 三选一）
// 本地 MPC_API_KEY（bridge key）或 data 服务签发的 mp_ key（scope=mpc）放行；
// /health /metrics 豁免；外部 key 经 data POST /api-keys/verify 实时校验。
const authMw = createAuthMiddleware({
  envKeys: process.env.MPC_API_KEY,
  scope: 'mpc',
  verifyUrl: process.env.DATA_URL,
  verifyKey: process.env.DATA_API_KEY,
});
app.use(authMw);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ubuntu@localhost:5432/pocketx_mpc',
  max: 10,
  idleTimeoutMillis: 30000,
});

function asyncHandler(fn: any) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}

function apiResponse(data: any = null, message = 'success', code = 0) {
  return { code, message, data };
}

// ─── Encryption helpers ───
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function deriveKey(email: string, salt: string): Buffer {
  const serverSecret = process.env.MPC_ENCRYPTION_SECRET;
  if (!serverSecret || serverSecret === 'mpc-dev-secret-change-in-production') {
    throw new Error('MPC_ENCRYPTION_SECRET is not set. Server refused to start.');
  }
  return crypto.pbkdf2Sync(email.toLowerCase() + serverSecret, salt, 100000, 32, 'sha256');
}

const PBKDF2_SALT_LENGTH = 32; // 256-bit random salt per user

function encryptShard(shard: string, email: string): string {
  const salt = crypto.randomBytes(PBKDF2_SALT_LENGTH).toString('hex');
  const key = deriveKey(email, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(shard, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return salt + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decryptShard(encryptedData: string, email: string): string {
  const parts = encryptedData.split(':');

  let salt: string;
  let iv: Buffer;
  let authTag: Buffer;
  let ciphertext: string;

  if (parts.length === 4) {
    // New format: salt:iv:authTag:ciphertext
    salt = parts[0];
    iv = Buffer.from(parts[1], 'hex');
    authTag = Buffer.from(parts[2], 'hex');
    ciphertext = parts[3];
  } else if (parts.length === 3) {
    // Legacy format (pre-salt): iv:authTag:ciphertext — fallback to hardcoded salt
    salt = 'mpc-salt';
    iv = Buffer.from(parts[0], 'hex');
    authTag = Buffer.from(parts[1], 'hex');
    ciphertext = parts[2];
  } else {
    throw new Error('Invalid encrypted shard format');
  }

  const key = deriveKey(email, salt);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ─── E-2a：Shamir 2-of-2 分片（GF(p)，p=secp256k1 素数域，256 位私钥） ───
// f(x) = secret + a·x (mod p)，片1=f(1)、片2=f(2)；
// 合并：secret = 2·片1 − 片2 (mod p)。单片不含 secret 任何信息（信息论安全）。
const SSS_PRIME = 2n ** 256n - 2n ** 32n - 977n;

function sssMod(n: bigint, m: bigint): bigint {
  const r = n % m;
  return r < 0n ? r + m : r;
}

function sssSplit(secretHex: string): { shard1: string; shard2: string } {
  const secret = BigInt('0x' + secretHex.replace(/^0x/, ''));
  const a = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % SSS_PRIME;
  const shard1 = sssMod(secret + a, SSS_PRIME);
  const shard2 = sssMod(secret + 2n * a, SSS_PRIME);
  return {
    shard1: shard1.toString(16).padStart(64, '0'),
    shard2: shard2.toString(16).padStart(64, '0'),
  };
}

function sssMerge(shard1Hex: string, shard2Hex: string): string {
  const s1 = BigInt('0x' + shard1Hex.replace(/^0x/, ''));
  const s2 = BigInt('0x' + shard2Hex.replace(/^0x/, ''));
  return sssMod(2n * s1 - s2, SSS_PRIME).toString(16).padStart(64, '0');
}

// ─── E-2b：SMTP 真实发信（未配置则回退 console.log，向后兼容） ───
function getMailer() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: (process.env.SMTP_PORT || '465') === '465',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

async function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  const mailer = getMailer();
  if (!mailer) return false; // SMTP 未配置 → 调用方回退 console.log
  try {
    await mailer.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'InfraX'}" <${process.env.MAIL_FROM || process.env.SMTP_USER || 'noreply@infrax.ai'}>`,
      to: email,
      subject: '【InfraX】MPC 钱包验证码',
      text: `您的 InfraX MPC 钱包验证码是：${code}，5 分钟内有效。若非本人操作请忽略。`,
    });
    return true;
  } catch (e: any) {
    console.error('[MPC] SMTP send error:', e.message);
    return false; // 发信失败回退日志，不阻断 API
  }
}

// ─── E-2b：验证码哈希（不存明文） ───
function hashCode(email: string, code: string): string {
  return crypto.createHmac('sha256', email.toLowerCase() + (process.env.MPC_ENCRYPTION_SECRET || '')).update(code).digest('hex');
}

// ─── 片2 加密：RecoveryKey（邮箱 + 服务端密钥 + recovery 上下文分离） ───
// 片1 key=PBKDF2(email+secret)；片2 key=PBKDF2(email+secret+'mpc-recovery', 加密串自带 salt)——
// 两片密钥不同（上下文分离），DB 任一单片密文均无法还原私钥。
function recoveryKey(email: string, salt: string): Buffer {
  const serverSecret = process.env.MPC_ENCRYPTION_SECRET;
  if (!serverSecret || serverSecret === 'mpc-dev-secret-change-in-production') {
    throw new Error('MPC_ENCRYPTION_SECRET is not set. Server refused to start.');
  }
  return crypto.pbkdf2Sync(email.toLowerCase() + serverSecret + ':mpc-recovery', salt, 100000, 32, 'sha256');
}

function encryptRecoveryShard(shard: string, email: string): string {
  const salt = crypto.randomBytes(PBKDF2_SALT_LENGTH).toString('hex');
  const key = recoveryKey(email, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(shard, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return salt + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decryptRecoveryShard(encryptedData: string, email: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 4) throw new Error('Invalid recovery shard format');
  const key = recoveryKey(email, parts[0]);
  const iv = Buffer.from(parts[1], 'hex');
  const authTag = Buffer.from(parts[2], 'hex');
  const ciphertext = parts[3];
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ─── E-2b：验证码 DB 存储（哈希、一次性、5min、5 次尝试） ───
async function storeCode(email: string, code: string): Promise<void> {
  const emailLower = email.toLowerCase();
  await pool.query(
    `INSERT INTO mpc_verification_codes (email, code_hash, expires_at, attempts, created_at)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (email) DO UPDATE SET code_hash = $2, expires_at = $3, attempts = 0, created_at = $4`,
    [emailLower, hashCode(emailLower, code), Date.now() + 5 * 60_000, Date.now()]
  );
}

async function verifyCode(email: string, code: string): Promise<void> {
  const emailLower = email.toLowerCase();
  const result = await pool.query(
    `SELECT code_hash, expires_at, attempts FROM mpc_verification_codes WHERE email = $1`,
    [emailLower]
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error('No verification code for this email. Call /send-code first.'), { statusCode: 400 });
  }
  const record = result.rows[0];
  if (Date.now() > record.expires_at) {
    await pool.query(`DELETE FROM mpc_verification_codes WHERE email = $1`, [emailLower]);
    throw Object.assign(new Error('Code expired (5 min)'), { statusCode: 400 });
  }
  if (record.attempts >= 5) {
    await pool.query(`DELETE FROM mpc_verification_codes WHERE email = $1`, [emailLower]);
    throw Object.assign(new Error('Too many attempts'), { statusCode: 429 });
  }
  await pool.query(`UPDATE mpc_verification_codes SET attempts = attempts + 1 WHERE email = $1`, [emailLower]);
  if (hashCode(emailLower, code) !== record.code_hash) {
    throw Object.assign(new Error('Invalid code'), { statusCode: 400 });
  }
  await pool.query(`DELETE FROM mpc_verification_codes WHERE email = $1`, [emailLower]);
}

// ─── Chain RPC（DC-3：统一经 chain-rpc 网关汇总分发，禁止直连上游） ───
const CHAIN_RPC_URL = (process.env.CHAIN_RPC_URL || 'http://127.0.0.1:9130').replace(/\/+$/, '');
const CHAIN_RPC_READ_KEY = process.env.CHAIN_RPC_READ_KEY || '';
const CHAIN_RPC_BROADCAST_KEY = process.env.CHAIN_RPC_BROADCAST_KEY || '';

const CHAIN_IDS: Record<string, number> = {
  sepolia: 11155111, eth: 1, bsc: 56, base: 8453, oxa: 19505,
};

function getProvider(chain: string): ethers.JsonRpcProvider {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) throw Object.assign(new Error(`Unsupported chain: ${chain}`), { statusCode: 400 });
  return new GatewayProvider(chain, chainId, {
    gateway: CHAIN_RPC_URL,
    readKey: CHAIN_RPC_READ_KEY,
    broadcastKey: CHAIN_RPC_BROADCAST_KEY,
  });
}

const AGENT_TX_LIMIT_ETH = parseFloat(process.env.MPC_AGENT_TX_LIMIT_ETH || '0.1');
// E-2c：Agent 授权补强 —— ERC20 单笔限额 + 高风险操作白名单（配置为空 = 不限制，向后兼容）
const AGENT_ERC20_LIMIT = process.env.MPC_AGENT_ERC20_LIMIT || '1000';
const CONTRACT_WHITELIST = (process.env.MPC_CONTRACT_WHITELIST || '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
const APPROVE_WHITELIST = (process.env.MPC_APPROVE_WHITELIST || '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
const TRANSFER_WHITELIST = (process.env.MPC_TRANSFER_WHITELIST || '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
// E-2d：会话有效期可配（默认 30min）
const SESSION_TTL_MS = parseInt(process.env.MPC_SESSION_TTL_MS || String(30 * 60_000), 10);

// ─── M3：TSS 签名器（cggmp24 2-of-2）—— Node mpc server 持片1，tss_signer 进程持片2 ───
const MPC_SIGNER_URL = (process.env.MPC_SIGNER_URL || 'http://127.0.0.1:9201').replace(/\/+$/, '');
const TSS_SIGNER_URL = (process.env.TSS_SIGNER_URL || 'http://127.0.0.1:9200').replace(/\/+$/, '');

const sessions = new Map<string, {
  shard1?: any;            // M3 TSS 片1（trusted_dealer KeyShare JSON）
  shard2?: any;            // M3 TSS 片2（RecoveryKey 解密后，注册进 tss_signer）
  wallet?: ethers.Wallet;  // 遗留 Shamir 钱包回退路径（sessions 不再持有完整私钥）
  address: string;
  email: string;
  unlockedAt: number;
  expiresAt: number;
}>();

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── M3：TSS 签名器客户端（Node 侧只持分片，完整私钥永不重建） ───
async function tssImport(privateKey: string): Promise<{ shard1: any; shard2: any; address: string }> {
  const resp = await fetch(`${MPC_SIGNER_URL}/v1/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ private_key: privateKey }),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`TSS import failed (${resp.status}): ${body ? JSON.stringify(body) : ''}`);
  return body;
}

async function tssRegisterShard2(walletAddress: string, shard2: any): Promise<void> {
  const resp = await fetch(`${TSS_SIGNER_URL}/v1/keystore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: walletAddress, share: shard2 }),
  });
  if (!resp.ok) throw new Error(`TSS shard2 register failed (${resp.status}): ${await resp.text()}`);
}

async function tssSign(share1: any, walletAddress: string, msgHash: string): Promise<string> {
  const resp = await fetch(`${MPC_SIGNER_URL}/v1/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ share1, wallet_address: walletAddress, msg_hash: msgHash }),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`TSS sign failed (${resp.status}): ${body ? JSON.stringify(body) : ''}`);
  return body.signature as string; // 64B r||s（128 hex 字符）
}

async function tssShareAddress(share1: any): Promise<string> {
  const resp = await fetch(`${MPC_SIGNER_URL}/v1/address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ share: share1 }),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`TSS address lookup failed (${resp.status})`);
  return body.address;
}

// 64B r||s → ethers Signature（v 逐试 27/28 直到恢复地址匹配）
async function ethersSignatureFromRs(rs: string, digest: string, expectedAddress: string): Promise<ethers.Signature> {
  const r = '0x' + rs.slice(0, 64);
  const s = '0x' + rs.slice(64);
  for (const v of [27, 28]) {
    const sig = ethers.Signature.from({ r, s, v });
    const recovered = ethers.recoverAddress(digest, sig);
    if (recovered.toLowerCase() === expectedAddress.toLowerCase()) return sig;
  }
  throw new Error('TSS signature recovery mismatch');
}

// 组装未签名交易并计算待签摘要（EIP-1559；不支持 1559 的链回退 type-0）
async function buildUnsignedTx(
  provider: ethers.JsonRpcProvider,
  from: string,
  params: { to: string; value?: bigint; data?: string },
): Promise<{ txReq: any; digest: string }> {
  const network = await provider.getNetwork();
  const feeData = await provider.getFeeData();
  const nonce = await provider.getTransactionCount(from);
  const txReq: any = {
    type: feeData.maxFeePerGas ? 2 : 0,
    chainId: network.chainId,
    nonce,
    to: params.to,
    value: params.value || 0n,
  };
  if (params.data) txReq.data = params.data;
  if (txReq.type === 2) {
    txReq.maxFeePerGas = feeData.maxFeePerGas;
    txReq.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || (feeData.maxFeePerGas / 2n);
  } else {
    txReq.gasPrice = feeData.gasPrice;
  }
  let gasLimit = 21000n;
  try {
    gasLimit = await provider.estimateGas({ from, to: params.to, value: txReq.value, ...(params.data ? { data: params.data } : {}) });
  } catch { /* 估算失败用默认 gas */ }
  txReq.gasLimit = gasLimit;
  return { txReq, digest: ethers.Transaction.from(txReq).unsignedHash };
}

// 统一发交易：TSS 路径（摘要 → TSS 签名 → 广播）或遗留 Wallet 路径
async function broadcastTxn(
  session: any,
  provider: ethers.JsonRpcProvider,
  params: { to: string; value?: bigint; data?: string },
): Promise<ethers.TransactionResponse> {
  const { txReq, digest } = await buildUnsignedTx(provider, session.address, params);
  if (session.shard1) {
    const rs = await tssSign(session.shard1, session.address, digest);
    const sig = await ethersSignatureFromRs(rs, digest, session.address);
    const signed = ethers.Transaction.from({ ...txReq, signature: sig });
    return await provider.broadcastTransaction(signed.serialized);
  }
  return await session.wallet!.connect(provider).sendTransaction(txReq);
}

// 解密钱包行 → 会话数据（TSS 持分片；遗留 Shamir 钱包回退重建 Wallet）
// TSS 钱包存储的是 KeyShare JSON（以 '{' 开头），遗留是 64 hex 私钥分片。
async function buildSessionData(
  email: string,
  wrow: { wallet_address: string; encrypted_shard: string; recovery_shard: string | null },
): Promise<{ address: string; shard1?: any; shard2?: any; wallet?: ethers.Wallet }> {
  const shard1Str = decryptShard(wrow.encrypted_shard, email);
  if (shard1Str.trim().startsWith('{')) {
    // M3 TSS 钱包：只持分片句柄，不重建完整私钥
    const shard1 = JSON.parse(shard1Str);
    const shard2Str = wrow.recovery_shard ? decryptRecoveryShard(wrow.recovery_shard, email) : null;
    if (!shard2Str) throw Object.assign(new Error('TSS wallet missing recovery shard'), { statusCode: 500 });
    const shard2 = JSON.parse(shard2Str);
    const address = await tssShareAddress(shard1);
    if (address.toLowerCase() !== wrow.wallet_address.toLowerCase()) {
      throw Object.assign(new Error('Recovered key mismatch'), { statusCode: 500 });
    }
    await tssRegisterShard2(wrow.wallet_address, shard2); // 片2 注册进 tss_signer（幂等）
    return { address, shard1, shard2 };
  }
  // 遗留 Shamir 钱包：保持原双片合并回退路径
  const privateKey = wrow.recovery_shard
    ? sssMerge(shard1Str, decryptRecoveryShard(wrow.recovery_shard, email))
    : shard1Str;
  const wallet = new ethers.Wallet(privateKey);
  if (wallet.address.toLowerCase() !== wrow.wallet_address.toLowerCase()) {
    throw Object.assign(new Error('Recovered key mismatch'), { statusCode: 500 });
  }
  return { address: wallet.address, wallet };
}

async function getSession(token: string) {
  // 内存优先；miss/过期 → 查 DB（E-2d：重启后经 token 哈希定位并重建 wallet）
  const cached = sessions.get(token);
  if (cached) {
    if (Date.now() > cached.expiresAt) {
      sessions.delete(token);
      await pool.query(`DELETE FROM mpc_sessions WHERE token_hash = $1`, [tokenHash(token)]).catch(() => {});
      throw Object.assign(new Error('Session expired. Call /session/unlock again.'), { statusCode: 401 });
    }
    return cached;
  }
  const rowResult = await pool.query(
    `SELECT email, wallet_address, expires_at FROM mpc_sessions WHERE token_hash = $1`,
    [tokenHash(token)]
  );
  if (rowResult.rows.length === 0) {
    throw Object.assign(new Error('Session not found. Call /session/unlock first to get a token.'), { statusCode: 401 });
  }
  const srow = rowResult.rows[0];
  if (Date.now() > srow.expires_at) {
    await pool.query(`DELETE FROM mpc_sessions WHERE token_hash = $1`, [tokenHash(token)]).catch(() => {});
    throw Object.assign(new Error('Session expired. Call /session/unlock again.'), { statusCode: 401 });
  }
  // 由钱包表重建 signer（双片合并），写回内存（E-4④：按 wallet_address 唯一定位，1:N 不歧义）
  const walletRow = await pool.query(
    `SELECT encrypted_shard, recovery_shard FROM mpc_wallets WHERE wallet_address = $1 AND status = 'active'`,
    [srow.wallet_address]
  );
  if (walletRow.rows.length === 0) {
    await pool.query(`DELETE FROM mpc_sessions WHERE token_hash = $1`, [tokenHash(token)]).catch(() => {});
    throw Object.assign(new Error('Wallet no longer active. Call /session/unlock again.'), { statusCode: 401 });
  }
  const wrow = walletRow.rows[0];
  // M3：TSS 钱包持分片句柄；遗留 Shamir 钱包回退重建 Wallet（不再全量 sssMerge）
  const session = {
    ...(await buildSessionData(srow.email, wrow)),
    email: srow.email,
    unlockedAt: srow.unlocked_at,
    expiresAt: srow.expires_at,
  };
  sessions.set(token, session);
  return session;
}

async function auditLog(token: string, action: string, detail: any, txHash?: string, chain?: string) {
  try {
    const session = sessions.get(token);
    const email = session?.email || 'unknown';
    await pool.query(
      `INSERT INTO mpc_agent_logs (id, email, action, chain, tx_hash, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [crypto.randomUUID(), email.toLowerCase(), action, chain || null, txHash || null, JSON.stringify(detail)]
    );
  } catch (e: any) {
    console.error('[MPC] Audit log error:', e.message);
  }
}

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
];

(async () => {
  // 迁移：逐列补齐（老钱包无 recovery_shard 列；shard_count/total_shards 可能已存在）
  const walletCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'mpc_wallets'`
  );
  const existingCols = new Set(walletCols.rows.map((r: any) => r.column_name));
  const addCol = async (col: string, ddl: string) => {
    if (!existingCols.has(col)) await pool.query(`ALTER TABLE mpc_wallets ADD COLUMN ${col} ${ddl}`);
  };
  await addCol('recovery_shard', 'TEXT');
  await addCol('shard_count', 'INTEGER DEFAULT 1');
  await addCol('total_shards', 'INTEGER DEFAULT 2');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mpc_wallets (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      email_verified BOOLEAN DEFAULT false,
      wallet_address TEXT,
      encrypted_shard TEXT NOT NULL,
      recovery_shard TEXT,
      shard_count INTEGER DEFAULT 1,
      total_shards INTEGER DEFAULT 2,
      connected_wallet_address TEXT,
      status TEXT DEFAULT 'active',
      recovered_at TIMESTAMPTZ,
      recovery_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mpc_wallets_email ON mpc_wallets(email);
    CREATE INDEX IF NOT EXISTS idx_mpc_wallets_status ON mpc_wallets(status);
    CREATE INDEX IF NOT EXISTS idx_mpc_wallets_address ON mpc_wallets(wallet_address);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mpc_agent_logs (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      action TEXT NOT NULL,
      chain TEXT,
      tx_hash TEXT,
      detail JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mpc_agent_logs_email ON mpc_agent_logs(email);
    CREATE INDEX IF NOT EXISTS idx_mpc_agent_logs_created ON mpc_agent_logs(created_at);
  `);
  // E-2b：验证码落库（哈希存储，重启不丢；一次性、5min 过期、5 次尝试上限）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mpc_verification_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      attempts INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL
    );
  `);
  // E-2d：会话落库（重启不失效；token 哈希存储，DB 泄露不直接可解锁）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mpc_sessions (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      unlocked_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mpc_sessions_email ON mpc_sessions(email);
  `);
})().catch(e => console.error('[MPC] Table init error:', e.message));

// ─── Health ───
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'pocketx-mpc', uptime: process.uptime() }));

// ─── Send verification code ───
app.post('/api/v2/mpc/send-code', asyncHandler(async (req: any, res: any) => {
  const { email } = req.body;
  if (!email) return res.status(400).json(apiResponse(null, 'email required', 1001));
  const code = String(crypto.randomInt(100000, 1000000)); // 6 位随机码（B-1：移除硬编码 888888 万能码）
  await storeCode(email, code);
  // E-2b：SMTP 配置后真实发信；未配置或发信失败回退日志（向后兼容，不阻断 API）
  const sent = await sendVerificationEmail(email, code);
  if (sent) {
    console.log(`[MPC] Verification code sent via SMTP to ${email}`);
  } else {
    console.log(`[MPC] Code for ${email}: ${code}`); // 真实发信接入前，验证码经日志/存储下发（勿外泄）
  }
  res.json(apiResponse({ message: 'Code sent' }));
}));

// ─── Register（E-4④：1:N —— 同邮箱可派生多个子钱包，每次注册新建一个） ───
app.post('/api/v2/mpc/register', asyncHandler(async (req: any, res: any) => {
  const { email, code, walletAddress } = req.body;
  if (!email || !code) return res.status(400).json(apiResponse(null, 'email + code required', 1001));
  await verifyCode(email, code);

  const emailLower = email.toLowerCase();
  // M3：TSS 2-of-2 分片（trusted_dealer 按随机私钥拆分）—— 仅存分片，完整私钥不落库、不持久化
  const privateKey = ethers.Wallet.createRandom().privateKey;
  let imported: { shard1: any; shard2: any; address: string };
  try {
    imported = await tssImport(privateKey);
  } catch (e: any) {
    return res.status(500).json(apiResponse(null, `TSS key split failed: ${e.message}`, 1007));
  }
  // 片1 服务端 AES（email+secret）；片2 RecoveryKey（email+secret+recovery 上下文）
  const encryptedShard = encryptShard(JSON.stringify(imported.shard1), emailLower);
  const recoveryShard = encryptRecoveryShard(JSON.stringify(imported.shard2), emailLower);
  const connectedAddr = (req.headers['x-wallet-address'] as string) || walletAddress || null;

  const result = await pool.query(
    `INSERT INTO mpc_wallets (id, email, email_verified, wallet_address, encrypted_shard, recovery_shard, shard_count, total_shards, connected_wallet_address)
     VALUES ($1, $2, true, $3, $4, $5, 2, 2, $6) RETURNING id, email, wallet_address, created_at`,
    [crypto.randomUUID(), emailLower, imported.address, encryptedShard, recoveryShard, connectedAddr]
  );

  const row = result.rows[0];
  res.status(201).json(apiResponse({ walletId: row.id, email: row.email, walletAddress: row.wallet_address, createdAt: row.created_at }, 'MPC wallet created'));
}));

// ─── Recover（E-4④：walletId 指定子钱包；缺省 = 首个，向后兼容） ───
app.post('/api/v2/mpc/recover', asyncHandler(async (req: any, res: any) => {
  const { email, code, walletId } = req.body;
  if (!email || !code) return res.status(400).json(apiResponse(null, 'email + code required', 1001));
  await verifyCode(email, code);

  const emailLower = email.toLowerCase();
  const result = await pool.query(
    `SELECT id, email, wallet_address, encrypted_shard, recovery_shard, recovery_count FROM mpc_wallets
     WHERE email = $1 AND status = 'active' ${walletId ? 'AND id = $2' : ''}
     ORDER BY created_at ASC ${walletId ? '' : 'LIMIT 1'}`,
    walletId ? [emailLower, walletId] : [emailLower]
  );
  if (result.rows.length === 0) {
    return res.status(404).json(apiResponse(null, 'No MPC wallet found. Register first.', 1004));
  }

  const row = result.rows[0];
  let recoveredAddress: string;
  try {
    // M3：TSS 钱包验证分片并重注册片2；遗留钱包保持原合并路径（地址校验兜底）
    const data = await buildSessionData(emailLower, row);
    recoveredAddress = data.address;
  } catch (e: any) {
    return res.status(500).json(apiResponse(null, e?.message || 'Failed to decrypt shard', 1007));
  }

  await pool.query(`UPDATE mpc_wallets SET recovered_at = NOW(), recovery_count = recovery_count + 1 WHERE id = $1`, [row.id]);
  res.json(apiResponse({
    walletId: row.id,
    email: row.email,
    walletAddress: recoveredAddress,
    recoveredAt: new Date().toISOString(),
    recoveryCount: row.recovery_count + 1,
  }, 'MPC wallet recovered'));
}));

// ─── Status（E-4④：email 查询可带 walletId 定位子钱包；缺省 = 首个） ───
app.get('/api/v2/mpc/status', asyncHandler(async (req: any, res: any) => {
  const { email, walletAddress, walletId } = req.query;

  if (walletAddress && typeof walletAddress === 'string') {
    const addr = walletAddress.toLowerCase();
    const result = await pool.query(
      `SELECT id, email, wallet_address, email_verified, shard_count, total_shards, created_at, recovered_at, recovery_count, status
       FROM mpc_wallets WHERE LOWER(connected_wallet_address) = $1 OR LOWER(wallet_address) = $1`,
      [addr]
    );
    if (result.rows.length === 0) return res.json(apiResponse({ registered: false }));
    const r = result.rows[0];
    return res.json(apiResponse({ registered: true, walletId: r.id, email: r.email, walletAddress: r.wallet_address, emailVerified: r.email_verified, shardCount: r.shard_count, totalShards: r.total_shards, createdAt: r.created_at, lastRecoveredAt: r.recovered_at, recoveryCount: r.recovery_count, status: r.status }));
  }

  if (!email || typeof email !== 'string') {
    return res.status(400).json(apiResponse(null, 'walletAddress or email required', 1001));
  }

  const result = await pool.query(
    `SELECT id, email, wallet_address, email_verified, shard_count, total_shards, created_at, recovered_at, recovery_count, status
     FROM mpc_wallets WHERE email = $1 AND status = 'active' ${walletId ? 'AND id = $2' : ''}
     ORDER BY created_at ASC ${walletId ? '' : 'LIMIT 1'}`,
    walletId ? [email.toLowerCase(), walletId] : [email.toLowerCase()]
  );
  if (result.rows.length === 0) return res.json(apiResponse({ registered: false }));
  const r = result.rows[0];
  res.json(apiResponse({ registered: true, walletId: r.id, email: r.email, walletAddress: r.wallet_address, emailVerified: r.email_verified, shardCount: r.shard_count, totalShards: r.total_shards, createdAt: r.created_at, lastRecoveredAt: r.recovered_at, recoveryCount: r.recovery_count, status: r.status }));
}));

// ─── Wallets 列表（E-4④：同邮箱全部子钱包，walletId 维度） ───
app.get('/api/v2/mpc/wallets', asyncHandler(async (req: any, res: any) => {
  const { email } = req.query;
  if (!email || typeof email !== 'string') return res.status(400).json(apiResponse(null, 'email required', 1001));
  const result = await pool.query(
    `SELECT id, wallet_address, email_verified, shard_count, total_shards, created_at, recovered_at, recovery_count, status
     FROM mpc_wallets WHERE email = $1 AND status = 'active' ORDER BY created_at ASC`,
    [email.toLowerCase()]
  );
  res.json(apiResponse({
    email,
    count: result.rows.length,
    wallets: result.rows.map((r: any) => ({
      walletId: r.id,
      walletAddress: r.wallet_address,
      emailVerified: r.email_verified,
      shardCount: r.shard_count,
      totalShards: r.total_shards,
      createdAt: r.created_at,
      lastRecoveredAt: r.recovered_at,
      recoveryCount: r.recovery_count,
      status: r.status,
    })),
  }));
}));

// ─── Session Unlock（E-4④：walletId 指定子钱包；缺省 = 首个，向后兼容） ───
app.post('/api/v2/mpc/session/unlock', asyncHandler(async (req: any, res: any) => {
  const { email, code, walletId } = req.body;
  if (!email || !code) return res.status(400).json(apiResponse(null, 'email + code required', 1001));
  await verifyCode(email, code);

  const emailLower = email.toLowerCase();
  const result = await pool.query(
    `SELECT id, email, wallet_address, encrypted_shard, recovery_shard FROM mpc_wallets
     WHERE email = $1 AND status = 'active' ${walletId ? 'AND id = $2' : ''}
     ORDER BY created_at ASC ${walletId ? '' : 'LIMIT 1'}`,
    walletId ? [emailLower, walletId] : [emailLower]
  );
  if (result.rows.length === 0) {
    return res.status(404).json(apiResponse(null, 'No MPC wallet found. Register first.', 1004));
  }

  const row = result.rows[0];
  let sessionData: { address: string; shard1?: any; shard2?: any; wallet?: ethers.Wallet };
  try {
    // M3：TSS 钱包只解密分片（不重建完整私钥）；遗留钱包回退合并路径
    sessionData = await buildSessionData(emailLower, row);
  } catch (e: any) {
    return res.status(500).json(apiResponse(null, e?.message || 'Failed to decrypt shard', 1007));
  }

  const now = Date.now();
  const token = 'mpc_' + crypto.randomBytes(32).toString('hex');
  const expiresAt = now + SESSION_TTL_MS;
  sessions.set(token, {
    ...sessionData,
    email: emailLower,
    unlockedAt: now,
    expiresAt,
  });
  // E-2d：会话落库（token 哈希存储，重启不失效；仅存定位信息，私钥每次经钱包表重建）
  await pool.query(
    `INSERT INTO mpc_sessions (token_hash, email, wallet_address, unlocked_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (token_hash) DO UPDATE SET email = $2, wallet_address = $3, unlocked_at = $4, expires_at = $5`,
    [tokenHash(token), emailLower, sessionData.address, now, expiresAt, now]
  );

  await pool.query(`UPDATE mpc_wallets SET recovered_at = NOW(), recovery_count = recovery_count + 1 WHERE id = $1`, [row.id]);

  res.json(apiResponse({
    token,
    walletId: row.id,
    address: sessionData.address,
    unlockedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  }, 'MPC wallet unlocked. Use this token for all subsequent agent operations.'));
}));

// ─── Session Lock ───
app.post('/api/v2/mpc/session/lock', asyncHandler(async (req: any, res: any) => {
  const { token } = req.body;
  if (!token) return res.status(400).json(apiResponse(null, 'token required', 1001));
  const existed = sessions.has(token) || (await pool.query(`SELECT 1 FROM mpc_sessions WHERE token_hash = $1`, [tokenHash(token)])).rows.length > 0;
  sessions.delete(token);
  await pool.query(`DELETE FROM mpc_sessions WHERE token_hash = $1`, [tokenHash(token)]).catch(() => {});
  res.json(apiResponse({ locked: existed }, existed ? 'Session locked' : 'Session not found'));
}));

// ─── Session Status ───
app.get('/api/v2/mpc/session/status', asyncHandler(async (req: any, res: any) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') return res.status(400).json(apiResponse(null, 'token required', 1001));
  let session = sessions.get(token);
  if (!session) {
    const rowResult = await pool.query(
      `SELECT email, wallet_address, unlocked_at, expires_at FROM mpc_sessions WHERE token_hash = $1`,
      [tokenHash(token)]
    );
    if (rowResult.rows.length === 0) return res.json(apiResponse({ unlocked: false }));
    const r = rowResult.rows[0];
    session = { wallet: null as any, address: r.wallet_address, email: r.email, unlockedAt: r.unlocked_at, expiresAt: r.expires_at };
  }
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    await pool.query(`DELETE FROM mpc_sessions WHERE token_hash = $1`, [tokenHash(token)]).catch(() => {});
    return res.json(apiResponse({ unlocked: false }));
  }
  const remaining = Math.max(0, session.expiresAt - Date.now());
  res.json(apiResponse({
    unlocked: true,
    address: session.address,
    unlockedAt: new Date(session.unlockedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    remainingSeconds: Math.floor(remaining / 1000),
  }));
}));

// ─── Balance ───
app.post('/api/v2/mpc/balance', asyncHandler(async (req: any, res: any) => {
  const { token, chain: chainParam, tokenAddress } = req.body;
  if (!token) return res.status(400).json(apiResponse(null, 'token required', 1001));
  const chain = chainParam || 'sepolia';
  const session = await getSession(token);
  const address = session.address;
  const provider = getProvider(chain);

  const nativeBalance = await provider.getBalance(address);
  const result: any = {
    address,
    chain,
    nativeBalance: ethers.formatEther(nativeBalance),
    nativeSymbol: chain === 'bsc' ? 'BNB' : 'ETH',
  };

  if (tokenAddress && tokenAddress.startsWith('0x')) {
    try {
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const [balance, decimals, symbol] = await Promise.all([
        contract.balanceOf(address),
        contract.decimals(),
        contract.symbol(),
      ]);
      result.token = {
        address: tokenAddress,
        symbol,
        balance: ethers.formatUnits(balance, decimals),
        decimals: Number(decimals),
      };
    } catch (e: any) {
      result.token = { address: tokenAddress, error: e.message };
    }
  }

  res.json(apiResponse(result));
}));

// ─── Sign Message (EIP-191) ───
app.post('/api/v2/mpc/sign-message', asyncHandler(async (req: any, res: any) => {
  const { token, message } = req.body;
  if (!token || !message) return res.status(400).json(apiResponse(null, 'token + message required', 1001));
  const session = await getSession(token);
  let signature: string;
  if (session.shard1) {
    // M3 TSS 路径：Node 侧算 EIP-191 摘要 → TSS 2-of-2 签名
    const digest = ethers.hashMessage(message);
    const rs = await tssSign(session.shard1, session.address, digest);
    const sig = await ethersSignatureFromRs(rs, digest, session.address);
    signature = sig.serialized;
  } else {
    signature = await session.wallet!.signMessage(message);
  }
  await auditLog(token, 'sign_message', { message: message.slice(0, 100) });
  res.json(apiResponse({ signature, address: session.address }, 'Message signed'));
}));

// ─── Sign Typed Data (EIP-712) ───
app.post('/api/v2/mpc/sign-typed-data', asyncHandler(async (req: any, res: any) => {
  const { token, domain, types, value } = req.body;
  if (!token || !domain || !types || !value) return res.status(400).json(apiResponse(null, 'token + domain + types + value required', 1001));
  const session = await getSession(token);
  let signature: string;
  if (session.shard1) {
    // M3 TSS 路径：Node 侧算 EIP-712 摘要 → TSS 2-of-2 签名
    const digest = ethers.TypedDataEncoder.hash(domain, types, value);
    const rs = await tssSign(session.shard1, session.address, digest);
    const sig = await ethersSignatureFromRs(rs, digest, session.address);
    signature = sig.serialized;
  } else {
    signature = await session.wallet!.signTypedData(domain, types, value);
  }
  await auditLog(token, 'sign_typed_data', { domain: JSON.stringify(domain).slice(0, 200) });
  res.json(apiResponse({ signature, address: session.address }, 'Typed data signed'));
}));

// ─── Sign Digest (raw 32B，E-1d：aa-sdk MpcSigner 对 userOpHash/EIP-712 摘要直接签名) ───
// 与 sign-message 不同：不二次哈希。digest 必须是调用方已算好的 32 字节摘要
// （如 ERC-4337 userOpHash、EIP-712 摘要），TSS 底层 IdentityDigest 直接作为 z 签名。
app.post('/api/v2/mpc/sign-digest', asyncHandler(async (req: any, res: any) => {
  const { token, digest } = req.body;
  if (!token || !digest) return res.status(400).json(apiResponse(null, 'token + digest required', 1001));
  const normalized = String(digest).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    return res.status(400).json(apiResponse(null, 'digest must be 32-byte hex', 1001));
  }
  const session = await getSession(token);
  let signature: string;
  if (session.shard1) {
    // M3 TSS 路径：raw 摘要直接交 TSS 2-of-2 签名
    const rs = await tssSign(session.shard1, session.address, digest);
    const sig = await ethersSignatureFromRs(rs, digest, session.address);
    signature = sig.serialized;
  } else {
    const sig = new ethers.SigningKey(session.wallet!.privateKey).sign(normalized);
    signature = ethers.Signature.from(sig).serialized;
  }
  await auditLog(token, 'sign_digest', { digest: digest.slice(0, 34) });
  res.json(apiResponse({ signature, address: session.address }, 'Digest signed'));
}));

// ─── Send Transaction ───
app.post('/api/v2/mpc/send-transaction', asyncHandler(async (req: any, res: any) => {
  const { token, to, amount, chain: chainParam, tokenAddress } = req.body;
  if (!token || !to || !amount) return res.status(400).json(apiResponse(null, 'token + to + amount required', 1001));
  const chain = chainParam || 'sepolia';
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json(apiResponse(null, 'Invalid amount', 1001));

  if (!tokenAddress && amountNum > AGENT_TX_LIMIT_ETH) {
    return res.status(400).json(apiResponse(null, `Amount ${amount} exceeds agent limit ${AGENT_TX_LIMIT_ETH} ETH`, 1001));
  }

  // E-2c：ERC20 单笔限额 + 收款地址白名单（配置后强制，空 = 不限制）
  if (TRANSFER_WHITELIST.length > 0 && !TRANSFER_WHITELIST.includes(to.toLowerCase())) {
    return res.status(400).json(apiResponse(null, `Transfer target ${to} not in whitelist`, 1001));
  }

  const session = await getSession(token);
  const provider = getProvider(chain);
  let tx: ethers.TransactionResponse;

  if (tokenAddress && tokenAddress.startsWith('0x')) {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const decimals = Number(await contract.decimals());
    const parsedAmount = ethers.parseUnits(amount, decimals);
    // E-2c：ERC20 限额（token 数量单位，默认 1000）
    const erc20Limit = ethers.parseUnits(AGENT_ERC20_LIMIT, decimals);
    if (parsedAmount > erc20Limit) {
      return res.status(400).json(apiResponse(null, `Amount ${amount} exceeds ERC20 agent limit ${AGENT_ERC20_LIMIT}`, 1001));
    }
    // M3：calldata 由 Node 侧组装，签名统一走 TSS/遗留广播路径
    const data = new ethers.Interface(ERC20_ABI).encodeFunctionData('transfer', [to, parsedAmount]);
    tx = await broadcastTxn(session, provider, { to: tokenAddress, value: 0n, data });
  } else {
    tx = await broadcastTxn(session, provider, { to, value: ethers.parseEther(amount) });
  }

  await auditLog(token, 'send_transaction', { to, amount, tokenAddress: tokenAddress || 'native' }, tx.hash, chain);

  const receipt = await tx.wait();
  res.json(apiResponse({
    txHash: tx.hash,
    from: session.address,
    to,
    amount,
    chain,
    token: tokenAddress || 'native',
    blockNumber: receipt?.blockNumber,
    gasUsed: receipt?.gasUsed?.toString(),
  }, 'Transaction sent'));
}));

// ─── Contract Read ───
app.post('/api/v2/mpc/contract-read', asyncHandler(async (req: any, res: any) => {
  const { token, contractAddress, abi, method, args, chain: chainParam } = req.body;
  if (!contractAddress || !abi || !method) return res.status(400).json(apiResponse(null, 'contractAddress + abi + method required', 1001));
  if (!token) return res.status(400).json(apiResponse(null, 'token required', 1001));
  await getSession(token); // E-2d：补 session 校验（无效/过期 401）
  const chain = chainParam || 'sepolia';
  const provider = getProvider(chain);
  const contract = new ethers.Contract(contractAddress, abi, provider);
  const result = await contract[method](...(args || []));
  res.json(apiResponse({
    contractAddress,
    method,
    result: typeof result === 'bigint' ? result.toString() : result,
  }));
}));

// ─── Contract Write ───
app.post('/api/v2/mpc/contract-write', asyncHandler(async (req: any, res: any) => {
  const { token, contractAddress, abi, method, args, chain: chainParam, value, gasLimit } = req.body;
  if (!token || !contractAddress || !abi || !method) return res.status(400).json(apiResponse(null, 'token + contractAddress + abi + method required', 1001));
  const chain = chainParam || 'sepolia';

  // E-2c：合约白名单 + approve 的 spender 白名单（配置后强制，空 = 不限制）
  if (CONTRACT_WHITELIST.length > 0 && !CONTRACT_WHITELIST.includes(contractAddress.toLowerCase())) {
    return res.status(400).json(apiResponse(null, `Contract ${contractAddress} not in whitelist`, 1001));
  }
  if (method.toLowerCase() === 'approve' && APPROVE_WHITELIST.length > 0 && args && Array.isArray(args) && args[0]) {
    const spender = String(args[0]).toLowerCase();
    if (!APPROVE_WHITELIST.includes(spender)) {
      return res.status(400).json(apiResponse(null, `Approve spender ${args[0]} not in whitelist`, 1001));
    }
  }

  const session = await getSession(token);
  const provider = getProvider(chain);

  try {
    const staticContract = new ethers.Contract(contractAddress, abi, provider);
    // M3：模拟必须带 from=session.address（无 signer 时默认零地址，transfer/balanceOf 会因余额 0 回退）
    await staticContract[method].staticCall(...(args || []), {
      from: session.address,
      ...(value ? { value: ethers.parseEther(value) } : {}),
    });
  } catch (e: any) {
    return res.status(400).json(apiResponse(null, `Simulation failed: ${e.message}`, 1001));
  }

  // M3：calldata 由 Node 侧组装，签名统一走 TSS/遗留广播路径
  const data = new ethers.Interface(abi).encodeFunctionData(method, args || []);
  const valueBig = value ? ethers.parseEther(value) : 0n;
  const tx = await broadcastTxn(session, provider, { to: contractAddress, value: valueBig, data });
  await auditLog(token, 'contract_write', { contractAddress, method, args }, tx.hash, chain);

  const receipt = await tx.wait();
  res.json(apiResponse({
    txHash: tx.hash,
    from: session.address,
    contractAddress,
    method,
    chain,
    blockNumber: receipt?.blockNumber,
    gasUsed: receipt?.gasUsed?.toString(),
  }, 'Contract call executed'));
}));

// ─── Gas Estimate ───
app.post('/api/v2/mpc/gas-estimate', asyncHandler(async (req: any, res: any) => {
  const { token, to, value, data, chain: chainParam } = req.body;
  if (!token) return res.status(400).json(apiResponse(null, 'token required', 1001));
  await getSession(token); // E-2d：补 session 校验（无效/过期 401）
  const chain = chainParam || 'sepolia';
  const provider = getProvider(chain);

  const txParams: any = {};
  if (to) txParams.to = to;
  if (value) txParams.value = ethers.parseEther(value);
  if (data) txParams.data = data;

  const [gasLimit, feeData] = await Promise.all([
    provider.estimateGas(txParams).catch(() => 21000n),
    provider.getFeeData(),
  ]);

  const gasPrice = feeData.gasPrice || 0n;
  const estimatedCost = gasLimit * gasPrice;

  res.json(apiResponse({
    chain,
    gasLimit: gasLimit.toString(),
    gasPrice: ethers.formatUnits(gasPrice, 'gwei') + ' Gwei',
    estimatedCost: ethers.formatEther(estimatedCost) + ' ETH',
    estimatedCostWei: estimatedCost.toString(),
  }));
}));

// ─── 统一 JSON 错误处理器 ───
// asyncHandler 抛出的错误（verifyCode 400/429、session 401、unsupported chain 400 等）
// 若不加此处理器，Express 默认错误页返回 HTML，破坏信封契约 {code,message,data}。
app.use((err: any, _req: any, res: any, _next: any) => {
  const status = typeof err?.statusCode === 'number' ? err.statusCode
    : typeof err?.status === 'number' ? err.status
    : 500;
  const code = typeof err?.code === 'number' ? err.code : status >= 500 ? 1007 : 1001;
  const message = err?.message || 'Internal server error';
  if (status >= 500) console.error('[MPC] Error:', err);
  res.status(status).json(apiResponse(null, message, code));
});

// ─── Start ───
const PORT = parseInt(process.env.PORT || '6003', 10);
app.listen(PORT, () => console.log(`MPC API running on port ${PORT}`));
