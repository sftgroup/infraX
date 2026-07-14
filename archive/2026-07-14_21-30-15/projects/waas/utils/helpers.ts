import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

/**
 * Helper: generate UUID v4
 */
export const generateId = (): string => uuidv4();

/**
 * Helper: wrap async route handler to catch errors
 */
export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/**
 * Helper: pagination params from query string
 */
export const paginationParams = (query: any): { offset: number; limit: number } => {
  const page = Math.max(1, parseInt(query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
  return { offset: (page - 1) * limit, limit };
};

/**
 * Helper: sanitize email (lowercase, trim whitespace)
 */
export const sanitizeEmail = (email: string): string => {
  return email.trim().toLowerCase();
};

/**
 * Helper: generate a random numeric code
 */
export const generateCode = (length = 6): string => {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => (b % 10).toString()).join('');
};

/**
 * Standard API response
 */
export const apiResponse = (data: any = null, message = 'success', code = 0) => ({
  code,
  message,
  data,
});

/**
 * Standard paginated response
 */
export const paginatedResponse = (
  items: any[],
  total: number,
  page: number,
  limit: number,
) => ({
  code: 0,
  message: 'success',
  data: {
    items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  },
});
