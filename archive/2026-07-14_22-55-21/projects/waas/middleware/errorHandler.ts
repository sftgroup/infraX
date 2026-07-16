import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { apiResponse } from '../utils/helpers';

/**
 * Global error handler — catches AppError and unknown errors
 * Returns standardized { code, message, data } format
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    // 400 = user error, 500 = my error
    const statusCode = err.statusCode;
    logger.warn('Operational error', {
      code: err.code,
      message: err.message,
      statusCode,
    });
    res.status(statusCode).json(apiResponse(null, err.message, err.code));
    return;
  }

  // Unknown / unhandled error — log full stack, return generic 500
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
  });
  res.status(500).json(apiResponse(null, 'Internal server error', 5000));
}

/**
 * 404 handler for unmatched routes
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json(apiResponse(null, 'Route not found', 1001));
}
