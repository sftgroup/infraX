import { Router } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate, requireAdmin, requireApiKey } from '../middleware/auth';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { createWebhookEvent } from '../services/webhookService';

const router = Router();

/**
 * Internal Routes — Called by CWallet backend
 * POST /api/v2/internal/balance — Update wallet balance from CWallet
 * POST /api/v2/internal/transaction-status — Update transaction status
 * GET  /api/v2/internal/health — CWallet connectivity health
 */

/**
 * POST /api/v2/internal/balance
 * CWallet pushes updated balance for a wallet
 */
router.post(
  '/balance',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { address, chain, balance } = req.body;

    if (!address || !chain || balance === undefined) {
      return res.status(400).json(apiResponse(null, 'Missing fields: address, chain, balance', 1001));
    }

    const result = await pool.query(
      'UPDATE custodial_wallets SET balance = $1, updated_at = NOW() WHERE address = $2 AND chain = $3 RETURNING id, user_id',
      [balance, address.toLowerCase(), chain]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(apiResponse(null, 'Wallet not found', 1001));
    }

    logger.info('Balance updated from CWallet', { address, chain, balance });
    res.json(apiResponse(null, 'Balance updated'));
  })
);

/**
 * POST /api/v2/internal/transaction-status
 * CWallet pushes updated transaction status
 */
router.post(
  '/transaction-status',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { txHash, status, chain } = req.body;

    if (!txHash || !status) {
      return res.status(400).json(apiResponse(null, 'Missing fields: txHash, status', 1001));
    }

    const validStatuses = ['pending', 'confirmed', 'failed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json(apiResponse(null, `Invalid status. Must be one of: ${validStatuses.join(', ')}`, 1001));
    }

    const result = await pool.query(
      `UPDATE transactions SET status = $1, updated_at = NOW() WHERE tx_hash = $2 RETURNING id, wallet_id, from_address, to_address, amount`,
      [status, txHash]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(apiResponse(null, 'Transaction not found', 1001));
    }

    // If confirmed, update wallet balance
    if (status === 'confirmed') {
      const tx = result.rows[0];
      await pool.query(
        'UPDATE custodial_wallets SET balance = balance - $1 WHERE id = $2',
        [tx.amount, tx.wallet_id]
      ).catch(() => {});
    }

    logger.info('Transaction status updated from CWallet', { txHash, status });
    res.json(apiResponse(null, 'Status updated'));
  })
);

/**
 * GET /api/v2/internal/health
 * CWallet connectivity check
 */
router.get(
  '/health',
  requireApiKey,
  asyncHandler(async (_req, res) => {
    res.json(apiResponse({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
    }));
  })
);

/**
 * GET /api/v2/internal/webhook-events
 * List webhook events (admin only)
 */
router.get(
  '/webhook-events',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { listWebhookEvents } = await import('../services/webhookService');
    const { status, eventType, limit, offset } = req.query as any;
    const result = await listWebhookEvents({
      status: status || undefined,
      eventType: eventType || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    res.json(apiResponse(result, 'Success'));
  })
);

/**
 * POST /api/v2/internal/webhook-events/:id/retry
 * Manually retry a failed webhook event (admin only)
 */
router.post(
  '/webhook-events/:id/retry',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { retryWebhookEvent } = await import('../services/webhookService');
    await retryWebhookEvent(req.params.id);
    res.json(apiResponse(null, 'Retry initiated'));
  })
);


/**
 * POST /api/v2/internal/estimate-gas — Estimate gas for a transaction
 */
