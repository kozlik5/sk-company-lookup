import { Router, Request, Response } from 'express';
import { RuzService } from '../services/RuzService.js';

const router = Router();

/**
 * GET /api/company/:ico
 *
 * Get detailed company info including founding date
 */
router.get('/company/:ico', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const ico = String(req.params.ico || '').trim();

  // Validate IČO format (8 digits)
  if (!/^\d{8}$/.test(ico)) {
    res.status(400).json({
      error: 'invalid_ico',
      message: 'IČO must be exactly 8 digits'
    });
    return;
  }

  try {
    const ruzData = await RuzService.getByIco(ico);

    if (!ruzData) {
      res.status(404).json({
        error: 'not_found',
        message: 'Company not found'
      });
      return;
    }

    // Calculate company age in months
    let ageMonths: number | null = null;
    let foundedDate: string | null = null;

    if (ruzData.datumZalozenia) {
      foundedDate = ruzData.datumZalozenia;
      const founded = new Date(ruzData.datumZalozenia);
      const now = new Date();
      ageMonths = (now.getFullYear() - founded.getFullYear()) * 12 +
                  (now.getMonth() - founded.getMonth());
    }

    res.json({
      ico: ruzData.ico,
      name: ruzData.nazovUJ,
      dic: ruzData.dic,
      legalForm: ruzData.pravnaForma,
      address: {
        street: ruzData.ulica,
        city: ruzData.mesto,
        zip: ruzData.psc
      },
      foundedDate,
      ageMonths,
      isNew: ageMonths !== null && ageMonths < 12,
      timing: Date.now() - startTime
    });
  } catch (error) {
    console.error('[Detail] Error:', error);
    res.status(500).json({
      error: 'fetch_failed',
      message: 'Internal server error'
    });
  }
});

export default router;
