// Markdown-lite: escape everything, then only **bold**, *italic*, paragraphs, line breaks and $inline math$.
// setRich/setMath are the only places pack text reaches innerHTML, and only after escaping or KaTeX.
import katex from '../vendor/katex/katex.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export function math(tex, display = false) {
  return katex.renderToString(String(tex), {
    displayMode: display, trust: false, throwOnError: false, strict: 'ignore', maxSize: 20, maxExpand: 500,
  });
}

export function inlineHTML(src) {
  return String(src ?? '').split(/(\$[^$\n]+\$)/).map((part, i) => (i % 2
    ? math(part.slice(1, -1))
    : escape(part).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/\n/g, '<br>')
  )).join('');
}

export function toHTML(src) {
  return String(src ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${inlineHTML(p)}</p>`).join('');
}

export function setRich(el, src, { inline = false } = {}) {
  el.innerHTML = inline ? inlineHTML(src) : toHTML(src);
  return el;
}

export function setMath(el, tex, display) {
  el.innerHTML = math(tex, display);
  return el;
}
