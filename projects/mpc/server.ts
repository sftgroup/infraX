// PocketX MPC Server — email-based MPC key shard management
// Standalone Express service, independent of other PocketX modules
import express from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import crypto from 'crypto';
import { ethers } from 'ethers';

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

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

function deriveKey(email: string): Buffer {
  const serverSecret = process.env.MPC_ENCRYPTION_SECRET;
  if (!serverSecret || serverSecret === 'mpc-dev-secret-change-in-production') {
    throw new Error('MPC_ENCRYPTION_SECRET is not set. Server refused to start.');
  }
  return crypto.pbkdf2Sync(email.toLowerCase() + serverSecret, 'mpc-salt', 100000, 32, 'sha256');
}

function encryptShard(shard: string, email: string): string {
  const key = deriveKey(email);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(shard, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decryptShard(encryptedData: string, email: string): string {
  const key = deriveKey(email);
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted shard format');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(parts[2], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ─── In-memory verification codes (same pattern as WAAS) ───
const mpcCodes = new Map<string, { code: string; expiresAt: number; attempts: number }>();

function storeCode(email: string, code: string): void {
  mpcCodes.set(email.toLowerCase(), { code, expiresAt: Date.now() + 5 * 60_000, attempts: 0 });
}

function verifyCode(email: string, code: string): void {
  const record = mpcCodes.get(email.toLowerCase());
  if (!record) throw Object.assign(new Error('No verification code for this email'), { statusCode: 400 });
  if (Date.now() > record.expiresAt) { mpcCodes.delete(email.toLowerCase()); throw Object.assign(new Error('Code expired (5 min)'), { statusCode: 400 }); }
  if (record.attempts >= 5) { mpcCodes.delete(email.toLowerCase()); throw Object.assign(new Error('Too many attempts'), { statusCode: 429 }); }
  record.attempts++;
  if (code !== record.code) throw Object.assign(new Error('Invalid code'), { statusCode: 400 });
  mpcCodes.delete(email.toLowerCase());
}

const RPC_ENDPOINTS: Record<string, string> = {
  sepolia: process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  eth:     process.env.ETH_RPC_URL     || 'https://ethereum-rpc.publicnode.com',
  bsc:     process.env.BSC_RPC_URL     || 'https://bsc-dataseed.bnbchain.org',
  base:    process.env.BASE_RPC_URL    || 'https://mainnet.base.org',
  oxa:     process.env.OXA_RPC_URL     || 'https://rpc-oxa.0xainet.top',
};

const CHAIN_IDS: Record<string, number> = {
  sepolia: 11155111, eth: 1, bsc: 56, base: 8453, oxa: 19505,
};

function getProvider(chain: string): ethers.JsonRpcProvider {
  const url = RPC_ENDPOINTS[chain];
  if (!url) throw Object.assign(new Error(`Unsupported chain: ${chain}`), { statusCode: 400 });
  return new ethers.JsonRpcProvider(url);
}

const AGENT_TX_LIMIT_ETH = parseFloat(process.env.MPC_AGENT_TX_LIMIT_ETH || '0.1');
const SESSION_TTL_MS = 30 * 60_000;

const sessions = new Map<string, {
  wallet: ethers.Wallet;
  address: string;
  email: string;
  unlockedAt: number;
  expiresAt: number;
}>();

function getSessionSigner(token: string): ethers.Wallet {
  const session = sessions.get(token);
  if (!session) {
    throw Object.assign(new Error('Session not found. Call /session/unlock first to get a token.'), { statusCode: 401 });
  }
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    throw Object.assign(new Error('Session expired. Call /session/unlock again.'), { statusCode: 401 });
  }
  return session.wallet;
}

function getSession(token: string) {
  const session = sessions.get(token);
  if (!session) {
    throw Object.assign(new Error('Session not found. Call /session/unlock first to get a token.'), { statusCode: 401 });
  }
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    throw Object.assign(new Error('Session expired. Call /session/unlock again.'), { statusCode: 401 });
  }
  return session;
}

function getSignerForChain(token: string, chain: string): ethers.Wallet {
  const wallet = getSessionSigner(token);
  return wallet.connect(getProvider(chain));
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mpc_wallets (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      email_verified BOOLEAN DEFAULT false,
      wallet_address TEXT,
      encrypted_shard TEXT NOT NULL,
      shard_count INTEGER DEFAULT 1,
      total_shards INTEGER DEFAULT 3,
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
})().catch(e => console.error('[MPC] Table init error:', e.message));

// ─── Health ───
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'pocketx-mpc', uptime: process.uptime() }));

