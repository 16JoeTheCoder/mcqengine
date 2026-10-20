// Pack validation. Mirrors validate() in tools/mcqpack.py rule for rule; see docs/PACK_FORMAT.md.
// validate(pack, assets) -> {errors, warnings}, each [{code, where, message}].
// assets: Map(path -> SVG text, or null for other files), or null to skip asset checks.

const PACK_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SVG_UNSAFE = /<script|\son[a-z]+\s*=|<foreignObject|href\s*=\s*(?!["']#)/i;
export const SUPPORTED_TYPES = ['single'];

const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrList = (v) => Array.isArray(v) && v.every(isStr);

export function badPath(p) {
  return !isStr(p) || p === '' || p.startsWith('/') || p.includes('\\') || p.includes(':') ||
    p.split('/').some((s) => s === '' || s === '.' || s === '..');
}

export function validate(pack, assets) {
  const errors = [], warnings = [];
  const err = (code, where, message) => errors.push({ code, where, message });
  const warn = (code, where, message) => warnings.push({ code, where, message });

  if (!isObj(pack)) {
    err('json', 'pack', 'pack.json is not a JSON object');
    return { errors, warnings };
  }
  if (pack.format !== 'mcqpack' || !isStr(pack.formatVersion) || !/^1\.[0-9]+$/.test(pack.formatVersion)) {
    err('format', 'pack', 'not an mcqpack 1.x file (check "format" and "formatVersion")');
  }
  for (const f of ['version', 'title']) {
    if (!isStr(pack[f]) || !pack[f]) err('field', 'pack', `"${f}" must be a non-empty string`);
  }
  if (!isStr(pack.id)) err('field', 'pack', '"id" must be a string');
  else if (!PACK_ID.test(pack.id)) err('id', 'pack', `pack id "${pack.id}" must be 2-64 lowercase letters, digits or hyphens`);
  let keys = pack.optionKeys;
  if (!(Array.isArray(keys) && keys.length >= 2 && keys.length <= 10 &&
      keys.every((k) => isStr(k) && k.length >= 1 && k.length <= 3) && new Set(keys).size === keys.length)) {
    err('option-keys', 'pack', '"optionKeys" must be 2-10 unique keys of 1-3 characters');
    keys = null;
  }
  if ('timeLimitSec' in pack && !(isInt(pack.timeLimitSec) && pack.timeLimitSec > 0)) {
    err('field', 'pack', '"timeLimitSec" must be a positive whole number');
  }
  if ('overlays' in pack && !isStrList(pack.overlays)) err('field', 'pack', '"overlays" must be a list of file paths');
  const questions = pack.questions;
  if (!Array.isArray(questions) || !questions.length) {
    err('field', 'pack', '"questions" must be a non-empty list');
    return { errors, warnings };
  }

  function image(item, where, what) {
    if (!isObj(item) || !isStr(item.src)) return err('field', where, `${what} needs a "src" path`);
    const src = item.src;
    if (badPath(src)) err('path', where, `${what} path "${src}" points outside the pack`);
    else if (assets && !assets.has(src)) err('asset-missing', where, `${what} file "${src}" is not in the pack`);
    else if (assets && src.toLowerCase().endsWith('.svg') && SVG_UNSAFE.test(assets.get(src) || '')) {
      err('svg-unsafe', where, `SVG "${src}" contains scripts, event handlers, foreignObject or external links`);
    }
    if ('clip' in item) {
      const c = item.clip;
      if (!(Array.isArray(c) && c.length === 4 && c.every((n) => typeof n === 'number') &&
          c[0] >= 0 && c[1] >= 0 && c[2] > 0 && c[3] > 0)) {
        err('clip', where, `${what} clip must be [x, y, width, height] with width and height above 0`);
      }
    }
  }

  function block(b, where) {
    if (!isObj(b) || !isStr(b.type)) return err('field', where, 'a block needs a "type"');
    const t = b.type;
    if (t === 'text' && !isStr(b.text)) err('field', where, 'a text block needs "text"');
    else if (t === 'math' && !isStr(b.tex)) err('field', where, 'a math block needs "tex"');
    else if (t === 'fig') {
      image(b, where, 'figure');
      if (!isStr(b.alt) || !b.alt.trim()) err('alt', where, 'a figure has no alt text (describe it for screen readers)');
    } else if (t === 'table' && !(Array.isArray(b.rows) && b.rows.every(isStrList))) {
      err('field', where, 'a table block needs "rows" as lists of text');
    } else if (!['text', 'math', 'fig', 'table'].includes(t)) {
      warn('unsupported-block', where, `block type "${t}" is not supported and will show a placeholder`);
    }
  }

  const seen = new Set();
  questions.forEach((q, i) => {
    const where = isObj(q) && isStr(q.id) ? q.id : `#${i + 1}`;
    if (!isObj(q)) return err('field', where, 'question is not an object');
    if (!isStr(q.id)) err('field', where, 'question has no "id"');
    else if (!QUESTION_ID.test(q.id)) err('id', where, `question id "${q.id}" may only use letters, digits, _ and - (max 32)`);
    else if (seen.has(q.id)) err('duplicate-id', where, `question id "${q.id}" is used more than once`);
    seen.add(q.id);
    if (!isStr(q.type)) return err('field', where, 'question has no "type"');
    if (!SUPPORTED_TYPES.includes(q.type)) {
      return warn('unsupported-type', where, `question type "${q.type}" is not supported and will be skipped`);
    }
    if (!(isInt(q.rev) && q.rev >= 1)) err('field', where, '"rev" must be a whole number of 1 or more');
    if (keys && !keys.includes(q.answer)) {
      err('answer', where, `answer ${JSON.stringify(q.answer ?? null)} is not one of the option keys ${keys.join(', ')}`);
    }
    for (const f of ['snapshot', 'stem', 'options']) {
      if (f in q && !Array.isArray(q[f])) err('field', where, `"${f}" must be a list`);
    }
    const snap = Array.isArray(q.snapshot) ? q.snapshot : [];
    const stem = Array.isArray(q.stem) ? q.stem : null;
    const opts = Array.isArray(q.options) ? q.options : null;
    if ((stem === null) !== (opts === null) || (!snap.length && stem === null)) {
      err('content', where, 'needs a snapshot, or both a stem and options');
    }
    for (const item of snap) image(item, where, 'snapshot');
    for (const b of stem || []) block(b, where);
    if (opts) {
      for (const o of opts) {
        if (!isObj(o) || !Array.isArray(o.blocks)) err('field', where, 'each option needs "key" and "blocks"');
        else for (const b of o.blocks) block(b, where);
      }
      const got = opts.map((o) => (isObj(o) ? o.key : null));
      if (keys && (got.length !== keys.length || got.some((k, j) => k !== keys[j]))) {
        err('option-keys', where, `options must be exactly ${keys.join(', ')} in that order`);
      }
    }
    if ('explanation' in q && !isStr(q.explanation)) err('field', where, '"explanation" must be text');
    if ('topics' in q && !isStrList(q.topics)) err('field', where, '"topics" must be a list of text');
  });
  return { errors, warnings };
}
