// ============================================================================
// aa-sdk / utils/to-owner — Signer → viem LocalAccount（permissionless owner）
// toKernelSmartAccount 的 owner 接受 LocalAccount / WalletClient / EthereumProvider。
// 这里用 viem toAccount 包装统一 Signer 接口（private-key / mpc / session-key 通用）。
// Kernel 验证 = ECDSA 对 userOpHash 签名，owner 只需标准 signMessage。
// ============================================================================

import { bytesToHex, type Hex, type SignableMessage } from 'viem';
import { toAccount, type LocalAccount } from 'viem/accounts';
import type { Signer } from '../types.js';

/**
 * 把 aa-sdk Signer 适配为 permissionless owner（viem LocalAccount）。
 * - signMessage({ message: { raw } }) → Signer.signMessage(hex)
 * - Kernel 内部用 owner.sign() 签 userOpHash（已 wrapMessageHash），链路自动打通
 * - MPC / SessionKey 签名器只需实现 Signer 接口即可作为 owner，无需改此处
 */
export function signerToOwner(signer: Signer): LocalAccount {
  return toAccount({
    address: signer.address,
    async signMessage({ message }) {
      return signer.signMessage(toRawHex(message));
    },
    async signTransaction() {
      throw new Error('[aa-sdk] Kernel account does not sign raw transactions; use signUserOp');
    },
    async signTypedData() {
      throw new Error('[aa-sdk] use Signer.signUserOp / signMessage instead of typed data');
    },
  });
}

/** SignableMessage → Hex（Kernel 场景恒为 { raw }；其余类型视为不支持） */
function toRawHex(message: SignableMessage): Hex {
  if (typeof message === 'string') {
    throw new Error('[aa-sdk] string message not supported for kernel owner; use raw bytes');
  }
  if ('raw' in message) {
    const raw = message.raw;
    return typeof raw === 'string' ? raw : bytesToHex(raw);
  }
  // { prefix, message } 形式（EIP-191 带 prefix）—— Kernel owner 签名不会走到
  throw new Error('[aa-sdk] prefixed message not supported for kernel owner');
}
