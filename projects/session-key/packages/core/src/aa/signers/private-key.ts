import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Signer } from '../types.js';

/**
 * 私钥签名器：对接钱包现有 keystore.ts（本地加密存储的私钥）。
 * TODO(实现/M2): 从 keystore.ts 读取加密私钥并解密，而非直接传明文。
 */
export class PrivateKeySigner implements Signer {
  readonly type = 'private-key' as const;
  readonly address: `0x${string}`;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  async signUserOp(userOpHash: Hex): Promise<Hex> {
    return this.account.sign({ hash: userOpHash });
  }

  async signMessage(message: Hex): Promise<Hex> {
    return this.account.signMessage({ message: { raw: message } });
  }
}
