/**
 * RÚZ (Register účtovných závierok) API Service
 *
 * Fetches DIČ and other data from the Slovak Financial Statements Register.
 * API docs: https://www.registeruz.sk/cruz-public/home/api
 */

const RUZ_API_BASE = 'https://www.registeruz.sk/cruz-public/api';

export interface RuzCompanyData {
  id: number;
  ico: string;
  dic: string | null;
  nazovUJ: string;
  ulica: string | null;
  mesto: string | null;
  psc: string | null;
  datumZalozenia: string | null;
  pravnaForma: string | null;
}

/**
 * Simple in-memory cache to avoid hitting API repeatedly
 */
const cache = new Map<string, { data: RuzCompanyData | null; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export class RuzService {
  /**
   * Get company data from RÚZ by IČO
   */
  static async getByIco(ico: string): Promise<RuzCompanyData | null> {
    // Check cache first
    const cached = cache.get(ico);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    try {
      // Step 1: Get internal ID by IČO
      const idResponse = await fetch(
        `${RUZ_API_BASE}/uctovne-jednotky?zmenene-od=2000-01-01&max-zaznamov=1&ico=${ico}`
      );

      if (!idResponse.ok) {
        console.error(`[RUZ] Failed to fetch ID for IČO ${ico}: ${idResponse.status}`);
        return null;
      }

      const idData = await idResponse.json() as { id: number[]; existujeDalsieId: boolean };

      if (!idData.id || idData.id.length === 0) {
        console.log(`[RUZ] No company found for IČO ${ico}`);
        cache.set(ico, { data: null, timestamp: Date.now() });
        return null;
      }

      const internalId = idData.id[0];

      // Step 2: Get full company details
      const detailResponse = await fetch(
        `${RUZ_API_BASE}/uctovna-jednotka?id=${internalId}`
      );

      if (!detailResponse.ok) {
        console.error(`[RUZ] Failed to fetch details for ID ${internalId}: ${detailResponse.status}`);
        return null;
      }

      const detail = await detailResponse.json() as RuzCompanyData;

      // Cache the result
      cache.set(ico, { data: detail, timestamp: Date.now() });

      console.log(`[RUZ] Found DIČ ${detail.dic} for IČO ${ico}`);
      return detail;

    } catch (error) {
      console.error(`[RUZ] Error fetching data for IČO ${ico}:`, error);
      return null;
    }
  }

  /**
   * Get DIČ by IČO
   */
  static async getDic(ico: string): Promise<string | null> {
    const data = await this.getByIco(ico);
    return data?.dic || null;
  }

  /**
   * Get IČ DPH by IČO (SK + DIČ)
   */
  static async getIcDph(ico: string): Promise<string | null> {
    const dic = await this.getDic(ico);
    return dic ? `SK${dic}` : null;
  }

  /**
   * Clear cache (useful for testing)
   */
  static clearCache(): void {
    cache.clear();
  }
}
