import type { Address, Hex } from 'viem';
import type { Signer } from '../types.js';

/**
 * MPC 签名器（E-1d 实现）：对接 MPC 服务邮箱恢复钱包，不接触私钥。
 *   - signUserOp：对 ERC-4337 userOpHash（32B EIP-712 摘要）直接签名
 *     → POST {serviceUrl}/api/v2/mpc/sign-digest { token, digest }
 *     （E-1d 新增端点：TSS 2-of-2 raw 摘要签名，免二次哈希）
 *   - signMessage：EIP-191 消息签名（服务端 hashMessage + TSS）
 *     → POST {serviceUrl}/api/v2/mpc/sign-message { token, message }
 *
 * 返回 65B serialized 签名（0x + r||s||v，ethers Signature.serialized），
 * 与 Kernel v3 ECDSA validator 的 secp256k1 验证兼容。
 */
export class MpcSigner implements Signer {
  readonly type = 'mpc' as const;
  readonly address: Address;

  constructor(
    address: Address,
    private readonly serviceUrl: string,
    private readonly token: string,
  ) {
    this.address = address;
  }

  async signUserOp(userOpHash: Hex): Promise<Hex> {
    return this.signDigest(userOpHash);
  }

  /** 对任意 32B 摘要直接签名（免二次哈希；服务端 /sign-digest） */
  async signDigest(digest: Hex): Promise<Hex> {
    const sig = await this.post('/api/v2/mpc/sign-digest', { token: this.token, digest });
    return (sig.signature ?? sig.data?.signature) as Hex;
  }

  async signMessage(message: Hex): Promise<Hex> {
    const sig = await this.post('/api/v2/mpc/sign-message', {
      token: this.token,
      message: String(message),
    });
    return (sig.signature ?? sig.data?.signature) as Hex;
  }

  private async post(path: string, body: unknown): Promise<any> {
    const resp = await fetch(`${this.serviceUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error(`[aa-sdk] MPC ${path} failed (${resp.status}): ${json?.message || json?.error?.message || ''}`);
    }
    return json;
  }
}
