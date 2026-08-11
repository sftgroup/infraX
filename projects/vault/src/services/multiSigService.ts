import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import {
  createPublicClient, createWalletClient, http, getAddress,
  keccak256, encodePacked, encodeAbiParameters, parseAbiParameters,
  encodeFunctionData, getCreate2Address, parseEther,
  type Address, type Hex
} from 'viem';
import { mainnet, bsc, base, sepolia } from 'viem/chains';
import { getContractAddress } from 'viem/utils';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';
import { config } from '../config';
import { getHDMnemonic, getPrivateKey } from './hdWalletService';
// A-10: gas 自付计费（按实际 gas 结算，GAS_POOL 仅广播不垫付）
import { vaultChargeConfigured, estimateGasCostWei, chargeGas, settleGas, VaultChargeError } from './vaultBilling';

/** A-10: 计费 subscriber（ledger 通用字符串；钱包地址/用户 id 原样，默认 'vault'） */
function billingSubscriber(userId: string): string {
  return (userId || 'vault').toLowerCase();
}

/**
 * Multi-Sig Service (F-027~F-032)
 * Gnosis Safe-compatible multi-signature wallet management
 *
 * Uses Safe Proxy Factory pattern:
 * - SafeProxyFactory: creates Safe proxies via createProxyWithNonce
 * - Safe: the multi-sig wallet contract
 *
 * Safe v1.4.1 (deployed on all EVM chains, incl. Sepolia):
 * - Safe Singleton (L1): 0x41675C099F32341bf84BFc5382aF534df5C7461a
 * - SafeProxyFactory:    0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2
 */

// Standard Safe ABI fragments
const SAFE_PROXY_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createProxyWithNonce',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
] as const;

