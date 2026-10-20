// Question rendering: snapshot clips, typed blocks, answer buttons. Never throws on unknown content.
import { setRich, setMath } from './text.js';
import { assetUrl } from './importer.js';
import { SUPPORTED_TYPES } from './validator.js';

// el('div', {className: 'x', onclick: fn}, child, 'text', ...) - children are nodes or plain text.
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const placeholder = (what) => el('p', { className: 'unsupported' }, `Unsupported content (${what}).`);

// Shows the [x, y, w, h] window of an image: the wrapper keeps the clip's aspect ratio and the
// image is scaled and offset inside it once its natural size is known.
export function image(pack, item, alt) {
  const img = el('img', { alt, decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(placeholder('missing image')));
  if (!Array.isArray(item.clip)) {
    img.src = assetUrl(pack, item.src);
    return el('div', { className: 'whole' }, img);
  }
  const [x, y, w, h] = item.clip;
  const box = el('div', { className: 'clip' }, img);
  box.style.aspectRatio = `${w} / ${h}`;
  img.style.visibility = 'hidden';
  img.addEventListener('load', () => {
    img.style.width = `${(img.naturalWidth / w) * 100}%`;
    img.style.left = `${(-x / w) * 100}%`;
    img.style.top = `${(-y / h) * 100}%`;
    img.style.visibility = '';
  });
  img.src = assetUrl(pack, item.src);
  return box;
}

export function snapshot(pack, q) {
  const label = `Question ${q.number ?? q.id} as printed`;
  return el('div', { className: 'snapshot paper' }, (q.snapshot || []).map((item, i) =>
    image(pack, item, i ? `${label} (continued)` : label)));
}

function block(pack, b) {
  try {
    switch (b.type) {
      case 'text': return setRich(el('div', { className: 'text' }), b.text);
      case 'math': return setMath(el('div', { className: 'math' }), b.tex, b.display !== false);
      case 'fig': return el('figure', { className: 'fig paper' }, image(pack, b, b.alt),
        b.provenance === 'redraw' ? el('figcaption', { className: 'badge' }, 'redrawn') : null);
      case 'table': return el('table', {}, el('tbody', {}, b.rows.map((row, r) => el('tr', {}, row.map((cell) =>
        setRich(el(b.header && r === 0 ? 'th' : 'td', b.header && r === 0 ? { scope: 'col' } : {}), cell, { inline: true }))))));
      default: return placeholder(`block "${b.type}"`);
    }
  } catch {
    return placeholder(`bad "${b?.type}" block`);
  }
}

export const blocks = (pack, list) => el('div', { className: 'blocks' }, (list || []).map((b) => block(pack, b)));
export const isTyped = (q) => Array.isArray(q.stem) && Array.isArray(q.options);

// The question body (without answer buttons).
export function question(pack, q) {
  if (!SUPPORTED_TYPES.includes(q.type)) return el('div', { className: 'question' }, placeholder(`question type "${q.type}"`));
  if (!isTyped(q)) return el('div', { className: 'question' }, snapshot(pack, q));
  return el('div', { className: 'question' }, blocks(pack, q.stem),
    q.snapshot?.length ? el('details', { className: 'original' }, el('summary', {}, 'View original'), snapshot(pack, q)) : null);
}

// One button per option key. Typed questions show option content; snapshot questions show the key only.
export function answerButtons(pack, q) {
  if (!SUPPORTED_TYPES.includes(q.type)) return [];
  const typed = isTyped(q) ? new Map(q.options.map((o) => [o.key, o.blocks])) : null;
  return pack.optionKeys.map((key) => el('button', { type: 'button', className: typed ? 'option typed' : 'option', value: key },
    el('span', { className: 'key' }, key), typed ? blocks(pack, typed.get(key)) : null));
}
