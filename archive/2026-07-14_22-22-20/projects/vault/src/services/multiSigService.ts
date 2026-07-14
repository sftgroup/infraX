import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import {
  createPublicClient, createWalletClient, http, getAddress,
  keccak256, encodePacked, encodeAbiParameters, parseAbiParameters,
  encodeFunctionData, getCreate2Address, parseEther,
  // parseEventLogs removed (using ethers instead),
  type Address, type Hex
} from 'viem';
import { sepolia } from 'viem/chains';
import { getContractAddress } from 'viem/utils';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';
import { config } from '../config';
import { getHDMnemonic, getPrivateKey } from './hdWalletService';

/**
 * Multi-Sig Service (F-027~F-032)
 * Gnosis Safe-compatible multi-signature wallet management
 *
 * Uses Safe Proxy Factory pattern:
 * - SafeProxyFactory: creates Safe proxies via createProxyWithNonce
 * - Safe: the multi-sig wallet contract
 *
 * Sepolia Safe addresses (v1.4.1):
 * - Safe Singleton: 0x29fcb43b46531bc0030c8fc6d5e1d063e48a7bc7
 * - SafeProxyFactory: 0xc22834581ebc8527d974f8a1c97e1bea4ef910bc
 * - SafeL2 Singleton: 0x29fcb43b46531bc0030c8fc6d5e1d063e48a7bc7 (same for L2)
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

// Chain configs
const CHAIN_CONFIG: Record<string, {
  chain: any;
  rpcUrl: string;
  safeSingleton: Address;
  safeProxyFactory: Address;
}> = {
  '11155111': {
    chain: sepolia,
    rpcUrl: config.sepoliaRpcUrl || 'https://1rpc.io/sepolia',
    safeSingleton: '0x29fcb43b46531bc0030c8fc6d5e1d063e48a7bc7' as Address,
    safeProxyFactory: '0xfc7fa546b24477e8a2ce3a8d39869b122017ea2b' as Address,
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
    const tx = await factory.createProxyWithNonce(
      cfg.safeSingleton, initializer, saltNonce,
      { gasLimit: 500000 }
    );
    const receipt = await tx.wait();
    const txHash = receipt.hash as Address;

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
    logger.warn('Safe chain deployment failed, storing pending', {
      safeId, predictedAddress, error: err.message,
    });
    // Fall through — store as pending, can retry later
  }

  await pool.query(
    `INSERT INTO safe_wallets (id, user_id, chain_id, safe_address, owners, threshold, name, status, salt_nonce)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [safeId, userId, chainId, actualAddress, JSON.stringify(owners), threshold, name || null, status, saltNonce.toString()]
  );

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

  // Get current nonce from chain (or DB counter)
  const nonceSig = await pool.query(
    "SELECT COALESCE(MAX(nonce), 0) + 1 as next_nonce FROM safe_transactions WHERE safe_address = $1",
    [safeAddress]
  );
  const nonce = nonceSig.rows[0].next_nonce || 0;

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
  try {
    const signerAddress = ethers.verifyMessage(
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

  // Store signature
  await pool.query(
    `INSERT INTO safe_signatures (id, safe_tx_hash, signer_id, signature, signature_type)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv4(), safeTxHash, userId, signature, 'eoa']
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

  // Build packed signatures (sorted by owner address order in safe)
  // Build packed signatures matching signer_id (userId) to owner addresses.
  // We need to map userIds from safe_signatures to wallet addresses.
// pool already imported at module scope
  const userIds = sigs.rows.map((s: any) => s.signer_id);
  const walletMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const walletResult = await pool.query(
      'SELECT user_id, address FROM wallets WHERE user_id = ANY($1)',
      [userIds]
    );
    for (const w of walletResult.rows) {
      walletMap[w.user_id] = w.address.toLowerCase();
    }
  }

  const ownerSigs = safe.owners.map((owner: string) => {
    // Find signature by matching owner address against wallet addresses of signers
    const sig = sigs.rows.find((s: any) => {
      const signerWallet = walletMap[s.signer_id];
      return signerWallet && signerWallet === owner.toLowerCase();
    });
    return sig ? sig.signature : '0x';
  }).filter((s: string) => s !== '0x');

  const packedSigs = ownerSigs.join('').replace(/0x/g, '');

  // Execute via Safe proxy on-chain
  const cfg = getChainCfg(safe.chain_id);
  const txRow = tx.rows[0];
  let chainTxHash: string | null = null;

  try {
    const signer = getDeployerSigner(safe.chain_id);

    const signatures = '0x' + packedSigs;
    const safeContract = new ethers.Contract(
      safe.safe_address,
      [
        'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) public returns (bool)'
      ],
      signer
    );
    const tx = await safeContract.execTransaction(
      txRow.to_address,
      ethers.parseEther(txRow.value || '0'),
      txRow.data || '0x',
      0, // Call
      0, 0, 0,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      signatures,
      { gasLimit: 500000 }
    );
    const execReceipt = await tx.wait();
    chainTxHash = execReceipt.hash;

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

export async function updateSafeOwners(params: {
  userId: string;
  safeAddress: string;
  newOwners: string[];
  newThreshold: number;
}): Promise<{ owners: string[]; threshold: number }> {
  const { safeAddress, newOwners, newThreshold } = params;

  if (newThreshold < 1 || newThreshold > newOwners.length) {
    throw Errors.paramError(`Threshold must be 1-${newOwners.length}`);
  }

  // In production: this is itself a multi-sig tx (requires threshold signatures)
  await pool.query(
    'UPDATE safe_wallets SET owners = $1, threshold = $2, updated_at = NOW() WHERE safe_address = $3',
    [JSON.stringify(newOwners), newThreshold, safeAddress]
  );

  logger.info('Safe owners updated', { safeAddress, owners: newOwners, threshold: newThreshold });
  return { owners: newOwners, threshold: newThreshold };
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
    'SELECT COUNT(*) FROM safes WHERE owner_address = $1',
    [walletAddress.toLowerCase()]
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}
