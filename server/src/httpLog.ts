import type { NextFunction, Request, Response } from 'express';

/**
 * Logs each request when it finishes: method, URL, status, duration, client IP.
 * Set `HTTP_LOG=0` or `HTTP_LOG=false` to disable.
 * `GET /health` is skipped to avoid log spam from probes.
 */
export function httpRequestLogger(enabled: boolean): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) {
      next();
      return;
    }
    const pathOnly = req.originalUrl.split('?')[0] ?? '';
    if (req.method === 'GET' && pathOnly === '/health') {
      next();
      return;
    }

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const ip = req.socket.remoteAddress ?? '';
      // eslint-disable-next-line no-console
      console.log(`[http] ${req.method} ${req.originalUrl} → ${res.statusCode} ${ms.toFixed(0)}ms ${ip}`);
    });
    next();
  };
}
