import * as crypto from 'crypto';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';

/**
 * W-15: TOTP 2FA（RFC 6238，SHA-1 / 6 位 / 30s 窗口 ±1，node crypto 自实现，零依赖）。
 * 绑定流程：setupTotp 生成 secret → 前端展示 otpauth URL → enableTotp 用 code 激活。
 * 校验：verifyTotp(userId, code)；提现/购买前若用户已启用则必须通过。
 */

/** Base32 编码（RFC 4648，不含 padding） */
function base32Encode(buf: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Base32 解码 */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  const bits: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    for (let i = 4; i >= 0; i--) bits.push((idx >> i) & 1);
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** 生成给定时间步的 TOTP 码 */
function totpAt(secret: Buffer, counter: bigint): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 1000000).padStart(6, '0');
}

const STEP_SECONDS = 30;
const WINDOW = 1; // ±1 步容差（30s 前后）

function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20)); // 160-bit
}

function verifyCode(secretBase32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  const counter = BigInt(Math.floor(Date.now() / 1000 / STEP_SECONDS));
  for (let i = -WINDOW; i <= WINDOW; i++) {
    if (totpAt(secret, counter + BigInt(i)) === code) {
      return true;
    }
  }
  return false;
}

/**
 * 生成 TOTP 绑定材料（secret 落库但未启用；返回 otpauth URI 供扫码）
 */
export async function setupTotp(userId: string, account: string): Promise<{ secret: string; otpauthUrl: string }> {
  const secret = generateSecret();
  await pool.query(
    `INSERT INTO users (id, email, payment_password_hash, totp_secret, totp_enabled)
     VALUES ($1, $2, NULL, $3, false)
     ON CONFLICT (id) DO UPDATE SET totp_secret = EXCLUDED.totp_secret, totp_enabled = false`,
    [userId, account]
  );
  // 若用户已存在则直接更新 secret（上面的 ON CONFLICT 已覆盖）
  await pool.query('UPDATE users SET totp_secret = $1, totp_enabled = false WHERE id = $2', [secret, userId]);
  const otpauthUrl = `otpauth://totp/InfraX:${encodeURIComponent(account)}?secret=${secret}&issuer=InfraX`;
  logger.info('TOTP setup generated', { userId });
  return { secret, otpauthUrl };
}

/** 用验证码激活 TOTP（验证通过后置 enabled） */
export async function enableTotp(userId: string, code: string): Promise<void> {
  const res = await pool.query('SELECT totp_secret FROM users WHERE id = $1', [userId]);
  if (res.rows.length === 0 || !res.rows[0].totp_secret) {
    throw Errors.paramError('TOTP not setup — call /totp/setup first');
  }
  if (!verifyCode(res.rows[0].totp_secret, code)) {
    throw Errors.paramError('Invalid TOTP code');
  }
  await pool.query('UPDATE users SET totp_enabled = true WHERE id = $1', [userId]);
  logger.info('TOTP enabled', { userId });
}

/** 校验（未启用则放行）；启用后验证码错误抛错 */
export async function verifyTotp(userId: string, code?: string): Promise<void> {
  const res = await pool.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [userId]);
  if (res.rows.length === 0) return;
  const { totp_secret, totp_enabled } = res.rows[0];
  if (!totp_enabled) return;
  if (!code) {
    throw Errors.paramError('TOTP code required (2FA enabled)');
  }
  if (!verifyCode(totp_secret, code)) {
    throw Errors.paramError('Invalid TOTP code');
  }
}

/** 禁用 TOTP（需当前有效 code） */
export async function disableTotp(userId: string, code: string): Promise<void> {
  const res = await pool.query('SELECT totp_secret FROM users WHERE id = $1', [userId]);
  if (res.rows.length === 0 || !res.rows[0].totp_secret) {
    throw Errors.paramError('TOTP not enabled');
  }
  if (!verifyCode(res.rows[0].totp_secret, code)) {
    throw Errors.paramError('Invalid TOTP code');
  }
  await pool.query('UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [userId]);
  logger.info('TOTP disabled', { userId });
}
