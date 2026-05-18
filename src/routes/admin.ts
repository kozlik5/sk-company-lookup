import { Router, Request, Response, NextFunction } from 'express';
import { ImportService } from '../services/ImportService.js';
import { WeeklyDigestService } from '../services/WeeklyDigestService.js';
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

/**
 * POST /admin/weekly-pulse
 *
 * Synchronous "import then digest" pipeline. Triggered by the local
 * launchd cron once a week — runs the full RPO import (which appends
 * any new ICOs to seen_icos), then returns the digest payload so the
 * cron wrapper can format and post to Telegram.
 *
 * Body:
 *   skipImport: boolean = false   useful for manual re-runs / debugging
 *   windowDays: number  = 7       digest lookback window
 *
 * Response time: ~5–15 min when skipImport=false (full RPO refresh).
 * Caller MUST set a long curl --max-time (1800s recommended).
 */
router.post('/weekly-pulse', async (req: Request, res: Response) => {
  const { skipImport = false, windowDays = 7 } = req.body || {};
  const jobId = crypto.randomUUID();

  console.log(`[Admin] Weekly pulse ${jobId} (skipImport=${skipImport}, windowDays=${windowDays})`);

  try {
    let importResult: { success: boolean; recordCount: number; duration: number; error?: string } | null = null;

    if (!skipImport) {
      importResult = await ImportService.runFullImport();
      if (!importResult.success) {
        res.status(500).json({
          status: 'error',
          stage: 'import',
          jobId,
          importResult,
        });
        return;
      }
    }

    const digest = await WeeklyDigestService.run(windowDays);

    res.json({
      status: 'ok',
      jobId,
      importResult,
      digest,
    });
  } catch (err) {
    console.error(`[Admin] Weekly pulse ${jobId} failed:`, err);
    res.status(500).json({
      status: 'error',
      jobId,
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /admin/weekly-digest
 *
 * Digest-only (no import). Cheap, fast. Useful when you want to
 * inspect the current state of seen_icos without re-running the
 * 5–15 minute import.
 */
router.post('/weekly-digest', async (req: Request, res: Response) => {
  const { windowDays = 7 } = req.body || {};
  try {
    const digest = await WeeklyDigestService.run(windowDays);
    res.json({ status: 'ok', digest });
  } catch (err) {
    console.error('[Admin] Weekly digest failed:', err);
    res.status(500).json({
      status: 'error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

export default router;
