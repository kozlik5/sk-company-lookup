import { Router, Request, Response } from 'express';
import { SearchService } from '../services/SearchService.js';

const router = Router();

/**
 * GET /api/company/:ico
 *
 * Get full company details by IČO
 */
router.get('/company/:ico', async (req: Request, res: Response) => {
  const { ico } = req.params;

  // Validate IČO format (8 digits, can have leading zeros)
  if (!/^\d{1,8}$/.test(ico)) {
    res.status(400).json({
      error: 'invalid_ico',
      message: 'IČO must be 1-8 digits'
    });
    return;
  }

  // Pad IČO to 8 digits
  const paddedIco = ico.padStart(8, '0');

  try {
    const company = await SearchService.getByIco(paddedIco);

    if (!company) {
      res.status(404).json({
        error: 'not_found',
        message: `Company with IČO ${paddedIco} not found`
      });
      return;
    }

    res.json(company);
  } catch (error) {
    console.error('[Company] Error:', error);
    res.status(500).json({
      error: 'lookup_failed',
      message: 'Internal server error'
    });
  }
});

/**
 * GET /api/stats
 *
 * Get database statistics
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await SearchService.getCount();
    res.json(stats);
  } catch (error) {
    console.error('[Stats] Error:', error);
    res.status(500).json({
      error: 'stats_failed',
      message: 'Internal server error'
    });
  }
});

export default router;