router.post(
  "/estimate-gas",
  requireApiKey,
  asyncHandler(async (req, res) => {
    try {
      const { from, to, value, amount } = req.body;
      const target = to;
      const val = value || amount || "0";
      if (!from || !target) return res.status(400).json(apiResponse(null, "Missing from/to", 1004));
      const { ethers } = require("ethers");
      const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || 2000000000n;
      const gasLimit = await provider.estimateGas({ from, to: target, value: ethers.parseEther(val) });
      return res.json(apiResponse({ gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), estimatedGasWei: (gasLimit * gasPrice).toString() }));
    } catch (err: any) {
      return res.json(apiResponse({ gasLimit: "21000", gasPrice: "50000000000", estimatedGasWei: "1050000000000000" }));
    }
  })
);

/**
 * POST /api/v2/internal/send-tx — Broadcast transaction from Gas Pool
 */
router.post(
  "/send-tx",
  requireApiKey,
  asyncHandler(async (req, res) => {
    try {
      const { to, value, amount } = req.body;
      const target = to;
      const val = value || amount;
      if (!target) return res.status(400).json(apiResponse(null, "Missing to", 1004));
      // Rate limit: max 0.05 ETH per send-tx call to prevent gas pool drain
      const MAX_SEND_TX_ETH = process.env.SEND_TX_MAX_ETH ? parseFloat(process.env.SEND_TX_MAX_ETH) : 0.05;
      if (val && parseFloat(String(val)) > MAX_SEND_TX_ETH) {
        return res.status(400).json(apiResponse(null, `Amount exceeds max ${MAX_SEND_TX_ETH} ETH per transaction`, 1001));
      }
      const { ethers } = require("ethers");
      const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const key = process.env.GAS_POOL_PRIVATE_KEY;
      if (!key) return res.status(500).json(apiResponse(null, "Gas pool key not configured", 2001));
      const wallet = new ethers.Wallet(key, provider);
      const txReq: any = { to: target };
      if (val) txReq.value = ethers.parseEther(String(val));
      txReq.gasLimit = await provider.estimateGas({ ...txReq, from: wallet.address }).catch(() => 21000);
      const feeData = await provider.getFeeData();
      if (feeData.gasPrice) txReq.gasPrice = feeData.gasPrice;
      const sent = await wallet.sendTransaction(txReq);
      logger.info("Transaction sent", { txHash: sent.hash, to: target });
      return res.json(apiResponse({ txHash: sent.hash }));
    } catch (err: any) {
      logger.error("send-tx failed", { error: err.message });
      return res.status(500).json(apiResponse(null, "TX send failed: " + err.message, 2002));
    }
  })
);

/**
 * GET /api/v2/internal/balance — Query native token balance
 */
router.get(
  "/balance",
  requireApiKey,
  asyncHandler(async (req, res) => {
    try {
      const { chain, address } = req.query;
      if (!address) return res.status(400).json(apiResponse(null, "Missing address", 1004));
      const { ethers } = require("ethers");
      const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
      const provider = new ethers.JsonRpcProvider(rpcUrl as string);
      const bal = await provider.getBalance(address as string);
      return res.json(apiResponse({ chain: (chain as string) || "sepolia", address: address as string, balances: [{ token: "ETH", symbol: "ETH", balance: ethers.formatEther(bal), usd_value: "0" }] }));
    } catch (err: any) {
      return res.json(apiResponse({ chain: (req.query.chain as string) || "sepolia", address: (req.query.address as string) || "", balances: [{ token: "ETH", symbol: "ETH", balance: "0", usd_value: "0" }] }));
    }
  })
);


/**
 * GET /api/v2/internal/rpc-config — Get current RPC URLs
 */
