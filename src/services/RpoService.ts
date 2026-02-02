/**
 * RPO (Register právnických osôb) API Service
 *
 * Fetches connected persons/companies from the Slovak Business Registry.
 * API docs: https://susrrro.docs.apiary.io/
 */

const RPO_API_BASE = 'https://api.statistics.sk/rpo/v1';

export interface RpoStakeholder {
  personName: string | null;
  companyName: string | null;
  ico: string | null;
  role: string;
  validFrom: string | null;
  validTo: string | null;
}

export interface RpoCompanyData {
  id: number;
  ico: string;
  name: string;
  stakeholders: RpoStakeholder[];
}

/**
 * Simple in-memory cache to avoid hitting API repeatedly
 */
const cache = new Map<string, { data: RpoCompanyData | null; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export class RpoService {
  /**
   * Get company data including stakeholders from RPO by IČO
   */
  static async getByIco(ico: string): Promise<RpoCompanyData | null> {
    // Check cache first
    const cached = cache.get(ico);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    try {
      // Step 1: Search for entity by IČO (parameter name is "identifier")
      const searchResponse = await fetch(
        `${RPO_API_BASE}/search?identifier=${ico}`
      );

      if (!searchResponse.ok) {
        console.error(`[RPO] Failed to search for IČO ${ico}: ${searchResponse.status}`);
        return null;
      }

      const searchData = await searchResponse.json() as {
        results?: Array<{
          id: number;
          fullNames?: Array<{ value: string; validFrom: string; validTo?: string }>;
        }>;
      };

      if (!searchData.results || searchData.results.length === 0) {
        console.log(`[RPO] No company found for IČO ${ico}`);
        cache.set(ico, { data: null, timestamp: Date.now() });
        return null;
      }

      const entityId = searchData.results[0].id;
      // Get current (latest) company name
      const fullNames = searchData.results[0].fullNames || [];
      const currentName = fullNames.find(n => !n.validTo) || fullNames[fullNames.length - 1];
      const companyName = currentName?.value || 'Neznámy názov';

      // Step 2: Get full entity details including stakeholders
      const detailResponse = await fetch(
        `${RPO_API_BASE}/entity/${entityId}?showOrganizationUnits=true`
      );

      if (!detailResponse.ok) {
        console.error(`[RPO] Failed to fetch details for ID ${entityId}: ${detailResponse.status}`);
        return null;
      }

      interface ApiStakeholder {
        personName?: {
          formatedName?: string;
          givenNames?: string[];
          familyNames?: string[];
        };
        companyName?: {
          value?: string;
        };
        companyIdentifier?: string;
        stakeholderType?: {
          value?: string;
        };
        validFrom?: string;
        validTo?: string;
      }

      const detail = await detailResponse.json() as {
        id: number;
        organizationUnits?: Array<{
          stakeholders?: ApiStakeholder[];
        }>;
        stakeholders?: ApiStakeholder[];
      };

      // Extract stakeholders from response
      const stakeholders: RpoStakeholder[] = [];

      const parseStakeholder = (s: ApiStakeholder): RpoStakeholder => {
        let personName: string | null = null;
        if (s.personName?.formatedName) {
          personName = s.personName.formatedName;
        } else if (s.personName?.givenNames && s.personName?.familyNames) {
          personName = `${s.personName.givenNames.join(' ')} ${s.personName.familyNames.join(' ')}`;
        }

        return {
          personName,
          companyName: s.companyName?.value || null,
          ico: s.companyIdentifier || null,
          role: s.stakeholderType?.value || 'Neznáma funkcia',
          validFrom: s.validFrom || null,
          validTo: s.validTo || null,
        };
      };

      // Direct stakeholders
      if (detail.stakeholders) {
        for (const s of detail.stakeholders) {
          stakeholders.push(parseStakeholder(s));
        }
      }

      // Stakeholders from organizational units
      if (detail.organizationUnits) {
        for (const unit of detail.organizationUnits) {
          if (unit.stakeholders) {
            for (const s of unit.stakeholders) {
              const parsed = parseStakeholder(s);

              // Skip duplicates
              const exists = stakeholders.some(
                existing =>
                  existing.personName === parsed.personName &&
                  existing.companyName === parsed.companyName &&
                  existing.role === parsed.role
              );

              if (!exists) {
                stakeholders.push(parsed);
              }
            }
          }
        }
      }

      const result: RpoCompanyData = {
        id: detail.id,
        ico,
        name: companyName,
        stakeholders,
      };

      // Cache the result
      cache.set(ico, { data: result, timestamp: Date.now() });

      console.log(`[RPO] Found ${stakeholders.length} stakeholders for IČO ${ico}`);
      return result;

    } catch (error) {
      console.error(`[RPO] Error fetching data for IČO ${ico}:`, error);
      return null;
    }
  }

  /**
   * Get all active stakeholders (persons only) for a company
   */
  static async getPersons(ico: string): Promise<RpoStakeholder[]> {
    const data = await this.getByIco(ico);
    if (!data) {
      return [];
    }

    // Filter only active persons (no validTo or validTo in future)
    const now = new Date().toISOString().split('T')[0];
    return data.stakeholders.filter(s =>
      s.personName && (!s.validTo || s.validTo > now)
    );
  }

  /**
   * Clear cache (useful for testing)
   */
  static clearCache(): void {
    cache.clear();
  }
}
