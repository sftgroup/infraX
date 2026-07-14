import bcrypt from 'bcryptjs';
import { pool } from '../models/database';
import { Errors } from '../utils/errors';

/**
 * Auth service — wallet-signature based. Only payment password management.
 */

/**
 * Verify payment password (FR-TX-01)
 */
export async function verifyPaymentPassword(userId: string, password: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT payment_password_hash FROM users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    throw Errors.notFound('User');
  }

  const hash: string | null = result.rows[0].payment_password_hash;
  if (!hash) {
    throw Errors.paramError('Payment password not set');
  }

  const valid = await bcrypt.compare(password, hash);
  if (!valid) {
    throw Errors.paymentPasswordError();
  }
  return true;
}

/**
 * Set or change payment password
 */
export async function setPaymentPassword(
  userId: string,
  newPassword: string,
  oldPassword?: string
): Promise<void> {
  if (!newPassword || !/^\d{6}$/.test(newPassword)) {
    throw Errors.paramError('Payment password must be exactly 6 digits');
  }

  const result = await pool.query(
    'SELECT payment_password_hash FROM users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    throw Errors.notFound('User');
  }

  const currentHash: string | null = result.rows[0].payment_password_hash;

  // If changing existing password, verify old one
  if (currentHash && oldPassword) {
    const valid = await bcrypt.compare(oldPassword, currentHash);
    if (!valid) {
      throw Errors.paymentPasswordError();
    }
  }

  const salt = await bcrypt.genSalt(12);
  const newHash = await bcrypt.hash(newPassword, salt);

  await pool.query(
    'UPDATE users SET payment_password_hash = $1 WHERE id = $2',
    [newHash, userId]
  );
}

/**
 * Check if user has set a payment password
 */
export async function hasPaymentPassword(userId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT payment_password_hash FROM users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    throw Errors.notFound('User');
  }

  return result.rows[0].payment_password_hash !== null;
}
