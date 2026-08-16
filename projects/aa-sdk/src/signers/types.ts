import type { Address, Hex } from 'viem';
import type { Signer } from '../types.js';
import type { EIP1193Provider } from './external-wallet.js';
import type { SessionKeySignerOptions } from './session-key.js';

export type { Signer };

/** 签名器工厂选项（由 createSigner 分发到四类实现） */
export interface SignerOptions {
  /** 私钥签名：hex 私钥 */
  privateKey?: Hex;
  /** MPC 签名：远程 MPC 服务配置（对接收割服务） */
  mpc?: {
    address: Address;
    serviceUrl: string;
    token: string;
  };
  /** Session Key 签名：InfraX Session Key Engine（P3.1，已接线 execute） */
  sessionKeyEngine?: {
    address: Address;
    /** Engine 基地址（缺省读 SESSION_KEY_ENGINE_URL env） */
    url?: string;
    /** Engine 鉴权 token（缺省读 SESSION_KEY_ENGINE_TOKEN env） */
    token?: string;
  } & SessionKeySignerOptions;
  /** 外部钱包签名（P0.13）：MetaMask/OKX 等浏览器钱包（EIP-1193 provider） */
  externalWallet?: {
    provider: EIP1193Provider;
    address?: Address;
  };
}

/**
 * 签名器工厂（P0.13 扩展：external-wallet）。
 * 按选项分发到对应实现；多选时按 privateKey > mpc > sessionKeyEngine > externalWallet 优先。
 */
export async function createSigner(options: SignerOptions): Promise<Signer> {
  if (options.privateKey) {
    const { PrivateKeySigner } = await import('./private-key.js');
    return new PrivateKeySigner(options.privateKey);
  }
  if (options.mpc) {
    const { MpcSigner } = await import('./mpc.js');
    return new MpcSigner(options.mpc.address, options.mpc.serviceUrl, options.mpc.token);
  }
  if (options.sessionKeyEngine) {
    const { SessionKeySigner } = await import('./session-key.js');
    const { address, url, token, sessionId, chain, to, timeoutMs } = options.sessionKeyEngine;
    const signer = new SessionKeySigner(address, url, token, { sessionId, chain, to, timeoutMs });
    return signer;
  }
  if (options.externalWallet) {
    const { ExternalWalletSigner } = await import('./external-wallet.js');
    const signer = new ExternalWalletSigner(options.externalWallet.provider, options.externalWallet.address);
    if (!options.externalWallet.address) {
      await signer.connect(); // 解析当前账户
    }
    return signer;
  }
  throw new Error('[aa-sdk] createSigner: no signer option provided');
}
