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
   * Uses temporary database tables to avoid memory issues with large datasets
   */
  static async parseAndImport(): Promise<number> {
    console.log('[Import] Setting up temporary tables in database...');

    const pool = getPool();

    // Create temporary import tables
    await query(`
      DROP TABLE IF EXISTS import_organizations CASCADE;
      DROP TABLE IF EXISTS import_identifiers CASCADE;
      DROP TABLE IF EXISTS import_names CASCADE;
      DROP TABLE IF EXISTS import_addresses CASCADE;
      DROP TABLE IF EXISTS import_legal_form_entries CASCADE;
      DROP TABLE IF EXISTS import_legal_forms CASCADE;
      DROP TABLE IF EXISTS companies_staging CASCADE;

      CREATE TABLE import_organizations (
        id INTEGER PRIMARY KEY,
        terminated_on DATE
      );

      CREATE TABLE import_identifiers (
        organization_id INTEGER,
        ico VARCHAR(20),
        effective_to DATE
      );

      CREATE TABLE import_names (
        organization_id INTEGER,
        name TEXT,
        effective_to DATE
      );

      CREATE TABLE import_addresses (
        organization_id INTEGER,
        street TEXT,
        city TEXT,
        postal_code VARCHAR(20),
        effective_to DATE
      );

      CREATE TABLE import_legal_form_entries (
        organization_id INTEGER,
        legal_form_id INTEGER,
        effective_to DATE
      );

      CREATE TABLE import_legal_forms (
        id INTEGER PRIMARY KEY,
        name VARCHAR(200)
      );
    `);

    // Read and stream data to database
    const fileStream = createReadStream(TEMP_SQL_FILE);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let currentTable: string | null = null;
    let batchValues: string[] = [];
    let targetTable: string | null = null;
    let insertColumns: string = '';
    const BATCH_SIZE = 5000;

    const insertBatch = async () => {
      if (batchValues.length === 0 || !targetTable) return;

      const sql = `INSERT INTO ${targetTable} (${insertColumns}) VALUES ${batchValues.join(',')}`;
      try {
        await pool.query(sql);
      } catch (e) {
        console.error(`[Import] Error inserting into ${targetTable}:`, e);
      }
      batchValues = [];
    };

    console.log('[Import] Streaming data to temporary tables...');
    let lineCount = 0;

    for await (const line of rl) {
      // Detect COPY statement
      if (line.startsWith('COPY rpo.')) {
        await insertBatch(); // Flush previous batch

        const match = line.match(/COPY rpo\.(\w+)/);
        currentTable = match ? match[1] : null;

        // Map source tables to import tables
        if (currentTable === 'organizations') {
          targetTable = 'import_organizations';
          insertColumns = 'id, terminated_on';
        } else if (currentTable === 'organization_identifier_entries') {
          targetTable = 'import_identifiers';
          insertColumns = 'organization_id, ico, effective_to';
        } else if (currentTable === 'organization_name_entries') {
          targetTable = 'import_names';
          insertColumns = 'organization_id, name, effective_to';
        } else if (currentTable === 'organization_address_entries') {
          targetTable = 'import_addresses';
          insertColumns = 'organization_id, street, city, postal_code, effective_to';
        } else if (currentTable === 'organization_legal_form_entries') {
          targetTable = 'import_legal_form_entries';
          insertColumns = 'organization_id, legal_form_id, effective_to';
        } else if (currentTable === 'legal_forms') {
          targetTable = 'import_legal_forms';
          insertColumns = 'id, name';
        } else {
          targetTable = null;
        }
        continue;
      }

      // End of COPY data
      if (line === '\\.' || line.startsWith('--')) {
        await insertBatch();
        currentTable = null;
        targetTable = null;
        continue;
      }

      // Parse and buffer COPY data
      if (currentTable && targetTable && line.length > 0) {
        const fields = line.split('\t');
        let values: string | null = null;

        const esc = (v: string): string => {
          if (v === '\\N') return 'NULL';
          return `'${v.replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
        };

        switch (currentTable) {
          case 'organizations':
            values = `(${fields[0]}, ${fields[2] === '\\N' ? 'NULL' : esc(fields[2])})`;
            break;
          case 'organization_identifier_entries':
            // organization_id, ico, effective_to
            values = `(${fields[1]}, ${esc(fields[2])}, ${fields[4] === '\\N' ? 'NULL' : esc(fields[4])})`;
            break;
          case 'organization_name_entries':
            // organization_id, name, effective_to
            values = `(${fields[1]}, ${esc(fields[2])}, ${fields[4] === '\\N' ? 'NULL' : esc(fields[4])})`;
            break;
          case 'organization_address_entries':
            // organization_id, street, city, postal_code, effective_to
            values = `(${fields[1]}, ${esc(fields[3])}, ${esc(fields[7])}, ${esc(fields[6])}, ${fields[10] === '\\N' ? 'NULL' : esc(fields[10])})`;
            break;
          case 'organization_legal_form_entries':
            // organization_id, legal_form_id, effective_to
            values = `(${fields[1]}, ${fields[2]}, ${fields[4] === '\\N' ? 'NULL' : esc(fields[4])})`;
            break;
          case 'legal_forms':
            values = `(${fields[0]}, ${esc(fields[1])})`;
            break;
        }

        if (values) {
          batchValues.push(values);
          if (batchValues.length >= BATCH_SIZE) {
            await insertBatch();
          }
        }

        lineCount++;
        if (lineCount % 500000 === 0) {
          console.log(`[Import] Processed ${lineCount} lines...`);
        }
      }
    }

    await insertBatch();
    console.log(`[Import] Streamed ${lineCount} lines to temporary tables`);

    // Create indexes on temporary tables
    console.log('[Import] Creating indexes...');
    await query(`
      CREATE INDEX idx_import_identifiers_org ON import_identifiers(organization_id);
      CREATE INDEX idx_import_names_org ON import_names(organization_id);
      CREATE INDEX idx_import_addresses_org ON import_addresses(organization_id);
      CREATE INDEX idx_import_legal_form_entries_org ON import_legal_form_entries(organization_id);
    `);

    // Now join tables and create companies
    console.log('[Import] Joining tables and creating companies...');

    await query(`
      CREATE TABLE companies_staging (
        id SERIAL PRIMARY KEY,
        ico VARCHAR(20) NOT NULL UNIQUE,
        dic VARCHAR(20),
        ic_dph VARCHAR(20),
        name TEXT NOT NULL,
        name_normalized TEXT NOT NULL,
        legal_form TEXT,
        street TEXT,
        city TEXT,
        postal_code VARCHAR(20),
        country VARCHAR(50) DEFAULT 'Slovensko',
        is_active BOOLEAN DEFAULT true,
        imported_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const insertResult = await query(`
      INSERT INTO companies_staging (
        ico, dic, ic_dph, name, name_normalized,
        legal_form, street, city, postal_code, country,
        is_active
      )
      SELECT DISTINCT ON (i.ico)
        i.ico,
        NULL as dic,
        NULL as ic_dph,
        n.name,
        LOWER(TRANSLATE(n.name, 'áäčďéěíľĺňóôöŕřšťúůüýžÁÄČĎÉĚÍĽĹŇÓÔÖŔŘŠŤÚŮÜÝŽ', 'aacdeeilnooorrstuuuyzAACDEEILLNOOORRSTUUUYZ')) as name_normalized,
        lf.name as legal_form,
        a.street,
        a.city,
        a.postal_code,
        'Slovensko' as country,
        (o.terminated_on IS NULL) as is_active
      FROM import_identifiers i
      JOIN import_names n ON n.organization_id = i.organization_id AND n.effective_to IS NULL
      LEFT JOIN import_organizations o ON o.id = i.organization_id
      LEFT JOIN import_addresses a ON a.organization_id = i.organization_id AND a.effective_to IS NULL
      LEFT JOIN import_legal_form_entries lfe ON lfe.organization_id = i.organization_id AND lfe.effective_to IS NULL
      LEFT JOIN import_legal_forms lf ON lf.id = lfe.legal_form_id
      WHERE i.effective_to IS NULL
        AND i.ico IS NOT NULL
        AND n.name IS NOT NULL
      ORDER BY i.ico, n.name
    `);

    const recordCount = insertResult.rowCount || 0;
    console.log(`[Import] Inserted ${recordCount} companies`);

    // Create unique index on staging
    await query(`
      CREATE UNIQUE INDEX idx_staging_ico ON companies_staging(ico);
    `);

    // Cleanup temporary tables
    console.log('[Import] Cleaning up temporary tables...');
    await query(`
      DROP TABLE IF EXISTS import_organizations CASCADE;
      DROP TABLE IF EXISTS import_identifiers CASCADE;
      DROP TABLE IF EXISTS import_names CASCADE;
      DROP TABLE IF EXISTS import_addresses CASCADE;
      DROP TABLE IF EXISTS import_legal_form_entries CASCADE;
      DROP TABLE IF EXISTS import_legal_forms CASCADE;
    `);

    return recordCount;
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
      DROP TABLE IF EXISTS companies_old CASCADE;
      ALTER TABLE IF EXISTS companies RENAME TO companies_old;
      ALTER TABLE companies_staging RENAME TO companies;
      DROP TABLE IF EXISTS companies_old CASCADE;
    `);

    // Recreate indexes on new table
    await query(`
      CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON companies USING GIN (name_normalized gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_companies_ico ON companies (ico text_pattern_ops);
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
