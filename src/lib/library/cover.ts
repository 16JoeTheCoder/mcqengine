/**
 * Default cover in the builtbyjosef style: paper ground, one Tab in ink with the orange cap, the
 * title set inside it. 600 x 800. Colours are written out (an image cannot read CSS variables).
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Greedy word wrap by character count; long words are cut. At most `lines` lines, the last ellipsised. */
export function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w0 of text.trim().split(/\s+/)) {
    const w = w0.length > width ? `${w0.slice(0, width - 1)}…` : w0;
    if (!cur) cur = w;
    else if (`${cur} ${w}`.length <= width) cur = `${cur} ${w}`;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = `${kept[lines - 1]!.slice(0, width - 1)}…`;
    return kept;
  }
  return out;
}

export function coverSvg(title: string, subtitle: string, fontCss = ''): string {
  const INK = '#0D0E10';
  const PAPER = '#F3F2EE';
  const ORANGE = '#FF5B1F';
  const lines = wrap(title || 'Untitled set', 12, 4);
  // Fit the longest line inside the Tab (264 px of text width); bold Space Grotesk is about 0.6 em per character.
  const size = Math.min(46, Math.floor(264 / (0.62 * Math.max(...lines.map((l) => l.length), 1))));
  const sub = subtitle.trim() && subtitle.trim().toLowerCase() !== title.trim().toLowerCase() ? wrap(subtitle, 22, 2) : [];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
<style>${fontCss} text{font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif}</style>
<rect width="600" height="800" fill="${PAPER}"/>
<path d="M150 104a24 24 0 0 1 24-24h252a24 24 0 0 1 24 24v592a24 24 0 0 1-24 24H174a24 24 0 0 1-24-24Z" fill="${INK}"/>
<path d="M150 138v-34a24 24 0 0 1 24-24h252a24 24 0 0 1 24 24v34Z" fill="${ORANGE}"/>
${lines.map((l, i) => `<text x="182" y="${236 + i * Math.round(size * 1.17)}" font-size="${size}" font-weight="700" letter-spacing="-1" fill="${PAPER}">${esc(l)}</text>`).join('\n')}
${sub.map((l, i) => `<text x="182" y="${620 + i * 30}" font-size="22" font-weight="400" fill="${PAPER}" opacity="0.8">${esc(l)}</text>`).join('\n')}
</svg>`;
}
