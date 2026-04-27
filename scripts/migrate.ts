import 'dotenv/config';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });

  try {
    console.log('Connecting to database...');
    await client.connect();

    // Bookkeeping table so we never apply the same file twice.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const migrationsDir = join(__dirname, '..', 'migrations');
    if (!existsSync(migrationsDir)) {
      console.log('No migrations directory; nothing to do.');
      return;
    }

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // 001_, 002_, ... lexicographic order matches numeric order

    if (files.length === 0) {
      console.log('No migration files found.');
      return;
    }

    const appliedRes = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations'
    );
    const applied = new Set(appliedRes.rows.map((r) => r.filename));

    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`Skip ${filename} (already applied)`);
        continue;
      }

      console.log(`Applying ${filename}...`);
      const sql = readFileSync(join(migrationsDir, filename), 'utf-8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename]
      );
      console.log(`  OK ${filename}`);
    }

    console.log('Migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();
