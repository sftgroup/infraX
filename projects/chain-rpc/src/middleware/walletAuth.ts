/**
 * chain-rpc 钱包签名鉴权 — EIP-191 personal_sign 恢复地址，对齐全栈契约
 * （waas middleware/auth.ts 与 data app/wallet_auth.py 同款流程）。
 *
 * message  = "InfraX auth: <timestamp>"
 * headers  : x-wallet-address / x-wallet-signature / x-wallet-timestamp
 * TTL      : 24h；校验通过 → req.walletAddress（小写）。
 *
 * 用途：钱包自助签发 rx_ 订阅 key（订阅绑定钱包维度，前端免 service key 操作）。
 */
import { verifyMessage } from 'ethers';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export async function walletAuth(req: any, res: any, next: any): Promise<void> {
  const address = (req.headers['x-wallet-address'] || '').trim().toLowerCase();
  const signature = (req.headers['x-wallet-signature'] || '').trim();
  const timestamp = (req.headers['x-wallet-timestamp'] || '').trim();
  if (!address || !ADDR_RE.test(address) || !signature || !timestamp) {
    res.status(401).json({ detail: 'wallet auth required', code: 401 });
    return;
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SESSION_TTL_MS) {
    res.status(401).json({ detail: 'wallet signature expired', code: 401 });
    return;
  }
  let recovered = '';
  try {
    recovered = verifyMessage(`InfraX auth: ${timestamp}`, signature).toLowerCase();
  } catch {
    res.status(401).json({ detail: 'invalid wallet signature', code: 401 });
    return;
  }
  if (recovered !== address) {
    res.status(401).json({ detail: 'invalid wallet signature', code: 401 });
    return;
  }
  req.walletAddress = address;
  next();
}
