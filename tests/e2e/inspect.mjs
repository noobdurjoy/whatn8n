import { createRequire } from 'node:module';
import pg from 'pg';
// Debug helper: node tests/e2e/inspect.mjs <executionId> [node names...]
const require = createRequire((process.env.N8N_DIR || '.e2e/n8n') + '/node_modules/n8n/package.json');
const flatted = require('flatted');
const [id, ...nodes] = process.argv.slice(2);
const c = new pg.Client({ connectionString: 'postgresql://dev:dev@localhost/n8n_e2e' }); await c.connect();
const r = (await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [id])).rows[0];
const d = flatted.parse(r.data);
const rd = d.resultData.runData;
if (!nodes.length) { console.log(Object.entries(rd).map(([k, v]) => k + '×' + v.length).join(' | ')); if (d.resultData.error) console.log('ERROR', JSON.stringify(d.resultData.error).slice(0, 800)); }
for (const n of nodes) for (const [i, run] of (rd[n] || []).entries()) console.log('==', n, 'run', i, run.error ? 'ERR ' + JSON.stringify(run.error).slice(0, 600) : '', JSON.stringify(run.data && run.data.main).slice(0, Number(process.env.MAX || 1500)));
await c.end();
