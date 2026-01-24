import https from 'https';
import http from 'http';
import { createWriteStream, createReadStream, existsSync, unlinkSync } from 'fs';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createInterface } from 'readline';
import { getPool, query } from './database.js';

const RPO_DUMP_URL = 'https://s3.eu-central-1.amazonaws.com/ekosystem-slovensko-digital-dumps/rpo.sql.gz';
const TEMP_FILE = '/tmp/rpo.sql.gz';
const TEMP_SQL_FILE = '/tmp/rpo.sql';

export interface ImportResult {
  success: boolean;
  recordCount: number;
  duration: number;
  error?: string;
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

export class ImportService {
  /**
   * Download RPO dump from Slovensko.Digital
   */
  static async downloadDump(url: string = RPO_DUMP_URL): Promise<void> {
    console.log('[Import] Downloading RPO dump...');
    console.log('[Import] URL:', url);

    return new Promise((resolve, reject) => {
      const file = createWriteStream(TEMP_FILE);

      const makeRequest = (requestUrl: string, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'));
          return;
        }

        const protocol = requestUrl.startsWith('https') ? https : http;

        protocol.get(requestUrl, (response) => {
          // Handle redirects
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              console.log('[Import] Redirecting to:', redirectUrl);
              makeRequest(redirectUrl, redirectCount + 1);
              return;
            }
          }

          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
            return;
          }

          const totalSize = parseInt(response.headers['content-length'] || '0', 10);
          let downloadedSize = 0;
          let lastLoggedPercent = 0;

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            const percent = Math.floor((downloadedSize / totalSize) * 100);
            if (percent >= lastLoggedPercent + 10) {
              console.log(`[Import] Downloaded: ${percent}%`);
              lastLoggedPercent = percent;
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            console.log('[Import] Download complete');
            resolve();
          });
        }).on('error', (err) => {
          unlinkSync(TEMP_FILE);
          reject(err);
        });
      };

      makeRequest(url);
    });
  }

  /**
   * Decompress the downloaded dump
   */
  static async decompressDump(): Promise<void> {
    console.log('[Import] Decompressing dump...');
    const source = createReadStream(TEMP_FILE);
    const destination = createWriteStream(TEMP_SQL_FILE);
    const gunzip = createGunzip();

    await pipeline(source, gunzip, destination);
    console.log('[Import] Decompression complete');
  }

  /**
   * Parse SQL dump and extract company data
   * The RPO dump contains several tables, we need:
   * - rpo_legal_subjects (main company info)
   */
  static async parseAndImport(): Promise<number> {
    console.log('[Import] Parsing SQL dump...');

    const pool = getPool();
    let recordCount = 0;
    let batchValues: string[] = [];
    const BATCH_SIZE = 1000;

    // Create temporary staging table
    await query(`
      CREATE TABLE IF NOT EXISTS companies_staging (LIKE companies INCLUDING ALL);
      TRUNCATE companies_staging;
    `);

    const insertBatch = async () => {
      if (batchValues.length === 0) return;

      const sql = `
        INSERT INTO companies_staging (
          ico, dic, ic_dph, name, name_normalized,
          legal_form, street, city, postal_code, country,
          is_active
        ) VALUES ${batchValues.join(',')}
        ON CONFLICT (ico) DO UPDATE SET
          name = EXCLUDED.name,
          name_normalized = EXCLUDED.name_normalized,
          legal_form = EXCLUDED.legal_form,
          street = EXCLUDED.street,
          city = EXCLUDED.city,
          postal_code = EXCLUDED.postal_code,
          is_active = EXCLUDED.is_active
      `;

      await pool.query(sql);
      recordCount += batchValues.length;
      batchValues = [];

      if (recordCount % 10000 === 0) {
        console.log(`[Import] Processed ${recordCount} records...`);
      }
    };

    // Read and parse SQL file line by line
    const fileStream = createReadStream(TEMP_SQL_FILE);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let isInsertingSubjects = false;
    let currentInsertBuffer = '';

    for await (const line of rl) {
      // Detect start of INSERT INTO rpo_legal_subjects
      if (line.includes('INSERT INTO') && line.includes('rpo_legal_subjects')) {
        isInsertingSubjects = true;
        currentInsertBuffer = line;
        continue;
      }

      if (isInsertingSubjects) {
        currentInsertBuffer += line;

        // Check if INSERT statement is complete
        if (line.endsWith(';')) {
          // Parse the INSERT statement
          const parsed = this.parseInsertStatement(currentInsertBuffer);
          for (const company of parsed) {
            if (company.ico && company.name) {
              const escapedValues = this.escapeValues(company);
              batchValues.push(escapedValues);

              if (batchValues.length >= BATCH_SIZE) {
                await insertBatch();
              }
            }
          }
          isInsertingSubjects = false;
          currentInsertBuffer = '';
        }
      }
    }

    // Insert remaining records
    await insertBatch();

    console.log(`[Import] Total records imported: ${recordCount}`);
    return recordCount;
  }

  /**
   * Parse INSERT statement and extract values
   */
  static parseInsertStatement(sql: string): Array<{
    ico: string;
    name: string;
    legalForm: string | null;
    street: string | null;
    city: string | null;
    postalCode: string | null;
    isActive: boolean;
  }> {
    const results: Array<{
      ico: string;
      name: string;
      legalForm: string | null;
      street: string | null;
      city: string | null;
      postalCode: string | null;
      isActive: boolean;
    }> = [];

    // Extract VALUES portion
    const valuesMatch = sql.match(/VALUES\s*(.+);?$/is);
    if (!valuesMatch) return results;

    // Parse individual value groups - this is simplified, real implementation
    // would need proper SQL parsing for escaped strings
    const valuesStr = valuesMatch[1];

    // Split by ),( pattern (simplified)
    const tuples = valuesStr.split(/\),\s*\(/);

    for (const tuple of tuples) {
      const cleaned = tuple.replace(/^\(/, '').replace(/\)$/, '');
      const values = this.splitSqlValues(cleaned);

      // RPO dump structure (approximate column positions):
      // id, ico, business_name, legal_form, ...
      if (values.length >= 4) {
        results.push({
          ico: this.cleanSqlValue(values[1]) || '',
          name: this.cleanSqlValue(values[2]) || '',
          legalForm: this.cleanSqlValue(values[3]),
          street: null,
          city: null,
          postalCode: null,
          isActive: true
        });
      }
    }

    return results;
  }

  /**
   * Split SQL values handling quoted strings
   */
  static splitSqlValues(str: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuote = false;
    let escapeNext = false;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (escapeNext) {
        current += char;
        escapeNext = false;
        continue;
      }

      if (char === '\\' || (char === "'" && str[i + 1] === "'")) {
        escapeNext = true;
        current += char;
        continue;
      }

      if (char === "'") {
        inQuote = !inQuote;
        current += char;
        continue;
      }

      if (char === ',' && !inQuote) {
        values.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }

    values.push(current.trim());
    return values;
  }

  /**
   * Clean SQL value (remove quotes, handle NULL)
   */
  static cleanSqlValue(value: string): string | null {
    if (!value || value === 'NULL') return null;
    // Remove surrounding quotes
    return value.replace(/^'|'$/g, '').replace(/''/g, "'");
  }

  /**
   * Escape values for SQL INSERT
   */
  static escapeValues(company: {
    ico: string;
    name: string;
    legalForm: string | null;
    street: string | null;
    city: string | null;
    postalCode: string | null;
    isActive: boolean;
  }): string {
    const escape = (v: string | null): string => {
      if (v === null) return 'NULL';
      return `'${v.replace(/'/g, "''")}'`;
    };

    const nameNormalized = removeDiacritics(company.name);

    return `(
      ${escape(company.ico)},
      NULL,
      NULL,
      ${escape(company.name)},
      ${escape(nameNormalized)},
      ${escape(company.legalForm)},
      ${escape(company.street)},
      ${escape(company.city)},
      ${escape(company.postalCode)},
      'Slovensko',
      ${company.isActive}
    )`;
  }

  /**
   * Swap staging table with production table
   */
  static async swapTables(): Promise<void> {
    console.log('[Import] Swapping tables...');
    await query(`
      BEGIN;
      DROP TABLE IF EXISTS companies_old;
      ALTER TABLE IF EXISTS companies RENAME TO companies_old;
      ALTER TABLE companies_staging RENAME TO companies;
      DROP TABLE IF EXISTS companies_old;
      COMMIT;
    `);
    console.log('[Import] Tables swapped successfully');
  }

  /**
   * Run full import process
   */
  static async runFullImport(): Promise<ImportResult> {
    const startTime = Date.now();

    try {
      // Download dump
      await this.downloadDump();

      // Decompress
      await this.decompressDump();

      // Parse and import
      const recordCount = await this.parseAndImport();

      // Swap tables
      await this.swapTables();

      // Cleanup temp files
      if (existsSync(TEMP_FILE)) unlinkSync(TEMP_FILE);
      if (existsSync(TEMP_SQL_FILE)) unlinkSync(TEMP_SQL_FILE);

      const duration = Date.now() - startTime;
      console.log(`[Import] Full import completed in ${Math.round(duration / 1000)}s`);

      return {
        success: true,
        recordCount,
        duration
      };
    } catch (error) {
      console.error('[Import] Error:', error);
      return {
        success: false,
        recordCount: 0,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}
