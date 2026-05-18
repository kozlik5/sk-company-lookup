import https from 'https';
import http from 'http';
import { createWriteStream, createReadStream, existsSync, unlinkSync } from 'fs';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import type pg from 'pg';
import { getPool, query } from './database.js';

const RPO_DUMP_URL = 'https://s3.eu-central-1.amazonaws.com/ekosystem-slovensko-digital-dumps/rpo.sql.gz';
const DATA_DIR = process.env.DATA_DIR || '/tmp';
const TEMP_FILE = `${DATA_DIR}/rpo.sql.gz`;
const TEMP_SQL_FILE = `${DATA_DIR}/rpo.sql`;

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
   * Run a heavy SQL block on a dedicated client with statement_timeout disabled.
   * Wraps the work in BEGIN..COMMIT so SET LOCAL applies through the whole block,
   * even when the connection goes through Supabase's transaction-mode pooler.
   * Multi-statement text is supported (semicolons inside the block).
   */
  static async runWithoutTimeout(text: string): Promise<pg.QueryResult> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = 0");
      const result = await client.query(text);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

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
    console.log('[Import] Decompressing dump (using system gunzip for low memory usage)...');
    try {
      // Use system gunzip — much lower memory than Node zlib streams for large files
      execSync(`gunzip -c "${TEMP_FILE}" > "${TEMP_SQL_FILE}"`, {
        stdio: 'inherit',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // Fallback to Node streams if gunzip not available
      console.log('[Import] System gunzip failed, falling back to Node zlib...');
      const source = createReadStream(TEMP_FILE);
      const destination = createWriteStream(TEMP_SQL_FILE);
      const gunzip = createGunzip();
      await pipeline(source, gunzip, destination);
    }
    // Remove compressed file to free disk space before parsing
    if (existsSync(TEMP_FILE)) unlinkSync(TEMP_FILE);
    console.log('[Import] Decompression complete, .gz removed');
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
      DROP TABLE IF EXISTS import_economic_activities CASCADE;
      DROP TABLE IF EXISTS import_main_activities CASCADE;
      DROP TABLE IF EXISTS companies_staging CASCADE;

      CREATE TABLE import_organizations (
        id INTEGER PRIMARY KEY,
        terminated_on DATE,
        main_activity_code_id INTEGER
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

      CREATE TABLE import_economic_activities (
        organization_id INTEGER,
        description TEXT,
        effective_to DATE
      );

      CREATE TABLE import_main_activities (
        id INTEGER PRIMARY KEY,
        name TEXT
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
          insertColumns = 'id, terminated_on, main_activity_code_id';
        } else if (currentTable === 'main_activity_codes') {
          targetTable = 'import_main_activities';
          insertColumns = 'id, name';
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
        } else if (
          currentTable === 'organization_economic_activity_entries' ||
          currentTable === 'economic_activity_entries' ||
          currentTable === 'organization_economic_activities'
        ) {
          targetTable = 'import_economic_activities';
          insertColumns = 'organization_id, description, effective_to';
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
            // [0]=id, [2]=terminated_on, [9]=main_activity_code_id (FK -> main_activity_codes.id)
            values = `(${fields[0]}, ${fields[2] === '\\N' ? 'NULL' : esc(fields[2])}, ${fields[9] === '\\N' || fields[9] === undefined ? 'NULL' : fields[9]})`;
            break;
          case 'main_activity_codes':
            values = `(${fields[0]}, ${esc(fields[1])})`;
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
            // organization_id, street (with building number), city, postal_code, effective_to
            // RPO schema: [3]=street, [4]=reg_number (orientačné, INT), [5]=building_number (súpisné, VARCHAR)
            // [6]=postal_code, [7]=municipality, ... [10]=effective_to
            {
              const streetName = fields[3] === '\\N' ? '' : fields[3];
              const regNum = fields[4] === '\\N' || fields[4] === '0' ? '' : fields[4];
              const buildNum = fields[5] === '\\N' ? '' : fields[5];
              let fullStreet = streetName;
              if (regNum && buildNum) {
                fullStreet = `${streetName} ${regNum}/${buildNum}`;
              } else if (buildNum) {
                fullStreet = `${streetName} ${buildNum}`;
              } else if (regNum) {
                fullStreet = `${streetName} ${regNum}`;
              }
              values = `(${fields[1]}, ${esc(fullStreet.trim())}, ${esc(fields[7])}, ${esc(fields[6])}, ${fields[10] === '\\N' ? 'NULL' : esc(fields[10])})`;
            }
            break;
          case 'organization_legal_form_entries':
            // organization_id, legal_form_id, effective_to
            values = `(${fields[1]}, ${fields[2]}, ${fields[4] === '\\N' ? 'NULL' : esc(fields[4])})`;
            break;
          case 'legal_forms':
            values = `(${fields[0]}, ${esc(fields[1])})`;
            break;
          case 'organization_economic_activity_entries':
          case 'economic_activity_entries':
          case 'organization_economic_activities':
            // Mirrors organization_legal_form_entries shape:
            //   [0]=id, [1]=organization_id, [2]=code (NACE/SK NACE),
            //   [3]=description (skipped), [4]=effective_to (or valid_to).
            // Effective row only — we filter effective_to IS NULL later.
            {
              const orgId = fields[1];
              const code = fields[2];
              const effectiveTo = fields[4];
              if (orgId && /^\d+$/.test(orgId) && code && code !== '\\N') {
                values = `(${orgId}, ${esc(code)}, ${
                  effectiveTo === '\\N' || effectiveTo === undefined
                    ? 'NULL'
                    : esc(effectiveTo)
                })`;
              }
            }
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

    // Create indexes on temporary tables.
    // We run heavy DDL/INSERT inside an explicit transaction with SET LOCAL
    // statement_timeout=0. Plain "SET" via pool.query() doesn't survive
    // through Supabase's transaction-pooler (next statement may land on a
    // different backend), so SET LOCAL inside BEGIN..COMMIT is the only
    // reliable override.
    console.log('[Import] Creating indexes...');
    await ImportService.runWithoutTimeout(`
      CREATE INDEX idx_import_identifiers_org ON import_identifiers(organization_id);
      CREATE INDEX idx_import_names_org ON import_names(organization_id);
      CREATE INDEX idx_import_addresses_org ON import_addresses(organization_id);
      CREATE INDEX idx_import_legal_form_entries_org ON import_legal_form_entries(organization_id);
      CREATE INDEX idx_import_economic_activities_org ON import_economic_activities(organization_id);
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
        nace_codes TEXT[],
        is_active BOOLEAN DEFAULT true,
        imported_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // NACE code source: organizations.main_activity_code_id -> main_activity_codes.id
    // Source IDs are 4-5 digit packed NACE (e.g. 43910 = 43.91, 5812 = 58.12).
    // We expose two array elements per company: structured "XX.XX" (for by-nace
    // exact-match queries) and the human-readable Slovak name (for by-trade ILIKE).
    //
    // The full JOIN+INSERT over ~1.7M orgs takes 3-5 minutes. Supavisor (Supabase
    // pooler) enforces a hard 120s server-side timeout we cannot override from the
    // client even with SET LOCAL — so we chunk by organization_id ranges so each
    // chunk's INSERT comfortably fits inside that ceiling.
    const CHUNK_SIZE = 100000;
    const orgRangeRes = await ImportService.runWithoutTimeout(`
      SELECT COALESCE(MIN(id), 0)::int AS min_id, COALESCE(MAX(id), 0)::int AS max_id
      FROM import_organizations
    `);
    const minId = (orgRangeRes.rows[0] as { min_id: number }).min_id;
    const maxId = (orgRangeRes.rows[0] as { max_id: number }).max_id;
    console.log(`[Import] Inserting companies in chunks: organization_id ${minId}..${maxId}, chunk=${CHUNK_SIZE}`);

    let recordCount = 0;
    for (let start = minId; start <= maxId; start += CHUNK_SIZE) {
      const end = start + CHUNK_SIZE;
      const chunkRes = await ImportService.runWithoutTimeout(`
        WITH nace_per_org AS (
          SELECT
            o.id AS organization_id,
            ARRAY[
              SUBSTRING(LPAD(mac.id::text, 5, '0') FROM 1 FOR 2)
                || '.' ||
              SUBSTRING(LPAD(mac.id::text, 5, '0') FROM 3 FOR 2),
              mac.name
            ] AS codes
          FROM import_organizations o
          JOIN import_main_activities mac ON mac.id = o.main_activity_code_id
          WHERE o.main_activity_code_id IS NOT NULL
            AND o.id >= ${start} AND o.id < ${end}
        )
        INSERT INTO companies_staging (
          ico, dic, ic_dph, name, name_normalized,
          legal_form, street, city, postal_code, country,
          nace_codes, is_active
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
          npo.codes as nace_codes,
          (o.terminated_on IS NULL) as is_active
        FROM import_identifiers i
        JOIN import_names n ON n.organization_id = i.organization_id AND n.effective_to IS NULL
        JOIN import_organizations o
          ON o.id = i.organization_id
          AND o.id >= ${start} AND o.id < ${end}
        LEFT JOIN import_addresses a ON a.organization_id = i.organization_id AND a.effective_to IS NULL
        LEFT JOIN import_legal_form_entries lfe ON lfe.organization_id = i.organization_id AND lfe.effective_to IS NULL
        LEFT JOIN import_legal_forms lf ON lf.id = lfe.legal_form_id
        LEFT JOIN nace_per_org npo ON npo.organization_id = i.organization_id
        WHERE i.effective_to IS NULL
          AND i.ico IS NOT NULL
          AND n.name IS NOT NULL
        ORDER BY i.ico, n.name
        ON CONFLICT (ico) DO NOTHING
      `);
      const chunkCount = chunkRes.rowCount || 0;
      recordCount += chunkCount;
      console.log(`[Import] Chunk ${start}-${end}: inserted ${chunkCount} (total ${recordCount})`);
    }
    console.log(`[Import] Inserted ${recordCount} companies`);

    // Create unique index on staging
    await ImportService.runWithoutTimeout(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_ico ON companies_staging(ico);
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
      DROP TABLE IF EXISTS import_economic_activities CASCADE;
      DROP TABLE IF EXISTS import_main_activities CASCADE;
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
   * Record newly-observed IČOs into seen_icos after a successful import.
   *
   * `companies` is rebuilt from scratch each run, so we cannot derive
   * "appeared this week" from companies.imported_at. seen_icos is an
   * append-only ledger: each ICO gets stamped with the date it first
   * showed up in any import.
   *
   * On first deploy, this also doubles as the backfill — every current
   * ICO lands with first_seen = today, so the first weekly digest sees
   * 0 "new" entries rather than ~1.1M.
   */
  static async recordNewIcos(): Promise<number> {
    console.log('[Import] Recording new ICOs into seen_icos...');
    const result = await ImportService.runWithoutTimeout(`
      INSERT INTO seen_icos (ico, first_seen, legal_form, name, city, nace_codes)
      SELECT
        c.ico,
        CURRENT_DATE,
        c.legal_form,
        c.name,
        c.city,
        c.nace_codes
      FROM companies c
      LEFT JOIN seen_icos s ON s.ico = c.ico
      WHERE s.ico IS NULL
    `);
    const inserted = result.rowCount || 0;
    console.log(`[Import] Recorded ${inserted} new ICOs`);
    return inserted;
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
    await ImportService.runWithoutTimeout(`
      CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON companies USING GIN (name_normalized gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_companies_ico ON companies (ico text_pattern_ops);
      CREATE INDEX IF NOT EXISTS idx_companies_nace_gin ON companies USING GIN (nace_codes);
    `);

    console.log('[Import] Tables swapped successfully');
  }

  /**
   * Run full import process
   */
  static async runFullImport(): Promise<ImportResult> {
    const startTime = Date.now();

    try {
      // Skip download+decompress if SQL file already exists (resume after crash)
      if (existsSync(TEMP_SQL_FILE)) {
        console.log('[Import] Found existing SQL file, skipping download+decompress');
      } else {
        // Download dump
        await this.downloadDump();

        // Decompress
        await this.decompressDump();
      }

      // Parse and import
      const recordCount = await this.parseAndImport();

      // Swap tables
      await this.swapTables();

      // Record any newly-seen ICOs into the append-only ledger
      await this.recordNewIcos();

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
