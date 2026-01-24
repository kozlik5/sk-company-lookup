import { Router, Request, Response, NextFunction } from 'express';
import { ImportService } from '../services/ImportService.js';
import crypto from 'crypto';

const router = Router();

/**
 * Admin authentication middleware
 */
function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-admin-key'];
  const validKey = process.env.ADMIN_API_KEY;

  if (!validKey) {
    console.error('[Admin] ADMIN_API_KEY not configured');
    res.status(503).json({
      error: 'service_unavailable',
      message: 'Admin API not configured'
    });
    return;
  }

  if (!apiKey || apiKey !== validKey) {
    res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid or missing admin API key'
    });
    return;
  }

  next();
}

// Apply admin auth to all routes
router.use(adminAuth);

/**
 * POST /admin/import
 *
 * Trigger data import
 *
 * Body:
 * - mode: "full" | "test" (default: test)
 */
router.post('/import', async (req: Request, res: Response) => {
  const { mode = 'test' } = req.body || {};
  const jobId = crypto.randomUUID();

  console.log(`[Admin] Import requested - mode: ${mode}, jobId: ${jobId}`);

  if (mode === 'full') {
    // Full import is long-running, start in background
    res.json({
      status: 'started',
      message: 'Full import started. This may take 10-30 minutes.',
      jobId
    });

    // Run in background
    ImportService.runFullImport()
      .then(result => {
        console.log(`[Admin] Import ${jobId} completed:`, result);
      })
      .catch(err => {
        console.error(`[Admin] Import ${jobId} failed:`, err);
      });
  } else {
    // Test mode - just verify connectivity
    res.json({
      status: 'ok',
      message: 'Test mode - no import performed',
      jobId,
      hint: 'Use mode: "full" to run actual import'
    });
  }
});

/**
 * GET /admin/status
 *
 * Get system status
 */
router.get('/status', async (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

export default router;
