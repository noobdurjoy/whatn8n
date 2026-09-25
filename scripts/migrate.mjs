// Applies db/migrations/*.sql in order. Each file is its own transaction and
// records itself in app.schema_migrations.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'db', 'migrations');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const exists = await client.query("SELECT to_regclass('app.schema_migrations') IS NOT NULL AS ok");
  const applied = new Set();
  if (exists.rows[0].ok) {
    for (const r of (await client.query('SELECT version FROM app.schema_migrations')).rows) applied.add(r.version);
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = [];
  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    process.stdout.write(`applying ${f} ... `);
    await client.query(await readFile(path.join(dir, f), 'utf8'));
    done.push(version);
    console.log('ok');
  }
  await client.query(await readFile(path.join(dir, '..', 'grants.sql'), 'utf8'));
  console.log('migrations up to date; grants applied');
  // Deployment status for the owner (Telegram category "Deployment status"),
  // only when this deploy changed the database schema.
  if (done.length && applied.size) {
    await client.query(`SELECT app.notify_admin('deployment', $1, $2, $3)`,
      ['deploy:' + done.join(','), 'Deployed: database updated', 'Applied ' + done.join(', ')]).catch(() => {});
  }
} finally {
  await client.end();
}
