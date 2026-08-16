/**
 * 共享的常量时间字符串比较工具（timing-safe）。
 *
 * 统一实现：先 SHA-256 归一化为定长摘要再 timingSafeEqual——不泄露输入长度，
 * 对长度不同的输入判定结果与"长度短路 + 逐字节比较"一致（哈希碰撞可忽略）。
 * 此前 auth.ts / rpcSubscriptionRoutes.ts / ws.ts 各持一份不同实现，收敛于此。
 */
import crypto from 'crypto';

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
