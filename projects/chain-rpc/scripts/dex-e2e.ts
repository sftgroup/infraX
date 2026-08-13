/**
 * A-11.7 E2E：DEX swap 真实小额定单（生产）
 *
 * 流程：dex.quote（读 key）→ dex.swap 构建（广播 key）→ 填充 nonce/gasPrice
 *      → digest 交 MPC sign-digest 签名 → 组装 signed rawTransaction
 *      → /v1/broadcast/bsc {wait:true} → 链上收据核对
 *
 * RFQ 容错（2026-08-14 E2E 发现）：OKX 对高流动性对会在 tx 尾部注入 Wintermute
 * RFQ 结算段（0x777777…），订单有效期极短 → 广播延迟即 RFQ_OrderExpired revert。
 * 对策：
 *   a) 广播前用公共 RPC eth_call 预演（只读，不消耗订单）：若 RFQ_OrderExpired
 *      立即重新 quote/swap 换新订单；
 *   b) 整体重试循环（MAX_ATTEMPTS），失败仅损失小额 gas；
 *   c) 组装时本地抬高 gasLimit（≥1.2M，未用部分链上退还），防估算偏低 OOG。
 *
 * 前置：
 *  - MPC 钱包已解锁（session token）
 *  - chain-rpc 生产可达（:9130），广播 key 已签发
 *  - 钱包有 BSC 余额（gas + 小额 swap）
 *
 * 运行：tsx scripts/dex-e2e.ts
 * env：
 *   CHAIN_RPC_URL=…:9130（默认 http://127.0.0.1:9130）
 *   CHAIN_RPC_READ_KEY / CHAIN_RPC_BROADCAST_KEY / MPC_URL / MPC_BRIDGE_KEY
 *   DEX_E2E_TOKEN=mpc session token / DEX_E2E_FROM=钱包地址 / DEX_E2E_CHAIN=bsc
 *   DEX_E2E_TOKEN_IN / DEX_E2E_TOKEN_OUT / DEX_E2E_AMOUNT_IN（wei）
 */
import { Transaction } from 'ethers';

const env = (k: string, d = ''): string => process.env[k] || d;
const RPC = env('CHAIN_RPC_URL', 'http://127.0.0.1:9130');
const READ_KEY = env('CHAIN_RPC_READ_KEY', '');
const BROADCAST_KEY = env('CHAIN_RPC_BROADCAST_KEY', '');
const MPC = env('MPC_URL', 'http://127.0.0.1:9104');
const BRIDGE_KEY = env('MPC_BRIDGE_KEY', '');
const TOKEN = env('DEX_E2E_TOKEN', '');
const FROM = env('DEX_E2E_FROM', '');
const CHAIN = env('DEX_E2E_CHAIN', 'bsc');
const TOKEN_IN = env('DEX_E2E_TOKEN_IN', '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
const TOKEN_OUT = env('DEX_E2E_TOKEN_OUT', '0x55d398326f99059ff775485246999027b3197955'); // BSC USDT
const AMOUNT_IN = env('DEX_E2E_AMOUNT_IN', '6000000000000000'); // 0.006 BNB
const SLIPPAGE = parseFloat(env('DEX_E2E_SLIPPAGE', '0.01'));
const MAX_ATTEMPTS = parseInt(env('DEX_E2E_MAX_ATTEMPTS', '5'), 10);
const GAS_FLOOR = parseInt(env('DEX_E2E_GAS_FLOOR', '1200000'), 10); // 本地 gasLimit 下限
// preflight 用公共 RPC（免 chain-rpc 上游波动/配额）
const PUBLIC_RPC = env('DEX_E2E_PUBLIC_RPC', 'https://bsc-dataseed.bnbchain.org');

async function post(url: string, key: string, body: any): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== 0 && j.code !== undefined)) {
    throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  }
  return j;
}

async function rpcCall(method: string, params: any[]): Promise<any> {
  const j = await post(`${RPC}/v1/rpc/${CHAIN}`, READ_KEY, { method, params });
  return j.data?.result;
}

/** 公共 RPC eth_call 预演：返回 null=成功 / 字符串=revert 原因 */
async function preflight(tx: any): Promise<string | null> {
  const call = {
    from: FROM,
    to: tx.to,
    data: tx.data,
    value: `0x${BigInt(tx.value || '0').toString(16)}`,
    gas: `0x${GAS_FLOOR.toString(16)}`,
  };
  const res = await fetch(PUBLIC_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, 'latest'] }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error) {
    const raw = (j.error.data as string) || '';
    // 提取 Error(string) 的 reason
    if (raw.startsWith('0x08c379a0') && raw.length >= 138) {
      const len = parseInt(raw.slice(10, 74), 16);
      const msg = Buffer.from(raw.slice(74, 74 + len * 2), 'hex').toString('utf8');
      return msg || j.error.message;
    }
    return `${j.error.message}${raw ? ` ${raw.slice(0, 120)}` : ''}`;
  }
  return null;
}