// ─── Send verification code ───
app.post('/api/v2/mpc/send-code', asyncHandler(async (req: any, res: any) => {
  const { email } = req.body;
  if (!email) return res.status(400).json(apiResponse(null, 'email required', 1001));
  const code = '888888'; // dev fixed code — no email sending yet
  storeCode(email, code);
  console.log(`[MPC] Code for ${email}: ${code}`);
  res.json(apiResponse({ message: 'Code sent' }));
}));

// ─── Register ───
app.post('/api/v2/mpc/register', asyncHandler(async (req: any, res: any) => {
  const { email, code, walletAddress } = req.body;
  if (!email || !code) return res.status(400).json(apiResponse(null, 'email + code required', 1001));
  verifyCode(email, code);

  const emailLower = email.toLowerCase();
  const existing = await pool.query('SELECT id FROM mpc_wallets WHERE email = $1', [emailLower]);
  if (existing.rows.length > 0) {
    return res.status(400).json(apiResponse(null, 'Email already registered. Use /recover.', 1006));
  }

  const wallet = ethers.Wallet.createRandom();
  const encryptedShard = encryptShard(wallet.privateKey, emailLower);
  const connectedAddr = (req.headers['x-wallet-address'] as string) || walletAddress || null;

  const result = await pool.query(
    `INSERT INTO mpc_wallets (id, email, email_verified, wallet_address, encrypted_shard, shard_count, total_shards, connected_wallet_address)
     VALUES ($1, $2, true, $3, $4, 1, 1, $5) RETURNING id, email, wallet_address, created_at`,
    [crypto.randomUUID(), emailLower, wallet.address, encryptedShard, connectedAddr]
  );

  const row = result.rows[0];
  res.status(201).json(apiResponse({ id: row.id, email: row.email, walletAddress: row.wallet_address, createdAt: row.created_at }, 'MPC wallet created'));
}));

// ─── Recover ───
app.post('/api/v2/mpc/recover', asyncHandler(async (req: any, res: any) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json(apiResponse(null, 'email + code required', 1001));
  verifyCode(email, code);

  const emailLower = email.toLowerCase();
  const result = await pool.query(
    `SELECT id, email, wallet_address, encrypted_shard, recovery_count FROM mpc_wallets WHERE email = $1 AND status = 'active'`,
    [emailLower]
  );
  if (result.rows.length === 0) {
    return res.status(404).json(apiResponse(null, 'No MPC wallet found. Register first.', 1004));
  }

  const row = result.rows[0];
  let privateKey: string;
  try {
    privateKey = decryptShard(row.encrypted_shard, emailLower);
  } catch {
    return res.status(500).json(apiResponse(null, 'Failed to decrypt shard', 1007));
  }

  const recoveredWallet = new ethers.Wallet(privateKey);
  if (recoveredWallet.address.toLowerCase() !== row.wallet_address.toLowerCase()) {
    return res.status(500).json(apiResponse(null, 'Recovered key mismatch', 1008));
  }

  await pool.query(`UPDATE mpc_wallets SET recovered_at = NOW(), recovery_count = recovery_count + 1 WHERE id = $1`, [row.id]);

  res.json(apiResponse({
    email: row.email,
    walletAddress: row.wallet_address,
    recoveredAt: new Date().toISOString(),
    recoveryCount: row.recovery_count + 1,
  }, 'MPC wallet recovered'));
}));

