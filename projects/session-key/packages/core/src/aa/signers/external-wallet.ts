import type { Address, Hex } from 'viem';
import type { Signer } from '../types.js';

// ============================================================================
// 外部钱包签名器（P0.13，AA_SDK_TECH_DESIGN §6.1）
// 场景：MetaMask / OKX 等浏览器钱包作为 Kernel owner，完成首次 UserOp 授权
// （enableSession）。签名委托给 window.ethereum（EIP-1193 provider）：
//   - signUserOp：eth_sign（对 32 字节 userOpHash digest 的原始 ECDSA，
//     与 Kernel ECDSA validator 的 ecrecover(userOpHash, sig) 语义一致）
//   - signMessage：personal_sign（EIP-191）
//   - signTypedData：eth_signTypedData_v4（可选，v0.7 UserOperation 结构化展示）
// 零硬编码：provider 由调用方注入（浏览器环境 window.ethereum 或测试 mock）。
// ============================================================================

/** EIP-1193 Provider 最小接口（浏览器钱包注入） */
export interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** EIP-712 TypedData（viem 兼容结构，供 eth_signTypedData_v4） */
export interface TypedDataLike {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export class ExternalWalletSigner implements Signer {
  readonly type = 'external-wallet' as const;
  private _address: Address;

  constructor(
    private readonly provider: EIP1193Provider,
    address?: Address,
  ) {
    // 未传地址时先占位，connect() 时从 eth_accounts 解析
    this._address = address ?? ('0x0000000000000000000000000000000000000000' as Address);
  }

  get address(): Address {
    return this._address;
  }

  /** 从 provider 解析当前账户（eth_accounts[0]）；未连接时抛错 */
  async connect(): Promise<Address> {
    const accounts = (await this.provider.request({ method: 'eth_accounts', params: [] })) as string[];
    if (!accounts || accounts.length === 0) {
      throw new Error('[aa-sdk] external wallet not connected: eth_accounts returned empty');
    }
    this._address = accounts[0] as Address;
    return this._address;
  }

  /** 对 userOpHash（EIP-712 digest，v0.7）签原始 ECDSA，供 Kernel ECDSA validator 校验 */
  async signUserOp(userOpHash: Hex): Promise<Hex> {
    const sig = (await this.provider.request({
      method: 'eth_sign',
      params: [this.address, userOpHash],
    })) as Hex;
    return sig;
  }

  /** EIP-191 消息签名（personal_sign） */
  async signMessage(message: Hex): Promise<Hex> {
    const sig = (await this.provider.request({
      method: 'personal_sign',
      params: [message, this.address],
    })) as Hex;
    return sig;
  }

  /** 可选：完整 EIP-712 结构化签名（v0.7 UserOperation typedData，钱包可读展示） */
  async signTypedData(typedData: TypedDataLike): Promise<Hex> {
    const sig = (await this.provider.request({
      method: 'eth_signTypedData_v4',
      params: [this.address, JSON.stringify(typedData)],
    })) as Hex;
    return sig;
  }
}
