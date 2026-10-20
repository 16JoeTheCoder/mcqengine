// Loading packs: built-in (fetched), uploaded (zip, folder, single json), overlays, asset URLs.
// assemble() mirrors load_files() in tools/mcqpack.py.
import { unzipSync } from '../vendor/fflate/fflate.js';
import { validate, badPath } from './validator.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
const LAYERS = { explanations: 'explanation', topics: 'topics', answers: 'answer' };
const MAX_FILE = 50 * 1024 * 1024;
const meta = new WeakMap(); // pack -> {base} for built-in, {blobs, urls} for uploaded

const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const ext = (p) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();

function applyOverlay(pack, ov, name, warnings) {
  const warn = (msg) => warnings.push({ code: 'overlay', where: 'pack', message: `overlay ${name}: ${msg}` });
  if (!ov || typeof ov !== 'object' || ov.format !== 'mcqpack-overlay') return warn('is not an mcqpack-overlay file');
  if (ov.pack !== pack.id) return warn(`is for pack ${JSON.stringify(ov.pack ?? null)}, not this one`);
  const field = LAYERS[ov.layer];
  if (!Object.hasOwn(LAYERS, ov.layer) || !ov.items || typeof ov.items !== 'object' || Array.isArray(ov.items)) {
    return warn('has an unknown layer or no items');
  }
  const byId = new Map(pack.questions.filter((q) => q && typeof q === 'object').map((q) => [q.id, q]));
  for (const [qid, value] of Object.entries(ov.items)) {
    const ok = field === 'topics' ? isStrList(value) : typeof value === 'string';
    if (!byId.has(qid) || !ok) warn(`item ${qid} skipped (unknown question or wrong value type)`);
    else byId.get(qid)[field] = value;
  }
}

// files: Map(path -> text for .json/.svg, null for other files). Returns {pack, errors, warnings}.
export function assemble(files, checkAssets = true) {
  let pack;
  try {
    pack = JSON.parse(files.get('pack.json'));
  } catch {
    return { pack: null, errors: [{ code: 'json', where: 'pack', message: 'pack.json is missing or is not valid JSON' }], warnings: [] };
  }
  const errors = [], warnings = [];
  if (pack && typeof pack === 'object' && Array.isArray(pack.questions)) {
    const listed = isStrList(pack.overlays) ? pack.overlays : [];
    for (const p of listed) {
      if (badPath(p)) errors.push({ code: 'path', where: 'pack', message: `overlay path "${p}" points outside the pack` });
      else if (!files.has(p)) errors.push({ code: 'asset-missing', where: 'pack', message: `overlay file "${p}" is not in the pack` });
      else applyOverlay(pack, parse(files.get(p)), p, warnings);
    }
    for (const p of [...files.keys()].sort()) {
      if (p.includes('/') || !p.endsWith('.json') || p === 'pack.json' || listed.includes(p)) continue;
      const ov = parse(files.get(p));
      if (ov && ov.format === 'mcqpack-overlay') applyOverlay(pack, ov, p, warnings);
    }
  }
  const v = validate(pack, checkAssets ? files : null);
  return { pack, errors: errors.concat(v.errors), warnings: warnings.concat(v.warnings) };
}

// raw: Map(path -> Uint8Array) as uploaded. Finds pack.json (shallowest), re-roots paths there,
// validates, and returns {pack, errors, warnings, json, blobs}. blobs excludes pack.json.
export function fromBytes(raw) {
  const root = [...raw.keys()].filter((p) => p === 'pack.json' || p.endsWith('/pack.json'))
    .sort((a, b) => a.length - b.length)[0];
  const prefix = root ? root.slice(0, -'pack.json'.length) : '';
  const decoder = new TextDecoder();
  const files = new Map(), blobs = new Map();
  let json = '';
  for (const [path, bytes] of raw) {
    if (!path.startsWith(prefix) || path.endsWith('/')) continue;
    const rel = path.slice(prefix.length);
    const isText = /\.(svg|json)$/i.test(rel);
    files.set(rel, isText ? decoder.decode(bytes) : null);
    if (rel === 'pack.json') json = files.get(rel);
    else blobs.set(rel, new Blob([bytes], { type: MIME[ext(rel)] || 'application/octet-stream' }));
  }
  return { ...assemble(files), json, blobs };
}

// FileList/array from <input type=file> (one zip, one json, or a webkitdirectory folder) -> Map(path -> bytes).
export async function readUpload(fileList) {
  const list = [...fileList];
  if (list.length === 1 && /\.zip$/i.test(list[0].name)) {
    const entries = unzipSync(new Uint8Array(await list[0].arrayBuffer()), {
      filter: (f) => f.originalSize <= MAX_FILE && !f.name.startsWith('__MACOSX/'),
    });
    return new Map(Object.entries(entries));
  }
  const raw = new Map();
  for (const f of list) {
    const path = list.length === 1 && /\.json$/i.test(f.name) ? 'pack.json' : f.webkitRelativePath || f.name;
    if (f.size <= MAX_FILE) raw.set(path, new Uint8Array(await f.arrayBuffer()));
  }
  return raw;
}

// Built-in pack from packs/<dir>/. Unlisted overlays cannot be discovered over HTTP, so only
// overlays named in pack.overlays apply. Asset checks are done by the test suite instead.
export async function loadBuiltin(entry) {
  const base = `packs/${entry.dir}/`;
  const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(r.status); return r.text(); };
  const files = new Map([['pack.json', await get('pack.json')]]);
  const listed = parse(files.get('pack.json'))?.overlays;
  for (const p of isStrList(listed) ? listed : []) {
    if (!badPath(p)) files.set(p, await get(p).catch(() => null));
    if (files.get(p) === null) files.delete(p);
  }
  const result = assemble(files, false);
  if (result.pack) meta.set(result.pack, { base });
  return result;
}

export async function loadIndex() {
  const r = await fetch('packs/index.json');
  return r.ok ? (await r.json()).packs : [];
}

export function attachBlobs(pack, blobs) {
  meta.set(pack, { blobs, urls: new Map() });
}

export function assetUrl(pack, src) {
  const m = meta.get(pack);
  if (!m) return '';
  if (m.base) return m.base + src.split('/').map(encodeURIComponent).join('/');
  if (!m.urls.has(src) && m.blobs.has(src)) m.urls.set(src, URL.createObjectURL(m.blobs.get(src)));
  return m.urls.get(src) || '';
}

export function closePack(pack) {
  const m = meta.get(pack);
  if (m?.urls) for (const url of m.urls.values()) URL.revokeObjectURL(url);
  if (m?.urls) m.urls.clear();
}
