import pg from 'pg';

// Single pool per process. The backend connects as the schema owner role
// (wa_app); n8n uses the restricted wa_n8n role.
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export type Db = pg.PoolClient | pg.Pool;

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function q<T extends pg.QueryResultRow = any>(text: string, params?: unknown[], db: Db = getPool()) {
  return db.query<T>(text, params as any[]);
}

// Map Postgres errors raised by the control functions to HTTP statuses.
export function pgErrorStatus(err: unknown): { status: number; message: string } {
  const e = err as { code?: string; message?: string };
  switch (e.code) {
    case '42501': return { status: 403, message: 'Not allowed' };
    case 'P0002': return { status: 404, message: 'Not found' };
    case '22023':
    case '22001': return { status: 400, message: e.message || 'Invalid request' };
    default: return { status: 500, message: 'Internal error' };
  }
}
