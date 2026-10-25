/**
 * Allowlist SVG sanitiser. Output is additionally rendered through <img>, where SVG can neither
 * run script nor fetch resources, so this is defence in depth rather than the only barrier.
 */
export const MAX_SVG_BYTES = 200_000;

const ELEMENTS = new Set([
  'svg', 'g', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'text', 'tspan',
  'defs', 'marker', 'title', 'desc', 'use', 'lineargradient', 'radialgradient', 'stop', 'clippath',
  'pattern', 'symbol',
]);

const ATTRS = new Set([
  'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd',
  'points', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'stroke-opacity', 'fill-opacity', 'opacity', 'transform', 'font-size', 'font-family', 'font-weight',
  'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy', 'id', 'class', 'marker-end',
  'marker-start', 'marker-mid', 'markerwidth', 'markerheight', 'refx', 'refy', 'orient',
  'markerunits', 'preserveaspectratio', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'clip-path', 'xmlns', 'version', 'href', 'xlink:href', 'xmlns:xlink', 'fill-rule', 'clip-rule',
  'patternunits', 'letter-spacing', 'baseline-shift', 'style', 'role', 'aria-label',
]);

export interface SvgResult {
  svg: string | null;
  removed: string[];
}

const safeUrl = (v: string) => !/url\s*\(\s*['"]?\s*(?!#)/i.test(v);

export function sanitizeSvg(input: string): SvgResult {
  const removed: string[] = [];
  if (typeof input !== 'string' || !input.trim()) return { svg: null, removed: ['empty'] };
  if (input.length > MAX_SVG_BYTES) return { svg: null, removed: ['too large'] };
  // Doctypes and entities enable expansion attacks; refuse them outright.
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) return { svg: null, removed: ['doctype/entity'] };
  const doc = new DOMParser().parseFromString(input, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length)
    return { svg: null, removed: ['not valid SVG'] };

  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const name = child.nodeName.toLowerCase();
      if (!ELEMENTS.has(name)) {
        removed.push(`<${name}>`);
        child.remove();
        continue;
      }
      walk(child);
    }
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      const v = attr.value;
      let ok = ATTRS.has(n) && !n.startsWith('on');
      if (ok && (n === 'href' || n === 'xlink:href')) ok = v.trim().startsWith('#');
      if (ok && n === 'style') ok = safeUrl(v) && !/@import|expression|javascript:/i.test(v);
      if (ok && /javascript:|data:/i.test(v)) ok = false;
      if (ok && !safeUrl(v)) ok = false;
      if (!ok) {
        removed.push(`@${n}`);
        el.removeAttribute(attr.name);
      }
    }
  };
  walk(root);
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!root.getAttribute('viewBox') && root.getAttribute('width') && root.getAttribute('height'))
    root.setAttribute('viewBox', `0 0 ${parseFloat(root.getAttribute('width') ?? '0')} ${parseFloat(root.getAttribute('height') ?? '0')}`);
  const svg = new XMLSerializer().serializeToString(root);
  return { svg, removed };
}

export function svgToUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
}
