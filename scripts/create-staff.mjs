// Creates (or resets the password of) a staff account from the command line.
//   DATABASE_URL=... npm run staff:create -- --email owner@example.com --name "Owner" --role owner
// The password is read from STAFF_PASSWORD or prompted on the terminal; it is
// never passed as a command-line argument.
import { createInterface } from 'node:readline/promises';
import { hash } from '@node-rs/argon2';
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
if (!args.email || !args.role || !['owner', 'admin', 'agent'].includes(args.role)) {
  console.error('usage: npm run staff:create -- --email you@example.com --name "Your Name" --role owner|admin|agent');
  process.exit(1);
}
let password = process.env.STAFF_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Password (12+ characters): ');
  rl.close();
}
if (!password || password.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const h = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
const r = await c.query(
  `INSERT INTO app.staff_users (email, display_name, role, password_hash) VALUES (lower($1), $2, $3, $4)
   ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role, active = true RETURNING id`,
  [args.email, args.name || args.email, args.role, h]);
await c.query(`INSERT INTO app.audit_log (actor_type, action, entity_type, entity_id) VALUES ('system', 'staff.created_cli', 'staff', $1)`, [r.rows[0].id]);
await c.end();
console.log(`staff account ready: ${args.email} (${args.role})`);
