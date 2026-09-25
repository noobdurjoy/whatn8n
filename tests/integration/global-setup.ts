import { execFileSync } from 'node:child_process';
import pg from 'pg';

// Creates a fresh test database, applies all migrations and the seed.
// Requires a local PostgreSQL; TEST_ADMIN_DATABASE_URL must be able to CREATE DATABASE.
export default async function setup() {
  const admin = process.env.TEST_ADMIN_DATABASE_URL || 'postgresql://dev:dev@localhost/postgres';
  const dbName = process.env.TEST_DB_NAME || 'wa_test';
  const url = new URL(admin);
  url.pathname = `/${dbName}`;
  const testUrl = url.toString();

  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${dbName}`);
  const roles = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'wa_n8n'`);
  if (!roles.rowCount) await c.query(`CREATE ROLE wa_n8n LOGIN PASSWORD 'n8n'`);
  await c.end();

  const t = new pg.Client({ connectionString: testUrl });
  await t.connect();
  await t.query('CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm;');
  await t.end();

  const envv = { ...process.env, DATABASE_URL: testUrl };
  execFileSync('node', ['scripts/migrate.mjs'], { env: envv, stdio: 'inherit' });
  execFileSync('node', ['scripts/seed.mjs'], { env: envv, stdio: 'inherit' });
  process.env.DATABASE_URL = testUrl;
  process.env.TEST_DATABASE_URL = testUrl;
}
