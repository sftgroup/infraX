import type { Address, Hex } from 'viem';
import type { Signer } from '../types.js';
import { isHttpOk, postJson } from '../utils/rpc.js';

/**
 * MpcSigner 认证形态（AASDK-4）：token 模式（现有）或 email 模式（白标接入）。
 *   - token 模式：走现有 /sign-digest /sign-message（解锁会话 token）
 *   - email 模式：走 mpc-server 新增 /api/v2/mpc/sign { message, mode, email }
 *     鉴权语义 = email 关联钱包已解锁会话（不引入裸 email 鉴权）
 */
export type MpcSignerAuth =
  | { token: string; email?: undefined }
  | { email: string; token?: undefined };

/**
 * MPC 签名器（E-1d 实现）：对接 MPC 服务邮箱恢复钱包，不接触私钥。
 *   - signUserOp：对 ERC-4337 userOpHash（32B EIP-712 摘要）直接签名
 *     → token 模式 POST {serviceUrl}/api/v2/mpc/sign-digest { token, digest }
 *     → email 模式 POST {serviceUrl}/api/v2/mpc/sign { message: digest, mode: 'digest', email }
 *     （E-1d 新增端点：TSS 2-of-2 raw 摘要签名，免二次哈希）
 *   - signMessage：EIP-191 消息签名（服务端 hashMessage + TSS）
 *     → token 模式 POST {serviceUrl}/api/v2/mpc/sign-message { token, message }
 *     → email 模式 POST {serviceUrl}/api/v2/mpc/sign { message, mode: 'eip191', email }
 *
 * 返回 65B serialized 签名（0x + r||s||v，ethers Signature.serialized），
 * 与 Kernel v3 ECDSA validator 的 secp256k1 验证兼容。
 */
export class MpcSigner implements Signer {
  readonly type = 'mpc' as const;
  readonly address: Address;
  private readonly serviceUrl: string;
  private readonly auth: MpcSignerAuth;

  /** auth 兼容 string（裸 token，向后兼容）| {token} | {email} */
  constructor(address: Address, serviceUrl: string, auth: string | MpcSignerAuth) {
    this.address = address;
    this.serviceUrl = serviceUrl;
    if (typeof auth === 'string') {
      this.auth = { token: auth };
    } else if (auth.token) {
      this.auth = { token: auth.token };
    } else if (auth.email) {
      this.auth = { email: auth.email };
    } else {
      throw new Error('[aa-sdk] MpcSigner requires token or email');
    }
  }

  async signUserOp(userOpHash: Hex): Promise<Hex> {
    return this.signDigest(userOpHash);
  }

  /** 对任意 32B 摘要直接签名（免二次哈希；服务端 /sign-digest 或 /sign digest 模式） */
  async signDigest(digest: Hex): Promise<Hex> {
    const sig = this.auth.token
      ? await this.post('/api/v2/mpc/sign-digest', { token: this.auth.token, digest })
      : await this.post('/api/v2/mpc/sign', { message: digest, mode: 'digest', email: this.auth.email });
    return (sig.signature ?? sig.data?.signature) as Hex;
  }

  async signMessage(message: Hex): Promise<Hex> {
    const sig = this.auth.token
      ? await this.post('/api/v2/mpc/sign-message', { token: this.auth.token, message: String(message) })
      : await this.post('/api/v2/mpc/sign', { message: String(message), mode: 'eip191', email: this.auth.email });
    return (sig.signature ?? sig.data?.signature) as Hex;
  }

  private async post(path: string, body: unknown): Promise<any> {
    const { status, json } = await postJson<Record<string, any>>(
      `${this.serviceUrl.replace(/\/+$/, '')}${path}`,
      body,
      { label: `MPC ${path}` },
    );
    if (!isHttpOk(status)) {
      throw new Error(
        `[aa-sdk] MPC ${path} failed (${status}): ${json?.message || json?.error?.message || ''}`,
      );
    }
    return json;
  }
}
