import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { apiResponse } from '../utils/helpers';

/**
 * General rate limiter
 * Default: 100 requests per minute per IP
 */
export const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: apiResponse(null, 'Too many requests, please try again later', 1001),
});
