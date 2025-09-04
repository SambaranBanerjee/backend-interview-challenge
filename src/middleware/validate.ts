import { Request, Response, NextFunction } from 'express';
import { ZodError, ZodSchema } from 'zod';

export const validate =
  (schema: ZodSchema<unknown>, type: 'body' | 'query' | 'params' = 'body') =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req[type]);
      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: err.issues.map(e => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
      }

      return res.status(400).json({
        error: 'Validation failed',
        details: [{ message: 'Invalid request' }],
      });
    }
  };
