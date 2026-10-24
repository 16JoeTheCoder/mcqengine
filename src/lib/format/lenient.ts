/**
 * Forgiving JSON reader for AI output. Accepts: markdown code fences and prose around the JSON,
 * smart quotes used as string delimiters, trailing commas, // and /* comments, unquoted keys,
 * raw newlines inside strings, and LaTeX commands whose backslash was not escaped (\frac, \theta).
 * Every repair is reported so the user can see what was normalised.
 */
export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number,
  ) {
    super(message);
  }
}

export const MAX_INPUT_CHARS = 15_000_000;

/** Commands whose first letter collides with a JSON escape (\f \t \b \r \n \u). */
const COLLIDING = /^(frac|tfrac|dfrac|theta|times|tau|text|to|beta|bar|rho|right|rightarrow|nu|neq|nabla|ne|underline|uparrow|upsilon)(?![A-Za-z])/;

export function extractJsonText(raw: string, notes: Set<string>): string {
  let s = raw.replace(/^﻿/, '');
  const fence = /```[a-zA-Z0-9]*\s*\n?([\s\S]*?)```/g;
  const blocks = [...s.matchAll(fence)].map((m) => m[1] ?? '');
  if (blocks.length) {
    notes.add(blocks.length > 1 ? `Joined ${blocks.length} code blocks` : 'Removed markdown code fences');
    if (blocks.length > 1) {
      // Several fenced blocks: keep those that look like JSON objects/arrays.
      const json = blocks.filter((b) => /^\s*[[{]/.test(b));
      if (json.length > 1) return '[' + json.join(',') + ']';
      s = json[0] ?? blocks[0] ?? s;
    } else s = blocks[0] ?? s;
  }
  const start = s.search(/[[{]/);
  if (start < 0) return s.trim();
  const open = s[start] as string;
  const close = open === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  if (start > 0 && s.slice(0, start).trim()) notes.add('Ignored text before the JSON');
  if (end > start && s.slice(end + 1).trim()) notes.add('Ignored text after the JSON');
  return end > start ? s.slice(start, end + 1) : s.slice(start);
}

export function lenientParse(raw: string): { value: unknown; notes: string[] } {
  if (raw.length > MAX_INPUT_CHARS) throw new JsonSyntaxError('Input is larger than 15 MB', 1, 1);
  const notes = new Set<string>();
  const text = extractJsonText(raw, notes);
  const p = new LenientParser(text, notes);
  const value = p.parseTop();
  return { value, notes: [...notes] };
}

class LenientParser {
  i = 0;
  depth = 0;
  constructor(
    private s: string,
    private notes: Set<string>,
  ) {}

  fail(msg: string): never {
    const before = this.s.slice(0, this.i);
    const line = before.split('\n').length;
    const col = this.i - before.lastIndexOf('\n');
    throw new JsonSyntaxError(`${msg} (line ${line}, column ${col})`, line, col);
  }

  parseTop(): unknown {
    this.ws();
    if (this.i >= this.s.length) this.fail('No JSON found');
    const v = this.value();
    this.ws();
    if (this.i < this.s.length) this.fail(`Unexpected "${this.s[this.i]}" after the end of the JSON`);
    return v;
  }

  ws() {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ' ') this.i++;
      else if (c === '/' && this.s[this.i + 1] === '/') {
        const e = this.s.indexOf('\n', this.i);
        this.i = e < 0 ? this.s.length : e;
        this.notes.add('Removed comments');
      } else if (c === '/' && this.s[this.i + 1] === '*') {
        const e = this.s.indexOf('*/', this.i + 2);
        this.i = e < 0 ? this.s.length : e + 2;
        this.notes.add('Removed comments');
      } else return;
    }
  }

  value(): unknown {
    if (++this.depth > 64) this.fail('JSON is nested too deeply');
    try {
      this.ws();
      const c = this.s[this.i];
      if (c === '{') return this.object();
      if (c === '[') return this.array();
      if (c === '"' || c === '“' || c === '”') return this.string();
      if (c === "'") {
        this.notes.add('Converted single-quoted strings');
        return this.string();
      }
      if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.number();
      for (const [w, v] of [
        ['true', true],
        ['false', false],
        ['null', null],
        ['True', true],
        ['False', false],
        ['None', null],
      ] as const) {
        if (this.s.startsWith(w, this.i)) {
          this.i += w.length;
          if (w[0] === w[0]?.toUpperCase()) this.notes.add('Converted True/False/None');
          return v;
        }
      }
      return this.fail(c === undefined ? 'Unexpected end of input (is the JSON cut off?)' : `Unexpected "${c}"`);
    } finally {
      this.depth--;
    }
  }

  object(): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = Object.create(null);
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      let key: string;
      if (c === '"' || c === '“' || c === '”' || c === "'") key = this.string();
      else {
        const m = /^[A-Za-z_$][\w$-]*/.exec(this.s.slice(this.i, this.i + 100));
        if (!m) this.fail(c === undefined ? 'Unexpected end of input (is the JSON cut off?)' : `Expected a property name, found "${c}"`);
        key = m[0];
        this.i += key.length;
        this.notes.add('Quoted unquoted property names');
      }
      this.ws();
      if (this.s[this.i] !== ':') this.fail(`Expected ":" after "${key}"`);
      this.i++;
      const v = this.value();
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') this.notes.add('Dropped unsafe property names');
      else out[key] = v;
      this.ws();
      const d = this.s[this.i];
      if (d === ',') {
        this.i++;
        this.ws();
        if (this.s[this.i] === '}') {
          this.notes.add('Removed trailing commas');
          this.i++;
          return out;
        }
        continue;
      }
      if (d === '}') {
        this.i++;
        return out;
      }
      if (d === '"' || d === '“') {
        this.notes.add('Inserted missing commas');
        continue;
      }
      this.fail(d === undefined ? 'Unexpected end of input (is the JSON cut off?)' : `Expected "," or "}" but found "${d}"`);
    }
  }

  array(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const d = this.s[this.i];
      if (d === ',') {
        this.i++;
        this.ws();
        if (this.s[this.i] === ']') {
          this.notes.add('Removed trailing commas');
          this.i++;
          return out;
        }
        continue;
      }
      if (d === ']') {
        this.i++;
        return out;
      }
      if (d === '{' || d === '"') {
        this.notes.add('Inserted missing commas');
        continue;
      }
      this.fail(d === undefined ? 'Unexpected end of input (is the JSON cut off?)' : `Expected "," or "]" but found "${d}"`);
    }
  }

  string(): string {
    const open = this.s[this.i] as string;
    if (open === '“' || open === '”') this.notes.add('Replaced smart quotes');
    const closers = open === "'" ? ["'"] : open === '"' ? ['"'] : ['”', '"', '“'];
    this.i++;
    let out = '';
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) this.fail('Unterminated string (is the JSON cut off?)');
      if (closers.includes(c)) {
        // A smart quote inside a straight-quoted string is content; only treat it as a closer
        // when what follows looks structural.
        if (open !== '"' && open !== "'" && c !== '"') {
          const after = this.s.slice(this.i + 1).match(/^\s*(.)/)?.[1];
          if (after && !',:}]'.includes(after)) {
            out += c;
            this.i++;
            continue;
          }
        }
        this.i++;
        return out;
      }
      if (c === '\\') {
        const n = this.s[this.i + 1];
        const rest = this.s.slice(this.i + 1, this.i + 14);
        if (n && 'ftbrnu'.includes(n) && COLLIDING.test(rest)) {
          this.notes.add('Kept unescaped LaTeX backslashes (\\frac, \\theta...)');
          out += '\\';
          this.i++;
          continue;
        }
        switch (n) {
          case '"':
          case '\\':
          case '/':
          case "'":
            out += n;
            this.i += 2;
            continue;
          case 'n':
            out += '\n';
            this.i += 2;
            continue;
          case 't':
            out += '\t';
            this.i += 2;
            continue;
          case 'r':
            this.i += 2;
            continue;
          case 'b':
          case 'f':
            this.i += 2;
            continue;
          case 'u': {
            const hex = this.s.slice(this.i + 2, this.i + 6);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              out += String.fromCharCode(parseInt(hex, 16));
              this.i += 6;
              continue;
            }
            break;
          }
        }
        // Unknown escape such as \lambda or \Omega: keep the backslash literally.
        this.notes.add('Kept unescaped LaTeX backslashes (\\frac, \\theta...)');
        out += '\\';
        this.i++;
        continue;
      }
      if (c === '\n' || c === '\r') {
        this.notes.add('Converted raw line breaks inside strings');
        if (c === '\n') out += '\n';
        this.i++;
        continue;
      }
      out += c;
      this.i++;
    }
  }

  number(): number {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) this.fail('Invalid number');
    this.i += m[0].length;
    return Number(m[0]);
  }
}
