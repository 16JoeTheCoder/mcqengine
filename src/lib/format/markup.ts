/**
 * DMC inline markup: a tiny, unambiguous LaTeX subset.
 *   x^{2}  x^2  x^{-1}   superscript (braces, or a short run like 2, -1, +)
 *   v_{0}  v_0           subscript (braces, or one letter/digit)
 *   \frac{a}{b}          stacked fraction
 *   \sqrt{x}             square root
 *   **bold**             bold (e.g. for "NOT")
 *   newline              line break
 * Greek letters and symbols are plain Unicode. The parser never produces HTML strings: it
 * returns a token tree that the UI renders with text nodes only.
 */
export type Token =
  | { t: 'text'; v: string }
  | { t: 'sup'; c: Token[] }
  | { t: 'sub'; c: Token[] }
  | { t: 'frac'; n: Token[]; d: Token[] }
  | { t: 'sqrt'; c: Token[] }
  | { t: 'b'; c: Token[] }
  | { t: 'br' };

const MAX_DEPTH = 8;

export function parseMarkup(src: string): Token[] {
  const p = new Parser(src.length > 20_000 ? src.slice(0, 20_000) : src);
  return p.seq(0, null);
}

class Parser {
  i = 0;
  constructor(private s: string) {}

  /** Parses until `end` char (or end of input). */
  seq(depth: number, end: string | null): Token[] {
    const out: Token[] = [];
    let buf = '';
    const flush = () => {
      if (buf) out.push({ t: 'text', v: buf });
      buf = '';
    };
    while (this.i < this.s.length) {
      const ch = this.s[this.i] as string;
      if (end && ch === end) {
        this.i++;
        flush();
        return out;
      }
      if (ch === '\n') {
        flush();
        out.push({ t: 'br' });
        this.i++;
        continue;
      }
      if (depth < MAX_DEPTH && (ch === '^' || ch === '_')) {
        const c = this.script(depth);
        if (c) {
          flush();
          out.push(ch === '^' ? { t: 'sup', c } : { t: 'sub', c });
          continue;
        }
      }
      if (depth < MAX_DEPTH && ch === '\\') {
        if (this.s.startsWith('\\frac{', this.i)) {
          const save = this.i;
          this.i += 6;
          const n = this.seq(depth + 1, '}');
          if (this.s[this.i] === '{') {
            this.i++;
            const d = this.seq(depth + 1, '}');
            flush();
            out.push({ t: 'frac', n, d });
            continue;
          }
          this.i = save;
        } else if (this.s.startsWith('\\sqrt{', this.i)) {
          this.i += 6;
          const c = this.seq(depth + 1, '}');
          flush();
          out.push({ t: 'sqrt', c });
          continue;
        }
      }
      if (depth < MAX_DEPTH && ch === '*' && this.s[this.i + 1] === '*') {
        const close = this.s.indexOf('**', this.i + 2);
        if (close > this.i + 2) {
          const inner = this.s.slice(this.i + 2, close);
          this.i = close + 2;
          flush();
          out.push({ t: 'b', c: new Parser(inner).seq(depth + 1, null) });
          continue;
        }
      }
      buf += ch;
      this.i++;
    }
    flush();
    return out;
  }

  /** At ^ or _: braced group, or a short run. Returns null if nothing follows (literal char). */
  script(depth: number): Token[] | null {
    const next = this.s[this.i + 1];
    if (next === '{') {
      this.i += 2;
      return this.seq(depth + 1, '}');
    }
    const isSup = this.s[this.i] === '^';
    const rest = this.s.slice(this.i + 1);
    const m = isSup ? /^([+\-−]?\d+|[+\-−]|[A-Za-z])/.exec(rest) : /^([A-Za-z0-9])/.exec(rest);
    if (!m) return null;
    this.i += 1 + (m[1] as string).length;
    return [{ t: 'text', v: (m[1] as string).replace('-', '−') }];
  }
}

/** Plain-text rendering for search, aria labels and previews. */
export function markupToText(src: string | undefined): string {
  if (!src) return '';
  const walk = (ts: Token[]): string =>
    ts
      .map((t) => {
        switch (t.t) {
          case 'text':
            return t.v;
          case 'br':
            return ' ';
          case 'sup':
            return `^${walk(t.c)}`;
          case 'sub':
            return `_${walk(t.c)}`;
          case 'frac':
            return `(${walk(t.n)})/(${walk(t.d)})`;
          case 'sqrt':
            return `√(${walk(t.c)})`;
          case 'b':
            return walk(t.c);
        }
      })
      .join('');
  return walk(parseMarkup(src));
}