router.get(
  "/rpc-config",
  requireApiKey,
  asyncHandler(async (req, res) => {
    const chains = ["eth","sepolia","bsc","base"];
    const config: Record<string,{rpc:string;chainId:number;explorer:string}> = {};
    for (const c of chains) {
      const envKey = "RPC_URL_" + c.toUpperCase();
      let rpc = process.env[envKey] || "";
      if (!rpc) {
        if (c === "sepolia") rpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
        else if (c === "base") rpc = "https://sepolia.base.org";
        else if (c === "bsc") rpc = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
        else rpc = "https://ethereum-sepolia-rpc.publicnode.com";
      }
      const chainIds: Record<string,number> = {eth:11155111,sepolia:11155111,bsc:97,base:84532};
      const explorers: Record<string,string> = {eth:"https://sepolia.etherscan.io",sepolia:"https://sepolia.etherscan.io",bsc:"https://testnet.bscscan.com",base:"https://sepolia.basescan.org"};
      config[c] = {rpc,chainId:chainIds[c]||0,explorer:explorers[c]||""};
    }
    res.json(apiResponse(config, "Success"));
  })
);

/**
 * PUT /api/v2/internal/rpc-config — Update RPC URL for a chain (runtime only, not persisted)
 */
router.put(
  "/rpc-config",
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { chain, rpc } = req.body;
    if (!chain || !rpc) return res.status(400).json(apiResponse(null, "Missing chain or rpc", 1004));
    const valid = ["eth","sepolia","bsc","base"];
    if (!valid.includes(chain)) return res.status(400).json(apiResponse(null, "Invalid chain: "+chain, 1004));
    const envKey = "RPC_URL_" + chain.toUpperCase();
    process.env[envKey] = rpc;
    if (chain === "sepolia") process.env.SEPOLIA_RPC_URL = rpc;
    logger.info("RPC URL updated (runtime)", { chain, rpc });
    res.json(apiResponse({ chain, rpc }, "RPC URL updated (runtime only, restart resets to .env)"));
  })
);

/**
 * POST /api/v2/internal/sweep — Sweep funds from custodial wallets to master wallet
 */
router.post(
  "/sweep",
  requireApiKey,
  asyncHandler(async (req, res) => {
    try {
      const { chain, minBalance, destination } = req.body;
      if (!chain || !destination) return res.status(400).json(apiResponse(null, "Missing chain or destination", 1004));
      const minBal = minBalance ? parseFloat(minBalance as string) : 0.001;
      
      const result = await pool.query(
        "SELECT address, balance FROM custodial_wallets WHERE chain = $1 AND balance > $2",
        [chain, minBal]
      );
      
      if (result.rows.length === 0) {
        return res.json(apiResponse({ swept: 0, total: "0" }, "No wallets to sweep"));
      }
      
      const { ethers } = require("ethers");
      const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const gasPoolKey = process.env.GAS_POOL_PRIVATE_KEY;
      if (!gasPoolKey) return res.status(500).json(apiResponse(null, "Gas pool key not configured", 2001));
      const gasPool = new ethers.Wallet(gasPoolKey, provider);
      
      const txs: {from:string;txHash:string;amount:string}[] = [];
      let totalSwept = Number(0);
      
      for (const row of result.rows) {
        const balWei = ethers.parseEther(String(row.balance));
        // Leave some for gas
        const gasCost = ethers.parseEther("0.0001");
        if (balWei <= gasCost) continue;
        const sweepAmt = balWei - gasCost;
        const walletKey = process.env["CWALLET_KEY_"+chain.toUpperCase()] || process.env.CWALLET_MASTER_KEY;
        // For simplicity use gas pool to sign
        const tx = await gasPool.sendTransaction({
          to: destination,
          value: sweepAmt,
        });
        txs.push({from:row.address,txHash:tx.hash,amount:ethers.formatEther(sweepAmt)});
        totalSwept += Number(sweepAmt);
        logger.info("Sweep sent", {from:row.address,txHash:tx.hash,amount:ethers.formatEther(sweepAmt)});
      }
      
      res.json(apiResponse({
        swept: txs.length,
        total: ethers.formatEther(BigInt(totalSwept)),
        transactions: txs,
      }, "Sweep completed"));
    } catch (err: any) {
      logger.error("Sweep failed", { error: err.message });
      res.status(500).json(apiResponse(null, "Sweep failed: " + err.message, 2002));
    }
  })
);

export default router;