// ─── Status ───
app.get('/api/v2/mpc/status', asyncHandler(async (req: any, res: any) => {
  const { email, walletAddress } = req.query;

  if (walletAddress && typeof walletAddress === 'string') {
    const addr = walletAddress.toLowerCase();
    const result = await pool.query(
      `SELECT id, email, wallet_address, email_verified, shard_count, total_shards, created_at, recovered_at, recovery_count, status
       FROM mpc_wallets WHERE LOWER(connected_wallet_address) = $1 OR LOWER(wallet_address) = $1`,
      [addr]
    );
    if (result.rows.length === 0) return res.json(apiResponse({ registered: false }));
    const r = result.rows[0];
    return res.json(apiResponse({ registered: true, email: r.email, walletAddress: r.wallet_address, emailVerified: r.email_verified, shardCount: r.shard_count, totalShards: r.total_shards, createdAt: r.created_at, lastRecoveredAt: r.recovered_at, recoveryCount: r.recovery_count, status: r.status }));
  }

  if (!email || typeof email !== 'string') {
    return res.status(400).json(apiResponse(null, 'walletAddress or email required', 1001));
  }

  const result = await pool.query(
    `SELECT id, email, wallet_address, email_verified, shard_count, total_shards, created_at, recovered_at, recovery_count, status
     FROM mpc_wallets WHERE email = $1`,
    [email.toLowerCase()]
  );
  if (result.rows.length === 0) return res.json(apiResponse({ registered: false }));
  const r = result.rows[0];
  res.json(apiResponse({ registered: true, email: r.email, walletAddress: r.wallet_address, emailVerified: r.email_verified, shardCount: r.shard_count, totalShards: r.total_shards, createdAt: r.created_at, lastRecoveredAt: r.recovered_at, recoveryCount: r.recovery_count, status: r.status }));
}));

// ─── Session Unlock ───
app.post('/api/v2/mpc/session/unlock', asyncHandler(async (req: any, res: any) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json(apiResponse(null, 'email + code required', 1001));
  verifyCode(email, code);

  const emailLower = email.toLowerCase();
  const result = await pool.query(
    `SELECT id, email, wallet_address, encrypted_shard FROM mpc_wallets WHERE email = $1 AND status = 'active'`,
    [emailLower]
  );
  if (result.rows.length === 0) {
    return res.status(404).json(apiResponse(null, 'No MPC wallet found. Register first.', 1004));
  }

  const row = result.rows[0];
  let privateKey: string;
  try {
    privateKey = decryptShard(row.encrypted_shard, emailLower);
  } catch {
    return res.status(500).json(apiResponse(null, 'Failed to decrypt shard', 1007));
  }

  const wallet = new ethers.Wallet(privateKey);
  if (wallet.address.toLowerCase() !== row.wallet_address.toLowerCase()) {
    return res.status(500).json(apiResponse(null, 'Recovered key mismatch', 1008));
  }

  const now = Date.now();
  const token = 'mpc_' + crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    wallet,
    address: wallet.address,
    email: emailLower,
    unlockedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });

  await pool.query(`UPDATE mpc_wallets SET recovered_at = NOW(), recovery_count = recovery_count + 1 WHERE id = $1`, [row.id]);

  res.json(apiResponse({
    token,
    address: wallet.address,
    unlockedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  }, 'MPC wallet unlocked. Use this token for all subsequent agent operations.'));
}));

// ─── Session Lock ───
app.post('/api/v2/mpc/session/lock', asyncHandler(async (req: any, res: any) => {
  const { token } = req.body;
  if (!token) return res.status(400).json(apiResponse(null, 'token required', 1001));
  const existed = sessions.has(token);
  sessions.delete(token);
  res.json(apiResponse({ locked: existed }, existed ? 'Session locked' : 'Session not found'));
}));

