import { Router, Request, Response } from 'express';
import { SearchService } from '../services/SearchService.js';
import { RuzService } from '../services/RuzService.js';
import { RpoService, RpoStakeholder } from '../services/RpoService.js';

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

    // Run all additional lookups in PARALLEL for better performance
    const [ruzData, rpoData, addressCount] = await Promise.all([
      // RÚZ data (founding date, size)
      RuzService.getByIco(paddedIco).catch(() => null),
      // RPO stakeholders
      RpoService.getPersons(paddedIco).catch(() => []),
      // Virtual office detection (includes postal code for precise matching)
      company.address.street && company.address.city
        ? SearchService.countAtAddress(company.address.street, company.address.city, company.address.postalCode ?? undefined).catch(() => 0)
        : Promise.resolve(0)
    ]);

    // Process RÚZ data
    let foundedDate: string | null = null;
    let ageMonths: number | null = null;
    let sizeCode: string | null = null;
    let sizeCategory: string | null = null;
    let employeeRange: string | null = null;

    if (ruzData?.datumZalozenia) {
      foundedDate = ruzData.datumZalozenia;
      const founded = new Date(ruzData.datumZalozenia);
      const now = new Date();
      ageMonths = (now.getFullYear() - founded.getFullYear()) * 12 +
                  (now.getMonth() - founded.getMonth());
    }
    if (ruzData?.velkostOrganizacie) {
      sizeCode = ruzData.velkostOrganizacie;
      const code = parseInt(sizeCode, 10);
      if (code === 0) {
        sizeCategory = 'bez-zamestnancov';
        employeeRange = '0';
      } else if (code === 1) {
        sizeCategory = 'mikro';
        employeeRange = '1-9';
      } else if (code <= 3) {
        sizeCategory = 'mala';
        employeeRange = '10-24';
      } else if (code <= 6) {
        sizeCategory = 'stredna';
        employeeRange = '25-149';
      } else {
        sizeCategory = 'velka';
        employeeRange = '150+';
      }
    }

    const companiesAtAddress = addressCount;
    const isVirtualOffice = companiesAtAddress > 50;
    const stakeholders = rpoData;

    res.json({
      ...company,
      foundedDate,
      ageMonths,
      isNew: ageMonths !== null && ageMonths < 12,
      companiesAtAddress,
      isVirtualOffice,
      sizeCode,
      sizeCategory,
      employeeRange,
      isMicro: sizeCategory === 'mikro' || sizeCategory === 'bez-zamestnancov',
      stakeholders
    });
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
