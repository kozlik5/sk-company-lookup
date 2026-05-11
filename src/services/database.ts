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

const TRANSIENT_PATTERNS = [
  'connection terminated',
  'connection timeout',
  'connection timed out',
  'server has gone away',
  'server closed the connection',
  'no connection to the server',
  'could not send data to server',
  'lost connection',
  'eof detected',
  'broken pipe',
  'econnreset',
  'enetunreach',
  'etimedout',
  'read econnreset',
];

function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: string; code?: string };
  const msg = (e.message || '').toLowerCase();
  if (TRANSIENT_PATTERNS.some((p) => msg.includes(p))) return true;
  // pg lifecycle error codes
  if (e.code === '57P01' || e.code === '57P02' || e.code === '57P03') return true; // admin_shutdown, crash_shutdown, cannot_connect_now
  if (e.code === '08000' || e.code === '08003' || e.code === '08006' || e.code === '08001' || e.code === '08004') return true; // connection class
  return false;
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const backoffMs = [50, 200, 500];
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr: unknown;

  while (attempt < maxAttempts) {
    const start = Date.now();
    try {
      const result = await getPool().query<T>(text, params);
      const duration = Date.now() - start;
      if (duration > 100) {
        console.log(`[Database] Slow query (${duration}ms):`, text.substring(0, 100));
      }
      return result;
    } catch (err) {
      lastErr = err;
      attempt++;
      if (!isTransientError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const wait = backoffMs[attempt - 1] ?? 500;
      console.warn(`[Database] Transient error (attempt ${attempt}/${maxAttempts}), retrying in ${wait}ms:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[Database] Connection pool closed');
  }
}
