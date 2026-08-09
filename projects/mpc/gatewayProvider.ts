/**
 * DC-3: mpc 链上访问统一收敛到 chain-rpc 网关（禁止直连上游 RPC）。
 *
 * GatewayProvider 继承 ethers.JsonRpcProvider，重写 send()：
 *  - 读方法（eth_getBalance / eth_call / eth_estimateGas / eth_getTransactionReceipt …）
 *    → POST {gateway}/v1/rpc/:chain（读 key，方法走网关白名单）
 *  - 广播（eth_sendRawTransaction）→ POST {gateway}/v1/broadcast/:chain（广播 key）
 *
 * 网关统一信封：{code, message, data}；读返回 data.result，广播返回 data.txHash。
 * 不直连任何上游 RPC，全部由网关汇总分发。
 */
import { ethers } from 'ethers';

export interface GatewayProviderOptions {
  gateway: string;       // 网关地址，如 http://127.0.0.1:9130
  readKey: string;       // 读端点 key（CHAIN_RPC_READ_KEY）
  broadcastKey: string;  // 广播端点 key（CHAIN_RPC_BROADCAST_KEY）
}

export class GatewayProvider extends ethers.JsonRpcProvider {
  private readonly gateway: string;
  private readonly readKey: string;
  private readonly broadcastKey: string;
  private readonly rpcChain: string;

  constructor(chain: string, chainId: number, opts: GatewayProviderOptions) {
    // 显式传入 Network 实例 + staticNetwork：ethers 6.17 对 Networkish 对象不会设置
    // staticNetwork，getNetwork()/getFeeData() 会触发低层 _send 的 eth_chainId 探测，
    // 该探测打到网关根路径返回 404。传实例后可完全跳过探测。
    const network = new ethers.Network(chain, chainId);
    super(opts.gateway, network, { staticNetwork: network });
    this.gateway = opts.gateway.replace(/\/+$/, '');
    this.readKey = opts.readKey;
    this.broadcastKey = opts.broadcastKey;
    this.rpcChain = chain;
  }

  override async send(method: string, params: Array<any>): Promise<any> {
    const isBroadcast = method === 'eth_sendRawTransaction';
    const url = `${this.gateway}${isBroadcast ? '/v1/broadcast' : '/v1/rpc'}/${this.rpcChain}`;
    // 广播端点契约：{ rawTransaction, wait }（chain-rpc 广播路由 destructure rawTransaction）；
    // 读端点契约：{ method, params }。
    const body = isBroadcast
      ? { rawTransaction: params[0], wait: true }
      : { method, params };
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': isBroadcast ? this.broadcastKey : this.readKey,
      },
      body: JSON.stringify(body),
    });
    let json: any;
    try {
      json = await resp.json();
    } catch {
      throw new Error(`[mpc-gateway] non-json response ${resp.status} from ${url}`);
    }
    if (resp.status !== 200 || json.code !== 0) {
      throw new Error(`[mpc-gateway] ${json.detail || json.message || `http ${resp.status}`} (method=${method})`);
    }
    return isBroadcast ? json.data.txHash : json.data.result;
  }
}
