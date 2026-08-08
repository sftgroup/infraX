/**
 * DC-10: waas 链上访问统一收敛到 chain-rpc 网关（禁止直连上游 RPC）。
 *
 * GatewayProvider 继承 ethers.JsonRpcProvider，重写 send()：
 *   - 读方法（eth_getBalance / eth_call / eth_estimateGas / eth_getLogs /
 *     eth_getTransactionCount / eth_getBlockByNumber / eth_gasPrice …）
 *     → POST {gateway}/v1/rpc/:chain（读 key，方法走网关白名单）
 *   - 广播（eth_sendRawTransaction，来自 wallet/contract.sendTransaction）
 *     → POST {gateway}/v1/broadcast/:chain（广播 key）
 *
 * 网关统一信封：{code, message, data}；读返回 data.result，广播返回 data.txHash。
 * 不直连任何上游 RPC，全部由 chain-rpc 网关汇总分发；网关不可用直接抛错。
 */
import { ethers } from 'ethers';
import { config } from '../config';

/** 链名 → chainId（生产主网；与网关 normalizeChain 别名语义一致） */
const CHAIN_IDS: Record<string, number> = {
  sepolia: 11155111,
  eth: 1,
  ethereum: 1,
  bsc: 56,
  base: 8453,
  oxa: 19505,
};

export class GatewayProvider extends ethers.JsonRpcProvider {
  private readonly chain: string;
  private readonly gateway: string;
  private readonly readKey: string;
  private readonly broadcastKey: string;

  constructor(chain: string) {
    const g = config.chainRpcGateway;
    if (!g.baseUrl) {
      throw new Error('CHAIN_RPC_URL not configured: gateway is the only RPC entry');
    }
    const norm = chain.toLowerCase();
    const chainId = CHAIN_IDS[norm];
    if (!chainId) {
      throw new Error(`Unsupported chain: ${chain}`);
    }
    const base = g.baseUrl.replace(/\/+$/, '');
    // 显式传入 Network 实例 + staticNetwork：ethers 6.17 对 Networkish 对象不会设置
    // staticNetwork，getNetwork()/getFeeData() 会触发低层 _send 的 eth_chainId 探测，
    // 该探测打到网关根路径返回 404。传实例后可完全跳过探测。
    const network = new ethers.Network(norm, chainId);
    super(base, network, { staticNetwork: network });
    this.chain = norm;
    this.gateway = base;
    this.readKey = g.readKey || '';
    this.broadcastKey = g.broadcastKey || '';
  }

  override async send(method: string, params: Array<any>): Promise<any> {
    const isBroadcast = method === 'eth_sendRawTransaction';
    const url = `${this.gateway}${isBroadcast ? '/v1/broadcast' : '/v1/rpc'}/${encodeURIComponent(this.chain)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': isBroadcast ? this.broadcastKey : this.readKey,
      },
      body: JSON.stringify({ method, params }),
    });
    let json: any;
    try {
      json = await resp.json();
    } catch {
      throw new Error(`[waas-gateway] non-json response ${resp.status} from ${url}`);
    }
    if (resp.status !== 200 || json.code !== 0) {
      throw new Error(`[waas-gateway] ${json.detail || json.message || `http ${resp.status}`} (method=${method})`);
    }
    return isBroadcast ? json.data.txHash : json.data.result;
  }
}
