import type { Hex } from 'viem';
import type { Signer } from '../types.js';

/**
 * MPC 签名器：对接钱包现有 mpc.ts（远程 MPC 服务，邮箱恢复的差异化能力）。
 * TODO(实现/M2): 对接 MPC 服务 `/sign` 接口，返回分片签名聚合结果。
 */
export class MpcSigner implements Signer {
  readonly type = 'mpc' as const;
  readonly address: `0x${string}`;

  constructor(
    address: `0x${string}`,
    private readonly serviceUrl: string,
    private readonly token: string,
  ) {
    this.address = address;
  }

  async signUserOp(userOpHash: Hex): Promise<Hex> {
    // TODO(实现): POST {serviceUrl}/sign  { userOpHash, token }
    throw new Error('MpcSigner.signUserOp not implemented yet');
  }

  async signMessage(message: Hex): Promise<Hex> {
    // TODO(实现): POST {serviceUrl}/sign  { message, token }
    throw new Error('MpcSigner.signMessage not implemented yet');
  }
}
