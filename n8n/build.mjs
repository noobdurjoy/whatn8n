// Builds the JavaScript for n8n Code nodes.
//
// n8n Code nodes cannot import files, so shared modules (shared/*.js) are
// inlined: a line `// @include shared/x.js` is replaced by the module's text
// with `export ` removed, wrapped in marker comments. The result is written
// to n8n/code/dist/<name>.js and is what gets pasted into the Code nodes.
// `// @include shared/x.js: fnA, fnB` inlines only those top-level
// declarations plus the ones they reference (keeps Code nodes small).
// tests/unit/n8n-code.test.ts checks that the Code nodes in the exported
// workflow JSON (n8n/workflows/*.json) match these files exactly.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const srcDir = path.join(root, 'n8n', 'code', 'src');
const outDir = path.join(root, 'n8n', 'code', 'dist');

// Splits a module into top-level declarations (with their leading comments).
function declarations(text) {
  const lines = text.split('\n');
  const blocks = [];
  let pending = [];
  let cur = null;
  for (const line of lines) {
    const d = line.match(/^(?:export )?(?:async )?(?:function|const|let) (\w+)/);
    if (d) {
      cur = { name: d[1], lines: pending.concat([line]) };
      pending = [];
      blocks.push(cur);
    } else if (/^(\/\/|\/\*\*|\s\*)/.test(line) && (!cur || cur.closed)) {
      pending.push(line);
    } else if (cur) {
      if (pending.length) { cur.lines.push(...pending); pending = []; }
      cur.lines.push(line);
      if (/^[}\]]|;\s*$/.test(line) && !/^\s/.test(line)) cur.closed = true;
    }
    if (d && (/;\s*$/.test(line) || /\}\s*$/.test(line))) cur.closed = true;
  }
  return blocks;
}

function pick(text, names) {
  const blocks = declarations(text);
  const byName = new Map(blocks.map((b) => [b.name, b]));
  const keep = new Set();
  const visit = (n) => {
    if (keep.has(n)) return;
    const b = byName.get(n);
    if (!b) throw new Error('unknown shared declaration: ' + n);
    keep.add(n);
    const body = b.lines.join('\n');
    for (const other of byName.keys()) if (other !== n && new RegExp('\\b' + other + '\\b').test(body)) visit(other);
  };
  names.forEach(visit);
  return blocks.filter((b) => keep.has(b.name)).map((b) => b.lines.join('\n').trimEnd()).join('\n\n');
}

export async function inlineShared(file) {
  const out = [];
  for (const line of file.split('\n')) {
    const m = line.match(/^\s*\/\/ @include (shared\/[\w-]+\.js)(?::\s*([\w,\s]+))?\s*$/);
    if (!m) { out.push(line); continue; }
    let text = (await readFile(path.join(root, m[1]), 'utf8')).replace(/^export /gm, '');
    if (m[2]) text = pick(text, m[2].split(',').map((x) => x.trim()).filter(Boolean));
    out.push(`// ---- begin ${m[1]}${m[2] ? ' (' + m[2].trim() + ')' : ''} (inlined by n8n/build.mjs; edit the shared file, not this copy) ----`);
    out.push(text.trimEnd());
    out.push(`// ---- end ${m[1]} ----`);
  }
  return out.join('\n');
}

export async function buildAll() {
  await mkdir(outDir, { recursive: true });
  const built = {};
  for (const f of (await readdir(srcDir)).filter((x) => x.endsWith('.js')).sort()) {
    const src = await readFile(path.join(srcDir, f), 'utf8');
    // Variants: a first line `// @variants A,B` with `__VARIANT__` placeholders.
    const vm = src.match(/^\/\/ @variants (.+)$/m);
    const variants = vm ? vm[1].split(',').map((s) => s.trim()) : [null];
    for (const v of variants) {
      const name = v ? f.replace(/\.js$/, `.${v}.js`) : f;
      let code = await inlineShared(src.replace(/^\/\/ @variants .+\n/m, ''));
      if (v) code = code.split('__VARIANT__').join(v.replace(/_/g, ' '));
      built[name] = code.trim() + '\n';
      await writeFile(path.join(outDir, name), built[name]);
    }
  }
  return built;
}

if (process.argv[1] && process.argv[1].endsWith('build.mjs')) {
  const b = await buildAll();
  console.log(`built ${Object.keys(b).length} code node files into n8n/code/dist`);
}