const SAFE_ABI = [
  {
    type: 'function',
    name: 'getOwners',
    inputs: [],
    outputs: [{ type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getThreshold',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'nonce',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTransactionHash',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
  },
] as const;

// Safe owner-management ABI (B-5: updateSafeOwners 走链上多签)
const SAFE_MANAGEMENT_ABI = [
  {
    type: 'function',
    name: 'addOwner',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: '_threshold', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'removeOwner',
    inputs: [
      { name: 'prevOwner', type: 'address' },
      { name: 'owner', type: 'address' },
      { name: '_threshold', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'swapOwner',
    inputs: [
      { name: 'prevOwner', type: 'address' },
      { name: 'oldOwner', type: 'address' },
      { name: 'newOwner', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'changeThreshold',
    inputs: [{ name: '_threshold', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

// Safe owner 链表哨兵地址
const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001' as Address;

/** 规范化 owner 列表（兼容 JSONB / PG text[] / JS array） */
export function parseOwners(owners: any): string[] {
  if (Array.isArray(owners)) return owners.map((o) => String(o).toLowerCase());
  if (typeof owners === 'string') {
    const t = owners.trim();
    if (t.startsWith('[')) {
      try { return (JSON.parse(t) as string[]).map((o) => String(o).toLowerCase()); } catch { /* fallthrough */ }
    }
    // PG text[] 格式：{addr1,addr2}
    return t
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, '').toLowerCase())
      .filter(Boolean);
  }
  return [];
}

export interface OwnerOp {
  type: 'addOwner' | 'removeOwner' | 'swapOwner' | 'changeThreshold';
  owner?: string;
  prevOwner?: string;
  newOwner?: string;
  threshold: number;
}

/**
 * 计算将 Safe 从 (oldOwners, oldThreshold) 变更为 (newOwners, newThreshold) 所需的操作序列。
 * Safe 的 owners 是链表：addOwner/removeOwner 需携带 prevOwner（链表前驱）与最终 threshold。
 * 顺序：先 add 新 owner（追加到链表尾），再 remove 旧 owner，最后（无增删时）changeThreshold。
 */
export function computeOwnerOps(
  oldOwners: string[],
  oldThreshold: number,
  newOwners: string[],
  newThreshold: number,
): OwnerOp[] {
  const norm = (o: string) => o.toLowerCase();
  const oldSet = new Set(oldOwners.map(norm));
  const newSet = new Set(newOwners.map(norm));

  const toAdd = newOwners.filter((o) => !oldSet.has(norm(o)));
  const toRemove = oldOwners.filter((o) => !newSet.has(norm(o)));

  const ops: OwnerOp[] = [];
  let current = oldOwners.map(norm);

  for (const o of toAdd) {
    const prev = current.length > 0 ? current[current.length - 1] : SENTINEL_OWNERS.toLowerCase();
    ops.push({ type: 'addOwner', owner: norm(o), prevOwner: prev, threshold: newThreshold });
    current.push(norm(o));
  }
  for (const o of toRemove) {
    const idx = current.indexOf(norm(o));
    const prev = idx > 0 ? current[idx - 1] : SENTINEL_OWNERS.toLowerCase();
    ops.push({ type: 'removeOwner', owner: norm(o), prevOwner: prev, threshold: newThreshold });
    current.splice(idx, 1);
  }
  if (ops.length === 0 && newThreshold !== oldThreshold) {
    ops.push({ type: 'changeThreshold', threshold: newThreshold });
  }
  return ops;
}

/** 编码单个 owner 管理操作为 Safe 调用 data */
export function encodeOwnerOp(op: OwnerOp): Hex {
  switch (op.type) {
    case 'addOwner':
      return encodeFunctionData({
        abi: SAFE_MANAGEMENT_ABI,
        functionName: 'addOwner',
        args: [getAddress(op.owner as string) as Address, BigInt(op.threshold)],
      });
    case 'removeOwner':
      return encodeFunctionData({
        abi: SAFE_MANAGEMENT_ABI,
        functionName: 'removeOwner',
        args: [getAddress(op.prevOwner as string) as Address, getAddress(op.owner as string) as Address, BigInt(op.threshold)],
      });
    case 'swapOwner':
      return encodeFunctionData({
        abi: SAFE_MANAGEMENT_ABI,
        functionName: 'swapOwner',
        args: [getAddress(op.prevOwner as string) as Address, getAddress(op.owner as string) as Address, getAddress(op.newOwner as string) as Address],
      });
    case 'changeThreshold':
      return encodeFunctionData({
        abi: SAFE_MANAGEMENT_ABI,
        functionName: 'changeThreshold',
        args: [BigInt(op.threshold)],
      });
    default:
      throw Errors.paramError(`Unknown owner op type`);
  }
}

// Chain configs (B-5 multi-chain: sepolia + eth + bsc + base)
// Sepolia 沿用生产历史值（0xfc7fa5/0x29fcb4），其余链用官方 Safe v1.4.1；
// 均支持 SAFE_PROXY_FACTORY_ADDRESS / SAFE_SINGLETON_ADDRESS env 覆盖（作用于全链）。
const CHAIN_CONFIG: Record<string, {
  chain: any;
  rpcUrl: string;
  safeSingleton: Address;
  safeProxyFactory: Address;
}> = {
  '11155111': {
    chain: sepolia,
    rpcUrl: config.chainRpc.sepolia,
    safeSingleton: (process.env.SAFE_SINGLETON_ADDRESS || '0x29fcb43b46531bc0030c8fc6d5e1d063e48a7bc7') as Address,
    safeProxyFactory: (process.env.SAFE_PROXY_FACTORY_ADDRESS || '0xfc7fa546b24477e8a2ce3a8d39869b122017ea2b') as Address,
  },
  '1': {
    chain: mainnet,
    rpcUrl: config.chainRpc.eth,
    safeSingleton: (process.env.SAFE_SINGLETON_ADDRESS || '0x41675C099F32341bf84BFc5382aF534df5C7461a') as Address,
    safeProxyFactory: (process.env.SAFE_PROXY_FACTORY_ADDRESS || '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2') as Address,
  },
  '56': {
    chain: bsc,
    rpcUrl: config.chainRpc.bsc,
    safeSingleton: (process.env.SAFE_SINGLETON_ADDRESS || '0x41675C099F32341bf84BFc5382aF534df5C7461a') as Address,
    safeProxyFactory: (process.env.SAFE_PROXY_FACTORY_ADDRESS || '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2') as Address,
  },
  '8453': {
    chain: base,
    rpcUrl: config.chainRpc.base,
    safeSingleton: (process.env.SAFE_SINGLETON_ADDRESS || '0x41675C099F32341bf84BFc5382aF534df5C7461a') as Address,
    safeProxyFactory: (process.env.SAFE_PROXY_FACTORY_ADDRESS || '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2') as Address,
  },
};

function getChainCfg(chainId: string) {
  const cfg = CHAIN_CONFIG[chainId];
  if (!cfg) throw Errors.paramError(`Chain ${chainId} not supported for Multi-Sig`);
  return cfg;
}

/** Get a wallet client for the deployer (Gas Pool) account */
function getDeployerSigner(chainId: string) {
  const cfg = getChainCfg(chainId);
  const pk = config.gasPool.privateKey || process.env.GAS_POOL_PRIVATE_KEY || '';
  if (!pk) throw Errors.internal('GAS_POOL_PRIVATE_KEY not configured');
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  return new ethers.Wallet(pk, provider);
}

function getPublicClient(chainId: string) {
  const cfg = getChainCfg(chainId);
  return createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
  });
}

/**
 * Encode Safe setup data for initializer
 * setup(owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver)
 */
function encodeSafeSetup(
  owners: Address[],
  threshold: number,
): Hex {
  
  return encodeFunctionData({
    abi: [{
      type: 'function',
      name: 'setup',
      inputs: [
        { name: '_owners', type: 'address[]' },
        { name: '_threshold', type: 'uint256' },
        { name: 'to', type: 'address' },
        { name: 'data', type: 'bytes' },
        { name: 'fallbackHandler', type: 'address' },
        { name: 'paymentToken', type: 'address' },
        { name: 'payment', type: 'uint256' },
        { name: 'paymentReceiver', type: 'address' },
      ],
      outputs: [],
    }],
    functionName: 'setup',
    args: [
      owners,
      BigInt(threshold),
      '0x0000000000000000000000000000000000000000' as Address,
      '0x' as Hex,
      '0x0000000000000000000000000000000000000000' as Address,
      '0x0000000000000000000000000000000000000000' as Address,
      0n,
      '0x0000000000000000000000000000000000000000' as Address,
    ],
  });
}

/**
 * Calculate deterministic Safe address (CREATE2)
 * Uses the same formula as Safe's Ethers.js SDK:
 * proxyAddress = create2(proxyFactory, saltNonce, deploymentCode)
 */
async function predictSafeAddress(
  chainId: string,
  owners: Address[],
  threshold: number,
  saltNonce: bigint,
): Promise<Address> {
  const cfg = getChainCfg(chainId);
  

  // Standard Safe Proxy creation code (deployed on chain)
  // This bytecode deploys a minimal proxy pointing to the Safe singleton
  const proxyCreationCode = '0x608060405234801561001057600080fd5b506040516101e63803806101e683398101604081905261002f91610038565b6001600160a01b0316608052610068565b60006020828403121561004a57600080fd5b81516001600160a01b038116811461006157600080fd5b9392505050565b6080516101646100826000396000603e01526101646000f3fe608060405234801561001057600080fd5b506004361061002b5760003560e01c80635c60da1b14610030575b600080fd5b6100577f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b03909116815260200160405180910390f35b60b17f3d602d80600a3d3981f3363d3d373d3d3d363d7300000000000000000000000081527f5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000606090811b919091176014526000906074906020906073903880600e565b6039600e81fd5b50600080526020600020905090565b81801592909304919091015250565b50600090607d9060209060a1565b919050565b6000602082840312156100bf57600080fd5b81516001600160a01b03811681146100d657600080fd5b939250505056fea2646970667358221220c2b0b43b04d3f94a14c34dac010e96ba74b58f6e4d97bf339c6cf2b55fe1cd3164736f6c634300081a0033' as Hex;

  // Compute CREATE2 salt: keccak256(keccak256(initializer) | saltNonce)
  const initializer = encodeSafeSetup(owners, threshold);
  const initializerHash = keccak256(
    encodePacked(['bytes', 'uint256'], [initializer, saltNonce])
  );
  
  const salt = keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, uint256'),
      [initializerHash, saltNonce]
    )
  );

  // Encode constructor argument (singleton address) for proxy creation
  const initCode = encodePacked(
    ['bytes', 'bytes'],
    [
      proxyCreationCode,
      encodeAbiParameters(parseAbiParameters('address'), [cfg.safeSingleton]),
    ]
  );

  return getCreate2Address({
    from: cfg.safeProxyFactory,
    salt,
    bytecode: initCode,
  }) as Address;
}

// ── Safe CRUD ──

export async function createSafe(params: {
  userId: string;
  chainId: string;
  owners: string[];
  threshold: number;
  name?: string;
}): Promise<{
  safeAddress: string;
  chainId: string;
  owners: string[];
  threshold: number;
  status: string;
}> {
  const { userId, chainId, owners, threshold, name } = params;

  if (!owners || owners.length === 0) throw Errors.paramError('At least one owner required');
  if (threshold < 1 || threshold > owners.length) {
    throw Errors.paramError(`Threshold must be between 1 and ${owners.length}`);
  }

  const cfg = getChainCfg(chainId);
  const ownerAddrs = owners.map(o => getAddress(o) as Address);

  // Deterministic salt from userId + timestamp
  const saltNonce = BigInt(`0x${uuidv4().replace(/-/g, '').slice(0, 16)}`);

  // Predict Safe address
  const predictedAddress = await predictSafeAddress(chainId, ownerAddrs, threshold, saltNonce);

  // Check if safe already exists for this user
  const existing = await pool.query(
    'SELECT id FROM safe_wallets WHERE user_id = $1 AND chain_id = $2 AND safe_address = $3',
    [userId, chainId, predictedAddress]
  );

  if (existing.rows.length > 0) {
    return {
      safeAddress: predictedAddress,
      chainId,
      owners,
      threshold,
      status: 'active',
    };
  }

  // Deploy Safe proxy on-chain via SafeProxyFactory.createProxyWithNonce
  const safeId = uuidv4();
  let actualAddress = predictedAddress;
  let status = 'pending';

  try {
    const signer = getDeployerSigner(chainId);
    const initializer = encodeSafeSetup(ownerAddrs, threshold);

    const factory = new ethers.Contract(
      cfg.safeProxyFactory as string,
      SAFE_PROXY_FACTORY_ABI,
      signer
    );

    // A-10: gas 自付——部署前按预估成本预扣（含 5% 缓冲），GAS_POOL 仅广播不垫付
    let chargeWei = 0n;
    if (vaultChargeConfigured()) {
      const txReq = await factory.createProxyWithNonce.populateTransaction(cfg.safeSingleton, initializer, saltNonce);
      const estimated = await estimateGasCostWei(signer.provider as ethers.JsonRpcProvider, txReq);
      chargeWei = (estimated * 105n) / 100n;
      await chargeGas(billingSubscriber(userId), `vault:create:${safeId}`, chargeWei);
    }

    const tx = await factory.createProxyWithNonce(
      cfg.safeSingleton, initializer, saltNonce,
      { gasLimit: 500000 }
    );
    const receipt = await tx.wait();
    const txHash = receipt.hash as Address;

    // A-10: 收据后按实际 gas 结算退差（多退少补）；结算失败仅告警，不阻塞创建
    if (chargeWei > 0n) {
      try {
        const actualWei = receipt.gasUsed * receipt.gasPrice;
        await settleGas(billingSubscriber(userId), `vault:create:${safeId}`, chargeWei, actualWei);
      } catch (bErr: any) {
        logger.warn('Safe create gas settle failed', { safeId, error: bErr.message });
      }
    }

    // Parse ProxyCreation event from ethers receipt
    const iface = new ethers.Interface([
      'event ProxyCreation(address indexed proxy, address singleton)',
    ]);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed && parsed.args && parsed.args.proxy) {
          actualAddress = parsed.args.proxy;
          break;
        }
      } catch (_) {}
    }

    status = 'active';
    logger.info('Safe proxy deployed', { safeId, safeAddress: actualAddress, txHash, owners, threshold });
  } catch (err: any) {
    // A-10: 计费失败（402 余额不足 / 503 引擎故障）直接抛，不落入 pending
    if (err instanceof VaultChargeError) throw err;
    logger.warn('Safe chain deployment failed, storing pending', {
      safeId, predictedAddress, error: err.message,
    });
    // Fall through — store as pending, can retry later
  }

  // Format owners array for PostgreSQL text[]: {"addr1","addr2",...}
  var pgOwners = '{' + owners.map(function(o) { return '"' + o + '"'; }).join(',') + '}';
  await pool.query(
    `INSERT INTO safe_wallets (id, user_id, chain_id, safe_address, owners, threshold, name, status, salt_nonce)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [safeId, userId, chainId, actualAddress, pgOwners, threshold, name || null, status, saltNonce.toString()]
  );

  // 同步写 safe_owners（B-5）
  for (const owner of owners) {
    await pool.query(
      `INSERT INTO safe_owners (id, safe_address, owner_address)
       VALUES ($1, LOWER($2), LOWER($3)) ON CONFLICT (safe_address, owner_address) DO NOTHING`,
      [uuidv4(), actualAddress, owner]
    );
  }

  return {
    safeAddress: actualAddress,
    chainId,
    owners,
    threshold,
    status,
  };
}

export async function getSafe(safeAddress: string): Promise<any> {
  const result = await pool.query(
    'SELECT * FROM safe_wallets WHERE safe_address = $1',
    [safeAddress]
  );
  if (result.rows.length === 0) throw Errors.notFound('Safe wallet');
  return result.rows[0];
}

export async function listSafes(userId?: string): Promise<any[]> {
  const result = userId && /^[0-9a-f]{8}-/.test(userId)
    ? await pool.query('SELECT * FROM safe_wallets WHERE user_id = $1 ORDER BY created_at DESC', [userId])
    : await pool.query('SELECT * FROM safe_wallets ORDER BY created_at DESC');
  return result.rows;
}

// ── Safe Transactions ──

export async function proposeTransaction(params: {
  userId: string;
  safeAddress: string;
  to: string;
  value: string;
  data?: string;
}): Promise<{ txId: string; safeTxHash: string; nonce: number }> {
  const { userId, safeAddress, to, value, data } = params;

  if (!safeAddress || !to) throw Errors.paramError('Missing safeAddress or to');

  const safe = await getSafe(safeAddress);
  const chainId = safe.chain_id;

  // Get current nonce — Safe 交易 nonce 以链上为准（B-5），RPC 不可达时 fallback DB
  let nonce: number;
  try {
    const cfg = getChainCfg(chainId);
    const publicClient = getPublicClient(chainId);
    const onchainNonce = await publicClient.readContract({
      address: safeAddress as Address,
      abi: SAFE_ABI,
      functionName: 'nonce',
    });
    nonce = Number(onchainNonce);
  } catch {
    const nonceSig = await pool.query(
      "SELECT COALESCE(MAX(nonce), 0) + 1 as next_nonce FROM safe_transactions WHERE safe_address = $1",
      [safeAddress]
    );
    nonce = nonceSig.rows[0].next_nonce || 0;
  }

  // Compute Safe tx hash
  const safeTxHash = computeSafeTxHash(safeAddress, to, value, data || '0x', nonce, chainId);

  // Idempotency: return existing if same hash already proposed
  const existing = await pool.query(
    "SELECT id, safe_tx_hash, nonce FROM safe_transactions WHERE safe_tx_hash = $1",
    [safeTxHash]
  );
  if (existing.rows.length > 0) {
    return { txId: existing.rows[0].id, safeTxHash, nonce: existing.rows[0].nonce };
  }

  const txId = uuidv4();
  await pool.query(
    `INSERT INTO safe_transactions (id, safe_address, proposer_id, to_address, value, data, nonce, safe_tx_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
    [txId, safeAddress, userId, to, value, data || '0x', nonce, safeTxHash]
  );

  logger.info('Safe tx proposed', { txId, safeAddress, safeTxHash, nonce });

  return { txId, safeTxHash, nonce };
}

export async function confirmTransaction(params: {
  userId: string;
  safeAddress: string;
  safeTxHash: string;
  signature: string; // EIP-712 signature or EOA sig
}): Promise<{ confirmed: boolean; sigCount: number; threshold: number }> {
  const { userId, safeAddress, safeTxHash, signature } = params;

  const tx = await pool.query(
    "SELECT * FROM safe_transactions WHERE safe_tx_hash = $1 AND status = 'pending'",
    [safeTxHash]
  );
  if (tx.rows.length === 0) throw Errors.notFound('Transaction');

  // Check for duplicate signature
  const existingSig = await pool.query(
    'SELECT id FROM safe_signatures WHERE safe_tx_hash = $1 AND signer_id = $2',
    [safeTxHash, userId]
  );

  if (existingSig.rows.length > 0) {
    // Already signed — return current state
    const count = await pool.query(
      'SELECT COUNT(*)::int as cnt FROM safe_signatures WHERE safe_tx_hash = $1',
      [safeTxHash]
    );
    const safe = await getSafe(safeAddress);
    return { confirmed: true, sigCount: count.rows[0].cnt, threshold: safe.threshold };
  }

  // Verify signature is a valid EOA signature (recover signer from EIP-712 or eth_sign)
  // The signature should be a hex-encoded 65-byte (r,s,v) ECDSA signature
  let signerAddress = '';
  try {
    signerAddress = ethers.verifyMessage(
      ethers.toUtf8Bytes(safeTxHash), // Use safeTxHash as the signed message
      signature
    );
    // Verify the recovered signer matches a safe owner
    const ownerResult = await pool.query(
      'SELECT owner_address FROM safe_owners WHERE safe_address = $1 AND owner_address = $2',
      [safeAddress.toLowerCase(), signerAddress.toLowerCase()]
    );
    if (ownerResult.rows.length === 0) {
      throw new Error(`Signer ${signerAddress} is not an owner of safe ${safeAddress}`);
    }
  } catch (sigErr: any) {
    if (sigErr.message?.includes('not an owner')) {
      throw Errors.forbidden(sigErr.message);
    }
    throw Errors.paramError(`Invalid signature: ${sigErr.message}`);
  }

  // Store signature (A-8: 记录签名者 owner 地址，executeTransaction 直接据此打包，不再依赖 wallets 表)
  await pool.query(
    `INSERT INTO safe_signatures (id, safe_tx_hash, signer_id, signature, signature_type, owner_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv4(), safeTxHash, userId, signature, 'eoa', signerAddress.toLowerCase()]
  );

  // Check if threshold met
  const count = await pool.query(
    'SELECT COUNT(*)::int as cnt FROM safe_signatures WHERE safe_tx_hash = $1',
    [safeTxHash]
  );
  const safe = await getSafe(safeAddress);
  const sigCount = count.rows[0].cnt;

  if (sigCount >= safe.threshold) {
    await pool.query(
      "UPDATE safe_transactions SET status = 'ready' WHERE safe_tx_hash = $1",
      [safeTxHash]
    );
    logger.info('Safe tx ready for execution — auto-executing', { safeTxHash, sigCount, threshold: safe.threshold });

    // ── Auto-execute when threshold is met ──
    try {
      await executeTransaction({ userId: userId, safeTxHash });
    } catch (execErr: any) {
      logger.warn('Auto-execute after confirm failed (will retry on manual execute)', {
        safeTxHash, error: execErr.message,
      });
    }
  }

  return { confirmed: true, sigCount, threshold: safe.threshold };
}

/**
 * A-8 (W-4.1): MPC 会话代签 confirm——用户以 MPC 邮箱会话 token 代替 EOA 签名。
 *
 * 流程：vault 调 MPC `POST /api/v2/mpc/sign-message`（EIP-191 personal_sign，message = safeTxHash 十六进制串）
 *  → 返回 { signature, address }；恢复地址须是 Safe owner（MPC 派生地址在 createSafe 时登记为 owner）；
 *  → 签名落库 signature_type='mpc' + owner_address；MPC 地址登记进 wallets 表；
 *  → threshold 达标自动 execute（与 EOA confirm 同路径）。
 * 契约（MPC server.ts L856-871）：sign-message 内部 ethers.hashMessage(message) → 与 vault
 *  verifyMessage(toUtf8Bytes(safeTxHash)) 一致（message 传 safeTxHash 原文即可）。
 */
export async function confirmWithMpc(params: {
  userId: string;
  safeAddress: string;
  safeTxHash: string;
  mpcToken: string;
}): Promise<{ confirmed: boolean; sigCount: number; threshold: number; signerAddress: string }> {
  const { userId, safeAddress, safeTxHash, mpcToken } = params;

  if (!config.mpc.baseUrl) {
    throw Errors.internal('MPC_URL is not configured — MPC confirm unavailable');
  }
  if (!mpcToken) throw Errors.paramError('mpcToken (MPC session token) required');

  const tx = await pool.query(
    "SELECT * FROM safe_transactions WHERE safe_tx_hash = $1 AND status = 'pending'",
    [safeTxHash]
  );
  if (tx.rows.length === 0) throw Errors.notFound('Transaction');

  // 调用 MPC sign-message（EIP-191 personal_sign，message = safeTxHash 原文）
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.mpc.apiKey) headers['X-API-Key'] = config.mpc.apiKey;
  let mpcResp: Response;
  try {
    mpcResp = await fetch(`${config.mpc.baseUrl.replace(/\/+$/, '')}/api/v2/mpc/sign-message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: mpcToken, message: safeTxHash }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw Errors.internal(`MPC sign-message call failed: ${err.message}`);
  }
  if (!mpcResp.ok) {
    let detail = `MPC sign-message failed (${mpcResp.status})`;
    try {
      const body = (await mpcResp.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch { /* non-JSON */ }
    throw Errors.internal(detail);
  }
  const mpcBody = (await mpcResp.json()) as { data?: { signature?: string; address?: string } };
  const signature = mpcBody?.data?.signature;
  const signerAddress = mpcBody?.data?.address;
  if (!signature || !signerAddress) throw Errors.internal('MPC sign-message returned no signature');

  // 恢复地址必须是 Safe owner（MPC 派生地址作为 owner 的登记路径：createSafe owners 传入）
  const ownerResult = await pool.query(
    'SELECT owner_address FROM safe_owners WHERE safe_address = $1 AND owner_address = $2',
    [safeAddress.toLowerCase(), signerAddress.toLowerCase()]
  );
  if (ownerResult.rows.length === 0) {
    throw Errors.forbidden(`MPC address ${signerAddress} is not an owner of safe ${safeAddress}`);
  }

  // 重复签名幂等
  const existingSig = await pool.query(
    'SELECT id FROM safe_signatures WHERE safe_tx_hash = $1 AND signer_id = $2',
    [safeTxHash, userId]
  );
  if (existingSig.rows.length === 0) {
    await pool.query(
      `INSERT INTO safe_signatures (id, safe_tx_hash, signer_id, signature, signature_type, owner_address)
       VALUES ($1, $2, $3, $4, 'mpc', $5)`,
      [uuidv4(), safeTxHash, userId, signature, signerAddress.toLowerCase()]
    );
    // A-8: MPC 地址登记进 wallets 表（供既有工具/查询使用；execute 已不依赖该表）
    await pool.query(
      `INSERT INTO wallets (id, user_id, address, chain)
       VALUES ($1, $2, LOWER($3), 'evm') ON CONFLICT (user_id, address) DO NOTHING`,
      [uuidv4(), userId, signerAddress]
    ).catch(() => {});
  }

  // threshold 达标 → ready + 自动执行（与 EOA confirm 同路径）
  const count = await pool.query(
    'SELECT COUNT(*)::int as cnt FROM safe_signatures WHERE safe_tx_hash = $1',
    [safeTxHash]
  );
  const safe = await getSafe(safeAddress);
  const sigCount = count.rows[0].cnt;
  if (sigCount >= safe.threshold) {
    await pool.query(
      "UPDATE safe_transactions SET status = 'ready' WHERE safe_tx_hash = $1",
      [safeTxHash]
    );
    logger.info('Safe tx ready (MPC confirm) — auto-executing', { safeTxHash, sigCount, threshold: safe.threshold });
    try {
      await executeTransaction({ userId, safeTxHash });
    } catch (execErr: any) {
      logger.warn('Auto-execute after MPC confirm failed (will retry on manual execute)', {
        safeTxHash, error: execErr.message,
      });
    }
  }

  return { confirmed: true, sigCount, threshold: safe.threshold, signerAddress };
}

export async function executeTransaction(params: {
  userId: string;
  safeTxHash: string;
}): Promise<{ txHash: string | null; status: string }> {
  const { userId, safeTxHash } = params;

  const tx = await pool.query(
    "SELECT * FROM safe_transactions WHERE safe_tx_hash = $1 AND status = 'ready'",
    [safeTxHash]
  );
  if (tx.rows.length === 0) throw Errors.paramError('Transaction not ready — threshold not met');

  const safe = await getSafe(tx.rows[0].safe_address);

  // Get all signatures
  const sigs = await pool.query(
    'SELECT * FROM safe_signatures WHERE safe_tx_hash = $1 ORDER BY created_at',
    [safeTxHash]
  );

  // Build packed signatures matching signer_id (userId) to owner addresses.
  const userIds = sigs.rows.map((s: any) => s.signer_id);
  const walletMap: Record<string, string> = {};
  if (userIds.length > 0) {
    try {
      const walletResult = await pool.query(
        'SELECT user_id, address FROM wallets WHERE user_id = ANY($1)',
        [userIds]
      );
      for (const w of walletResult.rows) {
        walletMap[w.user_id] = w.address.toLowerCase();
      }
    } catch (err: any) {
      // 老库可能无 wallets 表或类型不匹配——owner_address 主路径不受影响，仅回退链路失效
      logger.warn('wallets table lookup skipped (fallback unavailable)', { error: err.message });
    }
  }

  // A-8 加固：优先按 safe_signatures.owner_address（confirm 时记录）关联 owner；
  // 老数据（无 owner_address）回退 wallets 表 user_id→address 映射。
  const sigsWithOwner = sigs.rows.map((s: any) => {
    let ownerAddr = (s.owner_address || '').toLowerCase();
    if (!ownerAddr) {
      const walletRow = walletMap[s.signer_id];
      if (walletRow) ownerAddr = walletRow.toLowerCase();
    }
    return { ...s, ownerAddress: ownerAddr };
  });

  const ownerSigs = safe.owners.map((owner: string) => {
    // Find signature by matching owner address against signer owner addresses
    const sig = sigsWithOwner.find((s: any) => s.ownerAddress && s.ownerAddress === owner.toLowerCase());
    return sig ? sig.signature : '0x';
  }).filter((s: string) => s !== '0x');

  const packedSigs = ownerSigs.join('').replace(/0x/g, '');

  // Execute via Safe proxy on-chain
  const cfg = getChainCfg(safe.chain_id);
  const txRow = tx.rows[0];
  let chainTxHash: string | null = null;

  // A-10: gas 自付——广播前按预估成本预扣（含 5% 缓冲）；GAS_POOL 仅广播不垫付。
  // 计费失败（402 余额不足 / 503 引擎故障）在此抛出，交易尚未广播，不标 failed。
  const signer = getDeployerSigner(safe.chain_id);
  const signatures = '0x' + packedSigs;
  const safeContract = new ethers.Contract(
    safe.safe_address,
    [
      'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) public returns (bool)'
    ],
    signer
  );
  const execArgs = [
    txRow.to_address,
    ethers.parseEther(txRow.value || '0'),
    txRow.data || '0x',
    0, // Call
    0, 0, 0,
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000',
    signatures,
  ];
  let chargeWei = 0n;
  if (vaultChargeConfigured()) {
    const txReq = await safeContract.execTransaction.populateTransaction(...execArgs, { gasLimit: 500000 });
    const estimated = await estimateGasCostWei(signer.provider as ethers.JsonRpcProvider, txReq);
    chargeWei = (estimated * 105n) / 100n;
    await chargeGas(billingSubscriber(userId), `vault:execute:${safeTxHash}`, chargeWei);
  }

  try {
    const tx = await safeContract.execTransaction(...execArgs, { gasLimit: 500000 });
    const execReceipt = await tx.wait();
    chainTxHash = execReceipt.hash;

    // A-10: 收据后按实际 gas 结算退差（多退少补）；结算失败仅告警，不阻塞执行
    if (chargeWei > 0n) {
      try {
        const actualWei = execReceipt.gasUsed * execReceipt.gasPrice;
        await settleGas(billingSubscriber(userId), `vault:execute:${safeTxHash}`, chargeWei, actualWei);
      } catch (bErr: any) {
        logger.warn('Safe tx gas settle failed', { safeTxHash, error: bErr.message });
      }
    }

    logger.info('Safe tx executed on-chain', {
      safeTxHash, chainTxHash, sigCount: sigs.rows.length,
    });
  } catch (err: any) {
    logger.error('Safe tx chain execution failed', {
      safeTxHash, error: err.message,
    });
    // Do NOT mark as executed on failure
    await pool.query(
      `UPDATE safe_transactions SET status = 'failed', executor_id = $1, error_message = $3 WHERE safe_tx_hash = $2`,
      [userId, safeTxHash, err.message || 'Unknown error']
    );
    throw err;
  }

  if (!chainTxHash) {
    throw Errors.internal('Safe tx execution produced no tx hash');
  }

  await pool.query(
    `UPDATE safe_transactions SET status = 'executed', executor_id = $1, executed_at = NOW(), tx_hash = $3 WHERE safe_tx_hash = $2`,
    [userId, safeTxHash, chainTxHash]
  );

  // B-5: 链上状态已变（如 owner 管理交易）→ 回读并同步 safe_wallets + safe_owners
  try {
    await syncSafeState(safe.safe_address);
  } catch (err: any) {
    logger.warn('Post-execute safe state sync failed', { safeAddress: safe.safe_address, error: err.message });
  }

  return { txHash: chainTxHash, status: 'executed' };
}

export async function getSafeTransactions(safeAddress: string): Promise<any[]> {
  const result = await pool.query(
    `SELECT t.*, COALESCE(s.sig_count, 0)::int as sig_count
     FROM safe_transactions t
     LEFT JOIN (
       SELECT safe_tx_hash, COUNT(*) as sig_count FROM safe_signatures GROUP BY safe_tx_hash
     ) s ON t.safe_tx_hash = s.safe_tx_hash
     WHERE t.safe_address = $1
     ORDER BY t.nonce DESC`,
    [safeAddress]
  );
  return result.rows;
}

// ── Owner Management ──

/**
 * B-5: updateSafeOwners 走链上多签。
 * 不再直接改 DB owners —— 生成 Safe owner 管理交易（addOwner/removeOwner/changeThreshold）
 * 并 propose 为 safe_transactions，由 owner 们 confirm（threshold 达标后 auto-execute）。
 * 链上执行成功后再由 executeTransaction → syncSafeState 回写 safe_wallets + safe_owners。
 * 可选 signature：调用者若提供 EOA 签名，则自动 confirm（发起人即为 owner 之一）。
 */
export async function updateSafeOwners(params: {
  userId: string;
  safeAddress: string;
  newOwners: string[];
  newThreshold: number;
  signature?: string;
}): Promise<{
  safeTxHashes: string[];
  txIds: string[];
  operations: OwnerOp[];
  pendingConfirm: number;
}> {
  const { userId, safeAddress, newOwners, newThreshold, signature } = params;

  if (!Array.isArray(newOwners) || newOwners.length === 0) {
    throw Errors.paramError('Missing required fields: owners');
  }
  if (typeof newThreshold !== 'number' || newThreshold < 1 || newThreshold > newOwners.length) {
    throw Errors.paramError(`Threshold must be 1-${newOwners.length}`);
  }

  const safe = await getSafe(safeAddress);
  const chainId = safe.chain_id;
  const oldOwners = parseOwners(safe.owners);
  const oldThreshold = Number(safe.threshold || 1);

  // 无变更 → 直接返回
  const normOld = oldOwners.map((o) => o.toLowerCase()).sort();
  const normNew = newOwners.map((o) => o.toLowerCase()).sort();
  const unchanged =
    normOld.length === normNew.length &&
    normOld.every((o, i) => o === normNew[i]) &&
    oldThreshold === newThreshold;
  if (unchanged) {
    return { safeTxHashes: [], txIds: [], operations: [], pendingConfirm: 0 };
  }

  // 计算操作序列并逐个 propose（链上 nonce 递增）
  const ops = computeOwnerOps(oldOwners, oldThreshold, newOwners, newThreshold);
  const safeTxHashes: string[] = [];
  const txIds: string[] = [];

  let nonce: number;
  try {
    const cfg = getChainCfg(chainId);
    const publicClient = getPublicClient(chainId);
    const onchainNonce = await publicClient.readContract({
      address: safeAddress as Address,
      abi: SAFE_ABI,
      functionName: 'nonce',
    });
    nonce = Number(onchainNonce);
  } catch {
    const nonceSig = await pool.query(
      "SELECT COALESCE(MAX(nonce), 0) + 1 as next_nonce FROM safe_transactions WHERE safe_address = $1",
      [safeAddress]
    );
    nonce = nonceSig.rows[0].next_nonce || 0;
  }

  for (const op of ops) {
    const data = encodeOwnerOp(op);
    const safeTxHash = computeSafeTxHash(safeAddress, safeAddress, '0', data, nonce, chainId);
    const txId = uuidv4();
    await pool.query(
      `INSERT INTO safe_transactions (id, safe_address, proposer_id, to_address, value, data, nonce, safe_tx_hash, status)
       VALUES ($1, $2, $3, $4, '0', $5, $6, $7, 'pending')`,
      [txId, safeAddress, userId, safeAddress, data, nonce, safeTxHash]
    );
    txIds.push(txId);
    safeTxHashes.push(safeTxHash);
    nonce += 1;
  }

  // 提供 signature 则自动 confirm（多签推进），失败不影响 propose 结果
  let pendingConfirm = ops.length;
  if (signature) {
    for (const h of safeTxHashes) {
      try {
        await confirmTransaction({ userId, safeAddress, safeTxHash: h, signature });
        pendingConfirm -= 1;
      } catch (err: any) {
        logger.warn('Owner-update auto-confirm failed', { safeTxHash: h, error: err.message });
      }
    }
  }

  logger.info('Safe owners update proposed on-chain', {
    safeAddress, chainId, ops: ops.map((o) => o.type), safeTxHashes,
  });

  return { safeTxHashes, txIds, operations: ops, pendingConfirm };
}

// ── Retry / Repair ──

/**
 * Retry deployment of pending Safe wallets (called via cron or admin trigger)
 */
export async function retryPendingSafes(chainId?: string): Promise<{ retried: number; deployed: number; failed: number }> {
  const where = chainId ? 'AND chain_id = $1' : '';
  const values = chainId ? [chainId] : [];

  const result = await pool.query(
    `SELECT * FROM safe_wallets WHERE status = 'pending' ${where} ORDER BY created_at`,
    values
  );

  let deployed = 0;
  let failed = 0;

  const TIMEOUT_MS = 30_000; // per-safe timeout to avoid hanging
  for (const safe of result.rows) {
    try {
      const cfg = getChainCfg(safe.chain_id);
      const ownerAddrs = (typeof safe.owners === 'string' ? JSON.parse(safe.owners) : safe.owners).map((o: string) => getAddress(o) as Address);
      const saltNonce = BigInt(safe.salt_nonce || '0x' + uuidv4().replace(/-/g, '').slice(0, 16));
      const initializer = encodeSafeSetup(ownerAddrs, safe.threshold);

      const signer = getDeployerSigner(safe.chain_id);
      const factory = new ethers.Contract(
        cfg.safeProxyFactory as string,
        SAFE_PROXY_FACTORY_ABI,
        signer
      );

      // Wrap in timeout to avoid hanging on RPC
      const deployWithTimeout = Promise.race([
        (async () => {
          const tx = await factory.createProxyWithNonce(
            cfg.safeSingleton, initializer, saltNonce,
            { gasLimit: 500000 }
          );
          const receipt = await tx.wait();
          return receipt;
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Retry timeout: RPC stall')), TIMEOUT_MS)
        ),
      ]);
      const receipt = await deployWithTimeout;

      // Parse ProxyCreation event
      const iface = new ethers.Interface([
        'event ProxyCreation(address indexed proxy, address singleton)',
      ]);
      let actualAddress = safe.safe_address;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed && parsed.args && parsed.args.proxy) {
            actualAddress = parsed.args.proxy;
            break;
          }
        } catch (_) {}
      }

      await pool.query(
        `UPDATE safe_wallets SET status = 'active', safe_address = COALESCE(NULLIF($2, safe_address), safe_address), updated_at = NOW() WHERE id = $1`,
        [safe.id, actualAddress !== safe.safe_address ? actualAddress : null]
      );

      deployed++;
      logger.info('Safe retry deployed', { id: safe.id, address: actualAddress, txHash: receipt.hash });
    } catch (err: any) {
      failed++;
      logger.warn('Safe retry failed', { id: safe.id, error: err.message });
    }
  }

  return { retried: result.rows.length, deployed, failed };
}

/**
 * Execute all ready transactions for a Safe's nonce
 * (Handles edge case where multiple txs at same nonce become ready)
 */
export async function executeReadyTransactions(safeAddress?: string): Promise<{ executed: number; failed: number }> {
  const where = safeAddress ? 'AND t.safe_address = $1' : '';
  const values = safeAddress ? [safeAddress] : [];

  const result = await pool.query(
    `SELECT t.* FROM safe_transactions t WHERE t.status = 'ready' ${where} ORDER BY t.nonce ASC`,
    values
  );

  let executed = 0;
  let failed = 0;

  for (const tx of result.rows) {
    try {
      await executeTransaction({ userId: tx.proposer_id, safeTxHash: tx.safe_tx_hash });
      executed++;
    } catch (err: any) {
      failed++;
      logger.warn('Auto-execute failed', { safeTxHash: tx.safe_tx_hash, error: err.message });
    }
  }

  return { executed, failed };
}

/**
 * Sync Safe on-chain owners/threshold to DB
 */
export async function syncSafeState(safeAddress: string): Promise<{ owners: string[]; threshold: number; nonce: number }> {
  const safe = await getSafe(safeAddress);
  const cfg = getChainCfg(safe.chain_id);
  const publicClient = getPublicClient(safe.chain_id);

  const [owners, threshold, onchainNonce] = await Promise.all([
    publicClient.readContract({
      address: safeAddress as Address,
      abi: SAFE_ABI,
      functionName: 'getOwners',
    }) as Promise<Address[]>,
    publicClient.readContract({
      address: safeAddress as Address,
      abi: SAFE_ABI,
      functionName: 'getThreshold',
    }) as Promise<bigint>,
    publicClient.readContract({
      address: safeAddress as Address,
      abi: SAFE_ABI,
      functionName: 'nonce',
    }) as Promise<bigint>,
  ]);

  const ownerStrings = (owners as unknown as string[]).map(o => o.toLowerCase());
  const thresholdNum = Number(threshold);
  const nonceNum = Number(onchainNonce);

  await pool.query(
    `UPDATE safe_wallets SET owners = $1, threshold = $2, updated_at = NOW() WHERE safe_address = $3`,
    [JSON.stringify(ownerStrings), thresholdNum, safeAddress]
  );

  // B-5: 同步 safe_owners 表（全量替换，链上为准）
  await pool.query('DELETE FROM safe_owners WHERE safe_address = LOWER($1)', [safeAddress]);
  for (const owner of ownerStrings) {
    await pool.query(
      `INSERT INTO safe_owners (id, safe_address, owner_address) VALUES ($1, LOWER($2), $3)
       ON CONFLICT (safe_address, owner_address) DO NOTHING`,
      [uuidv4(), safeAddress, owner]
    );
  }

  logger.info('Safe state synced', { safeAddress, owners: ownerStrings, threshold: thresholdNum, nonce: nonceNum });
  return { owners: ownerStrings, threshold: thresholdNum, nonce: nonceNum };
}

// ── Utils ──

function computeSafeTxHash(
  safeAddress: string,
  to: string,
  value: string,
  data: string,
  nonce: number,
  chainId: string,
): string {
  const buildBigInt = (v: string) => v.includes('.') ? parseEther(v) : BigInt(v);

  // EIP-712 typed data hash for Safe transactions
  // SafeTx type: address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce
  const safeTxTypeHash = keccak256(
    encodePacked(
      ['string'],
      ['SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)']
    )
  );

  // Encode tx data hash
  const txDataHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, address, uint256, bytes32, uint8, uint256, uint256, uint256, address, address, uint256'),
      [
        safeTxTypeHash,
        to as Address,
        buildBigInt(value),
        keccak256(data as Hex),
        0,  // operation: Call
        0n, // safeTxGas
        0n, // baseGas
        0n, // gasPrice
        '0x0000000000000000000000000000000000000000' as Address, // gasToken
        '0x0000000000000000000000000000000000000000' as Address, // refundReceiver
        BigInt(nonce),
      ]
    )
  );

  return txDataHash;
}

/**
 * Count Safe vaults owned by a wallet address.
 * Lightweight — used by /safe/status endpoint.
 */
export async function getSafeCount(walletAddress: string): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) FROM safe_wallets WHERE LOWER(safe_address) = $1',
    [walletAddress.toLowerCase()]
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}