// ─── Session Status ───
app.get('/api/v2/mpc/session/status', asyncHandler(async (req: any, res: any) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') return res.status(400).json(apiResponse(null, 'token required', 1001));
  const session = sessions.get(token);
  if (!session) return res.json(apiResponse({ unlocked: false }));
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
  const signer = getSignerForChain(token, chain);
  const provider = getProvider(chain);

  const nativeBalance = await provider.getBalance(signer.address);
  const result: any = {
    address: signer.address,
    chain,
    nativeBalance: ethers.formatEther(nativeBalance),
    nativeSymbol: chain === 'bsc' ? 'BNB' : 'ETH',
  };

  if (tokenAddress && tokenAddress.startsWith('0x')) {
    try {
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const [balance, decimals, symbol] = await Promise.all([
        contract.balanceOf(signer.address),
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
  const signer = getSessionSigner(token);
  const signature = await signer.signMessage(message);
  await auditLog(token, 'sign_message', { message: message.slice(0, 100) });
  res.json(apiResponse({ signature, address: signer.address }, 'Message signed'));
}));

// ─── Sign Typed Data (EIP-712) ───
app.post('/api/v2/mpc/sign-typed-data', asyncHandler(async (req: any, res: any) => {
  const { token, domain, types, value } = req.body;
  if (!token || !domain || !types || !value) return res.status(400).json(apiResponse(null, 'token + domain + types + value required', 1001));
  const signer = getSessionSigner(token);
  const signature = await signer.signTypedData(domain, types, value);
  await auditLog(token, 'sign_typed_data', { domain: JSON.stringify(domain).slice(0, 200) });
  res.json(apiResponse({ signature, address: signer.address }, 'Typed data signed'));
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

  const signer = getSignerForChain(token, chain);
  let tx: ethers.TransactionResponse;

  if (tokenAddress && tokenAddress.startsWith('0x')) {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const decimals = Number(await contract.decimals());
    const parsedAmount = ethers.parseUnits(amount, decimals);
    tx = await contract.transfer(to, parsedAmount);
  } else {
    tx = await signer.sendTransaction({
      to,
      value: ethers.parseEther(amount),
    });
  }

  await auditLog(token, 'send_transaction', { to, amount, tokenAddress: tokenAddress || 'native' }, tx.hash, chain);

  const receipt = await tx.wait();
  res.json(apiResponse({
    txHash: tx.hash,
    from: signer.address,
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

  const signer = getSignerForChain(token, chain);
  const contract = new ethers.Contract(contractAddress, abi, signer);

  try {
    const staticContract = new ethers.Contract(contractAddress, abi, getProvider(chain));
    await staticContract[method].staticCall(...(args || []), value ? { value: ethers.parseEther(value) } : {});
  } catch (e: any) {
    return res.status(400).json(apiResponse(null, `Simulation failed: ${e.message}`, 1001));
  }

  const txOpts: any = {};
  if (value) txOpts.value = ethers.parseEther(value);
  if (gasLimit) txOpts.gasLimit = gasLimit;

  const tx = await contract[method](...(args || []), txOpts);
  await auditLog(token, 'contract_write', { contractAddress, method, args }, tx.hash, chain);

  const receipt = await tx.wait();
  res.json(apiResponse({
    txHash: tx.hash,
    from: signer.address,
    contractAddress,
    method,
    chain,
    blockNumber: receipt?.blockNumber,
    gasUsed: receipt?.gasUsed?.toString(),
  }, 'Contract call executed'));
}));

// ─── Gas Estimate ───
app.post('/api/v2/mpc/gas-estimate', asyncHandler(async (req: any, res: any) => {
  const { to, value, data, chain: chainParam } = req.body;
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

// ─── Start ───
const PORT = parseInt(process.env.PORT || '6003', 10);
app.listen(PORT, () => console.log(`MPC API running on port ${PORT}`));
