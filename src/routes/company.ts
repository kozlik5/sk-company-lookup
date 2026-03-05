import { Router, Request, Response } from 'express';
import { SearchService } from '../services/SearchService.js';
import { RuzService } from '../services/RuzService.js';
import { RpoService, RpoStakeholder } from '../services/RpoService.js';
import { query } from '../services/database.js';

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
    // RPO full data
    const rpoFull = await RpoService.getByIco(paddedIco).catch(() => null);
    const stakeholders = rpoData; // active persons from getPersons()
    const statutoryBodies = rpoFull?.statutoryBodies || [];
    const skNace = rpoFull?.skNace || null;
    const activities = rpoFull?.activities || [];

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
      stakeholders,
      statutoryBodies,
      skNace,
      activities,
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
 * GET /api/company-basic/:ico
 *
 * Ultra-fast company lookup — LOCAL DB ONLY, zero external API calls.
 * Returns: name, isActive, address, virtual office check, isMicro flag.
 * Typical response time: <100ms.
 * Designed for trust-api DeepScan where speed is critical.
 */
router.get('/company-basic/:ico', async (req: Request, res: Response) => {
  const { ico } = req.params;

  if (!/^\d{1,8}$/.test(ico)) {
    res.status(400).json({ error: 'invalid_ico', message: 'IČO must be 1-8 digits' });
    return;
  }

  const paddedIco = ico.padStart(8, '0');

  try {
    // Direct DB query — no external API calls at all
    const result = await query<{
      ico: string;
      name: string;
      legal_form: string | null;
      street: string | null;
      city: string | null;
      postal_code: string | null;
      country: string;
      is_active: boolean;
    }>(
      `SELECT ico, name, legal_form, street, city, postal_code, country, is_active
       FROM companies WHERE ico = $1`,
      [paddedIco]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'not_found', message: `Company with IČO ${paddedIco} not found` });
      return;
    }

    const row = result.rows[0];

    // Virtual office check — also local DB only
    let addressCount = 0;
    if (row.street && row.city) {
      const countResult = row.postal_code
        ? await query<{ count: string }>(
            `SELECT COUNT(*) as count FROM companies
             WHERE LOWER(TRIM(street)) = LOWER(TRIM($1))
             AND LOWER(TRIM(city)) = LOWER(TRIM($2))
             AND LOWER(TRIM(postal_code)) = LOWER(TRIM($3))
             AND is_active = true`,
            [row.street.trim(), row.city.trim(), row.postal_code.trim()]
          )
        : await query<{ count: string }>(
            `SELECT COUNT(*) as count FROM companies
             WHERE LOWER(TRIM(street)) = LOWER(TRIM($1))
             AND LOWER(TRIM(city)) = LOWER(TRIM($2))
             AND is_active = true`,
            [row.street.trim(), row.city.trim()]
          );
      addressCount = parseInt(countResult.rows[0].count, 10);
    }

    res.json({
      ico: row.ico,
      name: row.name,
      legalForm: row.legal_form,
      address: {
        street: row.street,
        city: row.city,
        postalCode: row.postal_code,
        country: row.country,
      },
      isActive: row.is_active,
      companiesAtAddress: addressCount,
      isVirtualOffice: addressCount > 50,
      isMicro: null,
      isNew: null,
      foundedDate: null,
      ageMonths: null,
    });
  } catch (error) {
    console.error('[CompanyBasic] Error:', error);
    res.status(500).json({ error: 'lookup_failed', message: 'Internal server error' });
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
