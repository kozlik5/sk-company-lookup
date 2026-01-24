import express, { Application, Request, Response, NextFunction } from 'express';
import { corsMiddleware } from './middleware/cors.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import searchRouter from './routes/search.js';
import companyRouter from './routes/company.js';
import adminRouter from './routes/admin.js';

export function createServer(): Application {
  const app = express();

  // Trust proxy for rate limiting behind reverse proxy
  app.set('trust proxy', 1);

  // Middleware
  app.use(express.json({ limit: '1mb' }));
  app.use(corsMiddleware);

  // Health check (no rate limit)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API routes with rate limiting
  app.use('/api', rateLimiter(60, 60000)); // 60 req/min
  app.use('/api', searchRouter);
  app.use('/api', companyRouter);

  // Admin routes (stricter rate limit)
  app.use('/admin', rateLimiter(10, 60000)); // 10 req/min
  app.use('/admin', adminRouter);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', message: 'Endpoint not found' });
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Error]', err);
    res.status(500).json({
      error: 'internal_error',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
    });
  });

  return app;
}
