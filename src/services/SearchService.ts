import { query } from './database.js';

export interface CompanySearchResult {
  ico: string;
  name: string;
  legalForm: string | null;
  city: string | null;
  isActive: boolean;
}

export interface CompanyDetails {
  ico: string;
  dic: string | null;
  icDph: string | null;
  name: string;
  legalForm: string | null;
  address: {
    street: string | null;
    city: string | null;
    postalCode: string | null;
    country: string;
  };
  isActive: boolean;
  establishedDate: string | null;
}

/**
 * Remove Slovak diacritics for normalized search
 */
function removeDiacritics(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Escape special characters for ILIKE query
 */
function escapeIlike(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

export class SearchService {
  /**
   * Search companies by name or IČO
   */
  static async search(
    searchQuery: string,
    limit: number = 20,
    includeInactive: boolean = false
  ): Promise<CompanySearchResult[]> {
    const normalizedQuery = removeDiacritics(searchQuery.trim());
    const escapedQuery = escapeIlike(normalizedQuery);

    // Check if query looks like IČO (all digits)
    const isIcoSearch = /^\d+$/.test(searchQuery.trim());

    let sql: string;
    let params: unknown[];

    if (isIcoSearch) {
      // IČO search - exact or prefix match
      sql = `
        SELECT
          ico,
          name,
          legal_form as "legalForm",
          city,
          is_active as "isActive"
        FROM companies
        WHERE ico LIKE $1
        ${includeInactive ? '' : 'AND is_active = true'}
        ORDER BY
          CASE WHEN ico = $2 THEN 0 ELSE 1 END,
          ico
        LIMIT $3
      `;
      params = [`${searchQuery.trim()}%`, searchQuery.trim(), limit];
    } else {
      // Name search - use trigram similarity + prefix match
      sql = `
        SELECT
          ico,
          name,
          legal_form as "legalForm",
          city,
          is_active as "isActive"
        FROM companies
        WHERE (
          name_normalized LIKE $1
          OR name_normalized % $2
          OR name_normalized ILIKE $3
        )
        ${includeInactive ? '' : 'AND is_active = true'}
        ORDER BY
          CASE
            WHEN name_normalized = $2 THEN 0
            WHEN name_normalized LIKE $1 THEN 1
            ELSE 2
          END,
          similarity(name_normalized, $2) DESC,
          name
        LIMIT $4
      `;
      params = [`${escapedQuery}%`, normalizedQuery, `%${escapedQuery}%`, limit];
    }

    const result = await query<{
      ico: string;
      name: string;
      legalForm: string | null;
      city: string | null;
      isActive: boolean;
    }>(sql, params);

    return result.rows;
  }

  /**
   * Get company details by IČO
   */
  static async getByIco(ico: string): Promise<CompanyDetails | null> {
    const result = await query<{
      ico: string;
      dic: string | null;
      ic_dph: string | null;
      name: string;
      legal_form: string | null;
      street: string | null;
      city: string | null;
      postal_code: string | null;
      country: string;
      is_active: boolean;
      established_date: Date | null;
    }>(
      `
      SELECT
        ico,
        dic,
        ic_dph,
        name,
        legal_form,
        street,
        city,
        postal_code,
        country,
        is_active,
        established_date
      FROM companies
      WHERE ico = $1
      `,
      [ico]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      ico: row.ico,
      dic: row.dic,
      icDph: row.ic_dph,
      name: row.name,
      legalForm: row.legal_form,
      address: {
        street: row.street,
        city: row.city,
        postalCode: row.postal_code,
        country: row.country
      },
      isActive: row.is_active,
      establishedDate: row.established_date?.toISOString().split('T')[0] || null
    };
  }

  /**
   * Get total count of companies
   */
  static async getCount(): Promise<{ total: number; active: number }> {
    const result = await query<{ total: string; active: string }>(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_active = true) as active
      FROM companies
    `);

    return {
      total: parseInt(result.rows[0].total, 10),
      active: parseInt(result.rows[0].active, 10)
    };
  }
}