async function main(): Promise<void> {
  if (!READ_KEY || !BROADCAST_KEY || !TOKEN || !FROM) {
    throw new Error('missing env: CHAIN_RPC_READ_KEY/BROADCAST_KEY, DEX_E2E_TOKEN, DEX_E2E_FROM');
  }
  console.log(`[e2e] chain=${CHAIN} from=${FROM} amount=${AMOUNT_IN} attempts<=${MAX_ATTEMPTS} gasFloor=${GAS_FLOOR}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n========== attempt ${attempt}/${MAX_ATTEMPTS} ==========`);
    try {
      // 1. quote（每次重试重新询价，生成新 RFQ 订单）
      const quote = await post(`${RPC}/v1/dex-rpc`, READ_KEY, {
        method: 'dex.quote',
        params: { chain: CHAIN, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN, slippage: SLIPPAGE, from: FROM },
      });
      console.log(`[e2e] quote ok aggregator=${quote.data?.aggregator} amountOut=${quote.data?.amountOut}`);

      // 2. swap 构建
      const swap = await post(`${RPC}/v1/dex-rpc`, BROADCAST_KEY, {
        method: 'dex.swap',
        params: { chain: CHAIN, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN, slippage: SLIPPAGE, from: FROM, recipient: FROM },
      });
      const tx0 = swap.data.rawTransaction;
      const gasLimit = Math.max(parseInt(tx0.gasLimit, 10), GAS_FLOOR);
      console.log(`[e2e] swap built to=${tx0.to} okxGas=${tx0.gasLimit} localGas=${gasLimit}`);

      // 2.5 preflight eth_call：RFQ 过期/不可执行 → 提前换订单，不浪费广播
      const reason = await preflight(tx0);
      if (reason) {
        console.log(`[e2e] preflight REVERT: ${reason}`);
        const isExpired = reason.toLowerCase().includes('rfq') || reason.toLowerCase().includes('expired');
        if (isExpired) continue; // 换新订单重试
        throw new Error(`preflight failed (non-RFQ): ${reason}`);
      }
      console.log('[e2e] preflight OK (executable)');

      // 3. 填充 nonce/gasPrice（BSC 用 legacy gasPrice）
      const nonce = await rpcCall('eth_getTransactionCount', [FROM, 'latest']);
      const gasPrice = await rpcCall('eth_gasPrice', []);
      console.log(`[e2e] nonce=${nonce} gasPrice=${gasPrice}`);

      const unsigned = Transaction.from({
        to: tx0.to,
        data: tx0.data,
        value: tx0.value || '0',
        chainId: tx0.chainId,
        gasLimit,
        nonce: parseInt(nonce, 16),
        gasPrice,
      });
      const digest = unsigned.unsignedHash;
      console.log(`[e2e] digest=${digest}`);

      // 4. MPC 签名
      const sigRes = await post(`${MPC}/api/v2/mpc/sign-digest`, BRIDGE_KEY, { token: TOKEN, digest });
      console.log(`[e2e] mpc signed by=${sigRes.data?.address} sig=${String(sigRes.data?.signature).slice(0, 40)}…`);

      // 5. 组装 signed raw
      const signed = Transaction.from({ ...unsigned.toJSON(), signature: sigRes.data.signature });
      const raw = signed.serialized;
      console.log(`[e2e] raw=${raw.slice(0, 80)}…`);

      // 6. 广播（wait）
      const bcast = await post(`${RPC}/v1/broadcast/${CHAIN}`, BROADCAST_KEY, { rawTransaction: raw, wait: true, timeoutMs: 120000 });
      const status = bcast.data?.receipt?.status;
      const txHash = bcast.data?.txHash;
      console.log(`[e2e] BROADCAST OK txHash=${txHash} status=${status} block=${bcast.data?.receipt?.blockNumber}`);
      if (status !== '0x1') {
        console.log(`[e2e] on-chain FAILED (status=${status}) gasUsed=${bcast.data?.receipt?.gasUsed} —— 重试换新 RFQ 订单`);
        continue;
      }
      console.log(`[e2e] SUCCESS txHash=${txHash} gasUsed=${bcast.data?.receipt?.gasUsed}`);
      console.log(`[e2e] receipt=${JSON.stringify(bcast.data?.receipt || {}).slice(0, 400)}`);
      return; // 成功
    } catch (e: any) {
      console.error(`[e2e] attempt ${attempt} error:`, e?.message || e);
      if (String(e?.message).toLowerCase().includes('rfq') || String(e?.message).toLowerCase().includes('expired')) {
        continue; // 订单过期类错误 → 重试
      }
      if (attempt === MAX_ATTEMPTS) throw e;
    }
  }
  throw new Error(`E2E failed after ${MAX_ATTEMPTS} attempts (RFQ 订单反复过期)`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[e2e] FAILED:', e?.message || e);
  process.exit(1);
});
