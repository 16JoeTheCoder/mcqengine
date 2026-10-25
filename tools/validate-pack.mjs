#!/usr/bin/env node
// Validates a DMC pack (zip, folder or .json) with the same validator the app uses.
// Run from the repository root, in any terminal (Ubuntu/WSL, macOS Terminal, VS Code terminal):
//   node tools/validate-pack.mjs <pack.zip | folder | pack.json> [--json]
// Exit code 0 when the pack would import, 1 when it has errors, 2 on usage problems.
// Output: "->" step, "ok" success, "!" warning, "x" failure. No colour is used, so NO_COLOR is honoured.
import { build } from 'esbuild';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('usage: node tools/validate-pack.mjs <pack.zip | folder | pack.json> [--json]');
  process.exit(2);
}

// The SVG sanitiser needs DOMParser and XMLSerializer, as in the browser.
const win = new Window();
globalThis.DOMParser = win.DOMParser;
globalThis.XMLSerializer = win.XMLSerializer;

const out = await build({ entryPoints: [join(here, '../src/lib/format/check.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const lib = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const log = (s) => !asJson && console.log(s);
const path = resolve(target);
let src;
try {
  const st = await stat(path);
  log(`-> reading ${relative(process.cwd(), path) || path}`);
  if (st.isDirectory()) {
    const list = [];
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else list.push([relative(path, p).split('\\').join('/'), new Uint8Array(await readFile(p))]);
      }
    };
    await walk(path);
    src = await lib.settle(lib.fromEntries(target, list));
  } else if (/\.zip$/i.test(path)) {
    src = await lib.readZip(new Blob([await readFile(path)]), target);
  } else {
    src = { name: target, text: await readFile(path, 'utf8'), files: new Map(), pdfs: new Map(), skipped: [] };
  }
} catch (e) {
  console.error(`x could not read ${target}: ${e.message}`);
  process.exit(1);
}

const r = lib.checkSource(src);
if (asJson) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
for (const s of src.skipped) console.log(`! skipped ${s}`);
if (r.syntax) {
  console.log(`x ${r.syntax}`);
  process.exit(1);
}
log(`-> ${r.papers.length} paper(s), ${r.images} image(s), ${r.pdfs} PDF(s)`);
for (const p of r.papers) log(`   ${p.id}: ${p.questions}/${p.questionCount} questions, ${p.keyed} keyed${p.bare ? ', bare PDF paper' : ''}`);
if (r.notes.length) log(`-> tidied: ${r.notes.join('; ')}`);
for (const w of r.warnings) console.log(`! ${w.path}: ${w.message}${w.confirm ? ' (needs confirmation in the app)' : ''}`);
for (const e of r.errors) console.log(`x ${e.path}: ${e.message}`);
console.log(r.ok ? `ok the pack is valid${r.warnings.length ? ` with ${r.warnings.length} warning(s)` : ''}` : `x ${r.errors.length} error(s): fix them, or paste the output into the AI chat that made the pack`);
process.exit(r.ok ? 0 : 1);
