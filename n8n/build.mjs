// Builds the JavaScript for n8n Code nodes.
//
// n8n Code nodes cannot import files, so shared modules (shared/*.js) are
// inlined: a line `// @include shared/x.js` is replaced by the module's text
// with `export ` removed, wrapped in marker comments. The result is written
// to n8n/code/dist/<name>.js and is what gets pasted into the Code nodes.
// tests/unit/n8n-code.test.ts checks that the Code nodes in the exported
// workflow JSON (n8n/workflows/*.json) match these files exactly.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const srcDir = path.join(root, 'n8n', 'code', 'src');
const outDir = path.join(root, 'n8n', 'code', 'dist');

export async function inlineShared(file) {
  const out = [];
  for (const line of file.split('\n')) {
    const m = line.match(/^\s*\/\/ @include (shared\/[\w-]+\.js)\s*$/);
    if (!m) { out.push(line); continue; }
    const text = (await readFile(path.join(root, m[1]), 'utf8')).replace(/^export /gm, '').trimEnd();
    out.push(`// ---- begin ${m[1]} (inlined by n8n/build.mjs; edit the shared file, not this copy) ----`);
    out.push(text);
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
