import { Request, Response, NextFunction } from 'express';

/** Async wrapper for Express routes */
export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/** Uniform API response */
export const apiResponse = (data: any = null, message = 'success', code = 0) =>
  ({ code, message, data });
