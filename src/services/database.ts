import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    pool = new Pool({
      connectionString,
      max: 10,
      min: 1,
      idleTimeoutMillis: 600000,
      connectionTimeoutMillis: 10000,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
    });

    pool.on('error', (err) => {
      console.error('[Database] Unexpected error on idle client', err);
    });

    const keepAliveMs = parseInt(process.env.KEEP_ALIVE_MS || '45000', 10);
    if (keepAliveMs > 0 && process.env.NODE_ENV === 'production') {
      setInterval(() => {
        pool?.query('SELECT 1').catch((err) => {
          console.error('[Database] Keep-alive ping failed:', err.message);
        });
      }, keepAliveMs).unref();
      console.log(`[Database] Keep-alive ping every ${keepAliveMs}ms`);
    }

    console.log('[Database] Connection pool initialized (min=1, idle=10min)');
  }

  return pool;
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await getPool().query<T>(text, params);
  const duration = Date.now() - start;

  if (duration > 100) {
    console.log(`[Database] Slow query (${duration}ms):`, text.substring(0, 100));
  }

  return result;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[Database] Connection pool closed');
  }
}
