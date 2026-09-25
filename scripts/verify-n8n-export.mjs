// Compares workflows as they exist on the n8n instance with the generated
// definition in n8n/workflow/*.json (node types, versions, parameters
// including every Code node's JavaScript, credential references, connections).
//
// Usage: node scripts/verify-n8n-export.mjs <file-with-workflow-json>...
// Each input file holds a workflow object as returned by the n8n API
// (e.g. `get_workflow_details` or an export). Exit code 1 on any mismatch.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'n8n', 'workflow');
const local = {};
for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json') && x !== 'code-nodes.json')) {
  const wf = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
  local[wf.name] = { file: f, wf };
}

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
let failures = 0;
export function compare(remote) {
  const l = local[remote.name];
  const problems = [];
  if (!l) return [`no local definition named "${remote.name}"`];
  const rn = new Map(remote.nodes.map((n) => [n.name, n]));
  for (const n of l.wf.nodes) {
    const r = rn.get(n.name);
    if (!r) { problems.push(`missing node ${n.name}`); continue; }
    if (r.type !== n.type || Number(r.typeVersion) !== Number(n.typeVersion)) problems.push(`${n.name}: type/version ${r.type}@${r.typeVersion} != ${n.type}@${n.typeVersion}`);
    if (canon(r.parameters) !== canon(n.parameters)) {
      if (n.type === 'n8n-nodes-base.code') {
        const a = r.parameters.jsCode || '';
        const b = n.parameters.jsCode;
        let i = 0;
        while (i < a.length && a[i] === b[i]) i++;
        problems.push(`${n.name}: jsCode differs at char ${i}: remote ${JSON.stringify(a.slice(i, i + 40))} vs local ${JSON.stringify(b.slice(i, i + 40))}`);
      } else {
        problems.push(`${n.name}: parameters differ\n    remote ${canon(r.parameters).slice(0, 400)}\n    local  ${canon(n.parameters).slice(0, 400)}`);
      }
    }
    for (const [type, c] of Object.entries(n.credentials || {})) {
      const rc = (r.credentials || {})[type];
      if (c.id && (!rc || rc.id !== c.id)) problems.push(`${n.name}: credential ${type} should be ${c.id}, is ${rc ? rc.id : 'unset'}`);
    }
    for (const k of ['onError', 'executeOnce', 'alwaysOutputData']) if ((n[k] ?? null) !== (r[k] ?? null)) problems.push(`${n.name}: ${k} ${r[k]} != ${n[k]}`);
  }
  for (const r of remote.nodes) if (!l.wf.nodes.some((n) => n.name === r.name)) problems.push(`extra node on instance: ${r.name}`);
  const edges = (c) => Object.entries(c || {}).flatMap(([from, v]) => (v.main || []).flatMap((outs, i) => (outs || []).map((t) => `${from}#${i}->${t.node}#${t.index}`))).sort().join('\n');
  if (edges(remote.connections) !== edges(l.wf.connections)) problems.push('connections differ');
  return problems;
}

if (process.argv[1] && process.argv[1].endsWith('verify-n8n-export.mjs')) {
  for (const f of process.argv.slice(2)) {
    const j = JSON.parse(await readFile(f, 'utf8'));
    const wf = j.workflow || j;
    const p = compare(wf);
    console.log(`${p.length ? 'MISMATCH' : 'OK      '} ${wf.name} (${wf.id})`);
    for (const x of p) console.log('  - ' + x);
    if (p.length) failures++;
  }
  process.exit(failures ? 1 : 0);
}
