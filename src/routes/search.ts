import { Router, Request, Response } from 'express';
import { SearchService } from '../services/SearchService.js';

const router = Router();

/**
 * GET /api/search?q=query
 *
 * Search companies by name or IČO
 *
 * Query params:
 * - q: Search query (required, min 2 chars)
 * - limit: Max results (default 20, max 50)
 * - includeInactive: Include terminated companies (default false)
 */
router.get('/search', async (req: Request, res: Response) => {
  const startTime = Date.now();

  const queryStr = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 20, 1), 50);
  const includeInactive = req.query.includeInactive === 'true';

  // Validation
  if (!queryStr || queryStr.length < 2) {
    res.status(400).json({
      error: 'invalid_query',
      message: 'Query must be at least 2 characters'
    });
    return;
  }

  if (queryStr.length > 100) {
    res.status(400).json({
      error: 'query_too_long',
      message: 'Query must not exceed 100 characters'
    });
    return;
  }

  try {
    const results = await SearchService.search(queryStr, limit, includeInactive);

    res.json({
      results,
      query: queryStr,
      count: results.length,
      timing: Date.now() - startTime
    });
  } catch (error) {
    console.error('[Search] Error:', error);
    res.status(500).json({
      error: 'search_failed',
      message: 'Internal server error'
    });
  }
});

export default router;
