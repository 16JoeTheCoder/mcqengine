import { LETTERS, type GradeBoundary } from '../types';
import { sanitizeSvg } from './svg';

export const FORMAT_ID = 'dmc-pack/1';

export interface Issue {
  path: string;
  message: string;
  /** Warnings that need explicit confirmation in the wizard (count mismatches, gaps). */
  confirm?: boolean;
}

export type RawFigure =
  | { kind: 'svg'; svg: string; alt?: string }
  | { kind: 'file'; path: string; alt?: string }
  | { kind: 'needed'; note?: string };

export interface NOption {
  text?: string;
  figure?: RawFigure;
}

export interface NRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NQuestion {
  n: number;
  page?: number;
  /** Bare papers: the question's rectangle on the question paper PDF. */
  snip?: NRect;
  stem?: string;
  image?: string; // file path of a whole-question screenshot
  figure?: RawFigure;
  options?: NOption[];
  table?: { columns: string[]; rows: string[][] };
  answer: number | null;
  topic?: string;
  explanation?: string;
  uncertain?: string;
}

export interface NPaper {
  id: string;
  title: string;
  group: string[];
  questionCount: number;
  timeLimitMin: number | null;
  optionCount: number;
  questions: NQuestion[];
  boundaries?: GradeBoundary[];
  /** PDF paths inside the zip or folder. */
  pdf?: { questionPaper?: string; markScheme?: string };
  /** No typed content: practised from the PDF, snipped question by question. */
  bare?: boolean;
}

export interface NDoc {
  pack?: { title?: string; subject?: string };
  papers: NPaper[];
  answers: { paper: string; key: (number | null)[]; path: string }[];
}

export interface ValidationResult {
  doc: NDoc;
  errors: Issue[];
  warnings: Issue[];
  notes: string[];
}

export const LIMITS = {
  papers: 500,
  questionsPerPaper: 200,
  totalQuestions: 20_000,
  text: 5000,
  title: 200,
  groupDepth: 4,
};

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ',
  Omega: 'Ω', times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  ne: '≠', neq: '≠', approx: '≈', propto: '∝', infty: '∞', degree: '°', circ: '°', to: '→',
  rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', sim: '~', equiv: '≡', partial: '∂', nabla: '∇',
  hbar: 'ħ', ell: 'ℓ', angle: '∠', perp: '⊥', parallel: '∥', sum: 'Σ', int: '∫', prime: '′',
  ldots: '…', dots: '…', cdots: '⋯', quad: ' ', qquad: '  ', ',': ' ', ';': ' ', '%': '%',
  text: '', mathrm: '', mathit: '', rm: '', left: '', right: '',
};

/** Converts common LaTeX commands to the DMC markup / Unicode; strips $ delimiters around maths. */
export function normaliseText(s: string, notes: Set<string>): string {
  let out = s;
  if (/\$[^$\n]*[\\^_][^$\n]*\$/.test(out)) {
    out = out.replace(/\$([^$\n]*[\\^_][^$\n]*)\$/g, '$1');
    notes.add('Removed $…$ maths delimiters');
  }
  if (out.includes('\\')) {
    const before = out;
    out = out
      .replace(/\\(text|mathrm|mathit|rm)\{([^{}]*)\}/g, '$2')
      .replace(/\\(dfrac|tfrac)\{/g, '\\frac{')
      .replace(/\\([A-Za-z]+|[,;%])(?![A-Za-z])/g, (m, name: string) => {
        if (name === 'frac' || name === 'sqrt') return m;
        const g = GREEK[name];
        return g === undefined ? m : g;
      })
      .replace(/\\([{}])/g, '$1');
    if (out !== before) notes.add('Converted LaTeX commands to symbols (\\lambda → λ)');
  }
  if (/[\u200b-\u200d\uFEFF]/.test(out)) {
    out = out.replace(/[\u200b-\u200d\uFEFF]/g, '');
    notes.add('Removed invisible characters');
  }
  return out;
}

const KEY_ALIASES: Record<string, string> = {
  questions: 'questions', papers: 'papers', paper: 'paper', answers: 'answers', format: 'format', pack: 'pack',
  id: 'id', title: 'title', name: 'title', subject: 'subject', group: 'group', groups: 'group', tags: 'group',
  questioncount: 'questionCount', question_count: 'questionCount', expectedcount: 'questionCount',
  numquestions: 'questionCount', count: 'questionCount',
  timelimitminutes: 'timeLimitMinutes', time_limit_minutes: 'timeLimitMinutes', timelimit: 'timeLimitMinutes',
  minutes: 'timeLimitMinutes', duration: 'timeLimitMinutes',
  optioncount: 'optionCount', option_count: 'optionCount',
  n: 'n', number: 'n', num: 'n', no: 'n', q: 'n', qnum: 'n', question_number: 'n', questionnumber: 'n',
  stem: 'stem', question: 'stem', text: 'stem', prompt: 'stem',
  options: 'options', choices: 'options', answers_options: 'options',
  table: 'table', columns: 'columns', rows: 'rows', header: 'columns', headers: 'columns',
  answer: 'answer', correct: 'answer', correctanswer: 'answer', correct_answer: 'answer',
  figure: 'figure', diagram: 'figure', image: 'image', svg: 'svg', alt: 'alt', needed: 'needed', note: 'note',
  file: 'file', page: 'page', pg: 'page', snip: 'snip', bare: 'bare', pdf: 'pdf', pdfs: 'pdf', topic: 'topic',
  questionpaper: 'questionPaper', question_paper: 'questionPaper', qp: 'questionPaper',
  markscheme: 'markScheme', mark_scheme: 'markScheme', ms: 'markScheme', explanation: 'explanation', uncertain: 'uncertain', key: 'key',
  paperid: 'paper', paper_id: 'paper',
  gradeboundaries: 'gradeBoundaries', grade_boundaries: 'gradeBoundaries', boundaries: 'gradeBoundaries',
};

/** Grade boundaries as { "A": 31, "B": 27 } or [{ "grade": "A", "min": 31 }], in raw marks. */
export function parseBoundaries(v: unknown, max: number): GradeBoundary[] | string {
  const list: [string, unknown][] = Array.isArray(v)
    ? v.map((x) => (isObj(x) ? [String(x.grade ?? ''), x.min ?? x.marks] : ['', null]))
    : isObj(v)
      ? Object.entries(v)
      : [];
  if (!list.length) return 'Expected grade boundaries like { "A": 31, "B": 27 }';
  const out: GradeBoundary[] = [];
  for (const [g, m] of list) {
    const grade = g.trim().slice(0, 8);
    const min = Number(m);
    if (!grade || !Number.isInteger(min) || min < 0 || min > max) return `Boundary "${g}" needs whole marks from 0 to ${max}`;
    out.push({ grade, min });
  }
  out.sort((a, b) => b.min - a.min);
  return out;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Canonicalises property names (case and common aliases), reporting what changed. */
function canon(o: Obj, notes: Set<string>, context: 'question' | 'paper' | 'other'): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    let key = KEY_ALIASES[k.toLowerCase()] ?? k;
    // "text" means stem on a question but text on an option; "key" means answer key on answers.
    if (context !== 'question' && k.toLowerCase() === 'text') key = 'text';
    if (context === 'question' && k.toLowerCase() === 'key') key = 'answer';
    if (context === 'paper' && k.toLowerCase() === 'paper') key = 'paper';
    if (key !== k) notes.add(`Renamed property "${k}" to "${key}"`);
    if (!(key in out)) out[key] = v;
  }
  return out;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Parses one answer value; returns index, null (unkeyed) or undefined (invalid). */
export function parseAnswer(v: unknown, notes: Set<string>): number | null | undefined {
  if (v === null || v === undefined || v === '' || v === '?') return null;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*[([]?\s*([A-Ea-e])\s*[)\].:]?\s*$/.exec(v);
  if (!m) return undefined;
  const letter = (m[1] as string).toUpperCase();
  if (letter !== v) notes.add('Normalised answer letters (b → B, (C) → C)');
  return LETTERS.indexOf(letter as never);
}

/** Parses an answer key string like "ACDBA…", "1A 2C 3D", "A,C,D". `?` or `-` marks unknown. */
export function parseKey(v: unknown, notes: Set<string>): (number | null)[] | undefined {
  if (Array.isArray(v)) {
    const out: (number | null)[] = [];
    for (const x of v) {
      const a = parseAnswer(x, notes);
      if (a === undefined) return undefined;
      out.push(a);
    }
    return out;
  }
  if (isObj(v)) {
    // { "1": "A", "2": "C" }
    const entries = Object.entries(v)
      .map(([k, x]) => [parseInt(k, 10), x] as const)
      .filter(([k]) => Number.isFinite(k))
      .sort((a, b) => a[0] - b[0]);
    const max = entries.length ? (entries[entries.length - 1]?.[0] ?? 0) : 0;
    const out: (number | null)[] = new Array(max).fill(null);
    for (const [k, x] of entries) {
      const a = parseAnswer(x, notes);
      if (a === undefined || k < 1) return undefined;
      out[k - 1] = a;
    }
    notes.add('Converted a numbered answer map to a key string');
    return out;
  }
  if (typeof v !== 'string') return undefined;
  let s = v.trim();
  const stripped = s.replace(/\d+\s*[.):-]?\s*/g, '').replace(/[\s,;|/]+/g, '');
  if (stripped !== s) notes.add('Cleaned the answer key string (numbers, spaces, commas)');
  s = stripped;
  const out: (number | null)[] = [];
  for (const ch of s) {
    if (ch === '?' || ch === '-' || ch === '_') out.push(null);
    else {
      const i = LETTERS.indexOf(ch.toUpperCase() as never);
      if (i < 0) return undefined;
      out.push(i);
    }
  }
  if (/[a-e]/.test(s)) notes.add('Normalised answer letters (b → B, (C) → C)');
  return out;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Validates a parsed document strictly, after canonicalising tolerated variations.
 * `files` lists image paths available in a zip or folder import.
 */
export function validateDoc(input: unknown, files: ReadonlySet<string> = new Set(), notesIn: string[] = []): ValidationResult {
  const notes = new Set<string>(notesIn);
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string, confirm = false) => warnings.push({ path, message, confirm });
  const doc: NDoc = { papers: [], answers: [] };
  const referenced = new Set<string>();
  /**
   * Strict diagram mapping: a file named images/<paper id>/q<NN>[-X].png must belong to that
   * paper and question number. A mismatch is an error, because it means a diagram is attached
   * to the wrong question.
   */
  const checkName = (file: string, paperId: string, n: number, path: string) => {
    const m = /^images\/([^/]+)\/q(\d+)(?:-[A-E])?\.[a-z]+$/i.exec(file);
    if (!m) return;
    if (slugify(m[1] as string) !== paperId || Number(m[2]) !== n)
      err(path, `Image "${file}" is named for paper "${m[1]}" question ${Number(m[2])}, but it is attached to paper "${paperId}" question ${n}. The diagram is probably on the wrong question.`);
  };

  let root: unknown = input;
  if (Array.isArray(root)) {
    // A bare array of papers, or several JSON blocks joined.
    const parts = root.filter(isObj);
    const merged: Obj = { papers: [], answers: [] };
    for (const p of parts) {
      const c = canon(p, notes, 'other');
      if (Array.isArray(c.papers)) (merged.papers as unknown[]).push(...c.papers);
      else if (Array.isArray(c.questions)) (merged.papers as unknown[]).push(p);
      if (Array.isArray(c.answers)) (merged.answers as unknown[]).push(...c.answers);
      if (isObj(c.pack) && !merged.pack) merged.pack = c.pack;
    }
    notes.add('Combined several JSON objects into one pack document');
    root = merged;
  }
  if (!isObj(root)) {
    err('$', 'Expected a JSON object with a "papers" array');
    return { doc, errors, warnings, notes: [...notes] };
  }
  let r = canon(root, notes, 'other');
  if (!('papers' in r) && Array.isArray(r.questions)) {
    notes.add('Wrapped a single paper in a "papers" array');
    r = { papers: [r] };
  }
  if (r.format !== undefined && r.format !== FORMAT_ID) {
    if (typeof r.format === 'string' && /^dmc-pack\/1(\.\d+)?$/.test(r.format)) notes.add(`Treated format "${r.format}" as ${FORMAT_ID}`);
    else err('format', `Unsupported format "${String(r.format)}"; this app reads "${FORMAT_ID}"`);
  }
  if (isObj(r.pack)) {
    const pk = canon(r.pack, notes, 'other');
    doc.pack = {};
    if (typeof pk.title === 'string' && pk.title.trim()) doc.pack.title = pk.title.trim().slice(0, LIMITS.title);
    if (typeof pk.subject === 'string' && pk.subject.trim()) doc.pack.subject = pk.subject.trim().slice(0, 80);
  }
  const papers = r.papers === undefined ? [] : r.papers;
  if (!Array.isArray(papers)) err('papers', 'Expected an array of papers');
  else if (papers.length > LIMITS.papers) err('papers', `Too many papers (${papers.length}); the limit per import is ${LIMITS.papers}`);
  else {
    let totalQ = 0;
    const ids = new Set<string>();
    papers.forEach((raw, pi) => {
      const pp = `papers[${pi}]`;
      if (!isObj(raw)) return err(pp, 'Expected a paper object');
      const p = canon(raw, notes, 'paper');
      const title = typeof p.title === 'string' ? normaliseText(p.title.trim(), notes).slice(0, LIMITS.title) : '';
      if (!title) err(`${pp}.title`, 'Missing paper title');
      let id = typeof p.id === 'string' || typeof p.id === 'number' ? String(p.id) : '';
      const slug = slugify(id || title);
      if (!id) notes.add('Generated missing paper ids from titles');
      else if (slug !== id) notes.add(`Normalised paper id "${id}" to "${slug}"`);
      id = slug;
      if (!id) err(`${pp}.id`, 'Missing paper id (use lowercase letters, digits and hyphens)');
      else if (ids.has(id)) err(`${pp}.id`, `Duplicate paper id "${id}" in this import`);
      ids.add(id);

      let group: string[] = [];
      if (typeof p.group === 'string') {
        group = [p.group];
        notes.add('Converted text group to a one-level group path');
      } else if (Array.isArray(p.group)) group = p.group.map((g) => String(g).trim()).filter(Boolean);
      else if (p.group !== undefined) err(`${pp}.group`, 'Expected an array of strings, e.g. ["2025", "May/June"]');
      if (group.length > LIMITS.groupDepth) err(`${pp}.group`, `Group path is deeper than ${LIMITS.groupDepth} levels`);
      group = group.map((g) => g.slice(0, 60));

      const bare = p.bare === true;
      const qsRaw = p.questions === undefined && bare ? [] : p.questions;
      if (!Array.isArray(qsRaw)) {
        err(`${pp}.questions`, 'Expected an array of questions');
        return;
      }
      if (qsRaw.length > LIMITS.questionsPerPaper) {
        err(`${pp}.questions`, `Too many questions (${qsRaw.length}); the limit is ${LIMITS.questionsPerPaper}`);
        return;
      }
      totalQ += qsRaw.length;

      let questionCount = typeof p.questionCount === 'number' ? p.questionCount : NaN;
      if (typeof p.questionCount === 'string' && /^\d+$/.test(p.questionCount)) questionCount = Number(p.questionCount);
      if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > LIMITS.questionsPerPaper) {
        if (p.questionCount === undefined) {
          const maxN = Math.max(0, ...qsRaw.map((q) => (isObj(q) ? Number(canon(q, new Set(), 'question').n) || 0 : 0)));
          questionCount = Math.max(maxN, qsRaw.length);
          warn(`${pp}.questionCount`, `No questionCount given; assumed ${questionCount} from the questions found. Check it against the paper.`, true);
        } else err(`${pp}.questionCount`, `Expected a whole number from 1 to ${LIMITS.questionsPerPaper}`);
      }

      let timeLimitMin: number | null = null;
      if (p.timeLimitMinutes !== undefined && p.timeLimitMinutes !== null) {
        const t = Number(p.timeLimitMinutes);
        if (!Number.isFinite(t) || t < 1 || t > 600) err(`${pp}.timeLimitMinutes`, 'Expected minutes from 1 to 600');
        else timeLimitMin = Math.round(t);
      }

      // Option count: explicit, else the most common options length.
      let optionCount = Number(p.optionCount);
      if (p.optionCount !== undefined && (!Number.isInteger(optionCount) || optionCount < 2 || optionCount > 5)) {
        err(`${pp}.optionCount`, 'Expected 2, 3, 4 or 5');
        optionCount = 4;
      }
      if (p.optionCount === undefined) {
        const lens = qsRaw
          .map((q) => (isObj(q) ? canon(q, new Set(), 'question') : {}))
          .map((q: Obj) => (Array.isArray(q.options) ? q.options.length : isObj(q.table) && Array.isArray(q.table.rows) ? q.table.rows.length : 0))
          .filter((n) => n >= 2 && n <= 5);
        const freq = new Map<number, number>();
        for (const l of lens) freq.set(l, (freq.get(l) ?? 0) + 1);
        optionCount = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 4;
      }

      const paper: NPaper = { id, title, group, questionCount, timeLimitMin, optionCount, questions: [], ...(bare ? { bare } : {}) };
      if (p.pdf !== undefined) {
        const pd = isObj(p.pdf) ? canon(p.pdf, notes, 'other') : null;
        if (!pd) err(`${pp}.pdf`, 'Expected { "questionPaper": "pdfs/….pdf", "markScheme": "pdfs/….pdf" }');
        else {
          paper.pdf = {};
          for (const k of ['questionPaper', 'markScheme'] as const) {
            const v = pd[k];
            if (v === undefined) continue;
            if (typeof v !== 'string' || !/\.pdf$/i.test(v)) err(`${pp}.pdf.${k}`, 'Expected a .pdf path inside the zip');
            else if (!files.has(v)) err(`${pp}.pdf.${k}`, `PDF "${v}" was not found in the zip or folder`);
            else paper.pdf[k] = v;
          }
        }
      }
      if (bare && !paper.pdf?.questionPaper) err(`${pp}.pdf.questionPaper`, 'A bare paper needs its question paper PDF');
      if (p.gradeBoundaries !== undefined && p.gradeBoundaries !== null) {
        const b = parseBoundaries(p.gradeBoundaries, Number.isInteger(questionCount) ? questionCount : LIMITS.questionsPerPaper);
        if (typeof b === 'string') err(`${pp}.gradeBoundaries`, b);
        else paper.boundaries = b;
      }
      const seenN = new Map<number, number>();
      const sig = new Map<string, number>();
      qsRaw.forEach((rq, qi) => {
        const qp = `${pp}.questions[${qi}]`;
        if (!isObj(rq)) return err(qp, 'Expected a question object');
        const q = canon(rq, notes, 'question');
        let n = q.n;
        if (typeof n === 'string' && /^\s*Q?\d+\s*$/i.test(n)) {
          n = Number(n.replace(/\D/g, ''));
          notes.add('Converted question numbers given as text');
        }
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
          err(`${qp}.n`, 'Missing or invalid question number "n" (a whole number from 1)');
          return;
        }
        if (Number.isInteger(questionCount) && n > questionCount) err(`${qp}.n`, `Question ${n} is beyond questionCount ${questionCount}`);
        if (seenN.has(n)) err(`${qp}.n`, `Duplicate question number ${n} (also at questions[${seenN.get(n)}])`);
        seenN.set(n, qi);

        const out: NQuestion = { n, answer: null };
        if (q.page !== undefined && q.page !== null) {
          const pg = Number(q.page);
          if (!Number.isInteger(pg) || pg < 1 || pg > 500) err(`${qp}.page`, 'Expected the PDF page number, a whole number from 1');
          else out.page = pg;
        }
        const text = (v: unknown, path: string, required: boolean, max = LIMITS.text): string | undefined => {
          if (v === undefined || v === null || v === '') {
            if (required) err(path, 'Missing text');
            return undefined;
          }
          if (typeof v === 'number') v = String(v);
          if (typeof v !== 'string') {
            err(path, 'Expected text');
            return undefined;
          }
          if (v.length > max) {
            err(path, `Text is longer than ${max} characters`);
            return undefined;
          }
          return normaliseText(v, notes);
        };

        if (q.image !== undefined) {
          if (typeof q.image === 'string' && q.image.trim()) {
            out.image = q.image.trim();
            referenced.add(out.image);
            checkName(out.image, id, n, `${qp}.image`);
            if (!files.has(out.image)) err(`${qp}.image`, `Image "${out.image}" was not found. Import a zip or folder that contains it.`);
          } else err(`${qp}.image`, 'Expected an image file path');
        }
        if (q.snip !== undefined) {
          const r = isObj(q.snip) ? q.snip : {};
          const fr = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
          const pg = Number(r.page);
          if (!Number.isInteger(pg) || pg < 1 || pg > 500 || !fr(r.x) || !fr(r.y) || !fr(r.w) || !fr(r.h) || (r.w as number) <= 0 || (r.h as number) <= 0 || (r.x as number) + (r.w as number) > 1.0001 || (r.y as number) + (r.h as number) > 1.0001)
            err(`${qp}.snip`, 'Expected { "page": 1, "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1 } inside the page');
          else if (!paper.pdf?.questionPaper) err(`${qp}.snip`, 'A snip needs the paper\'s "pdf.questionPaper"');
          else out.snip = { page: pg, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number };
        }
        out.stem = text(q.stem, `${qp}.stem`, !out.image && !bare);

        const fig = (v: unknown, path: string): RawFigure | undefined => {
          if (v === undefined || v === null) return undefined;
          if (typeof v === 'string') {
            if (v.trim().startsWith('<svg')) v = { svg: v };
            else v = { file: v };
          }
          if (!isObj(v)) {
            err(path, 'Expected a figure object');
            return undefined;
          }
          const f = canon(v, notes, 'other');
          const alt = typeof f.alt === 'string' ? f.alt.slice(0, 300) : undefined;
          if (typeof f.svg === 'string') {
            const res = sanitizeSvg(f.svg);
            if (!res.svg) {
              err(`${path}.svg`, `SVG rejected: ${res.removed.join(', ')}`);
              return undefined;
            }
            if (res.removed.length) warn(`${path}.svg`, `Removed unsafe SVG parts: ${[...new Set(res.removed)].slice(0, 6).join(', ')}`);
            return { kind: 'svg', svg: res.svg, ...(alt ? { alt } : {}) };
          }
          const file = typeof f.file === 'string' ? f.file : typeof f.image === 'string' ? f.image : undefined;
          if (file) {
            referenced.add(file.trim());
            checkName(file.trim(), id, n as number, path);
            if (!files.has(file.trim())) {
              warn(path, `Image "${file}" was not found; the question is marked "needs figure".`);
              return { kind: 'needed', note: `Missing image ${file}` };
            }
            return { kind: 'file', path: file.trim(), ...(alt ? { alt } : {}) };
          }
          if (f.needed === true || f.needed === 'true') return { kind: 'needed', ...(typeof f.note === 'string' ? { note: f.note.slice(0, 300) } : {}) };
          err(path, 'A figure needs "svg", "file" or "needed": true');
          return undefined;
        };
        const f = fig(q.figure, `${qp}.figure`);
        if (f) out.figure = f;

        if (q.table !== undefined) {
          const t = isObj(q.table) ? canon(q.table, notes, 'other') : null;
          if (!t || !Array.isArray(t.rows)) err(`${qp}.table`, 'Expected { "columns": [...], "rows": [[...], ...] }');
          else {
            const columns = Array.isArray(t.columns) ? t.columns.map((c) => normaliseText(String(c ?? ''), notes)) : [];
            const rows = t.rows.map((row, ri) => {
              if (!Array.isArray(row)) {
                err(`${qp}.table.rows[${ri}]`, 'Expected an array of cells');
                return [];
              }
              return row.map((c) => normaliseText(String(c ?? ''), notes).slice(0, 500));
            });
            if (rows.length !== optionCount) err(`${qp}.table.rows`, `Expected ${optionCount} rows (one per option), found ${rows.length}`);
            const width = columns.length || rows[0]?.length || 0;
            rows.forEach((row, ri) => {
              if (row.length !== width) err(`${qp}.table.rows[${ri}]`, `Expected ${width} cells, found ${row.length}`);
            });
            out.table = { columns, rows };
          }
        }

        if (q.options !== undefined && !(Array.isArray(q.options) && !q.options.length && (out.table || out.image))) {
          if (!Array.isArray(q.options)) err(`${qp}.options`, 'Expected an array of options');
          else {
            let opts = q.options;
            // Strip "A. " / "(B) " prefixes LLMs like to add.
            if (opts.every((o, i) => typeof o === 'string' && new RegExp(`^\\s*\\(?${LETTERS[i]}[).:]\\s+`).test(o))) {
              opts = opts.map((o) => (o as string).replace(/^\s*\(?[A-E][).:]\s+/, ''));
              notes.add('Removed "A." style prefixes from options');
            }
            if (opts.length !== optionCount)
              err(`${qp}.options`, `Expected ${optionCount} options, found ${opts.length}`);
            out.options = opts.map((o, oi) => {
              const op = `${qp}.options[${oi}]`;
              if (typeof o === 'string' || typeof o === 'number') {
                const t = text(String(o), op, true, 1000);
                return t === undefined ? {} : { text: t };
              }
              if (isObj(o)) {
                const oc = canon(o, notes, 'other');
                const res: NOption = {};
                const t = text(oc.text, `${op}.text`, false, 1000);
                if (t !== undefined) res.text = t;
                const of = fig(oc.svg !== undefined ? { svg: oc.svg } : (oc.figure ?? (oc.file ? { file: oc.file } : oc.image ? { file: oc.image } : undefined)), `${op}.figure`);
                if (of) res.figure = of;
                if (!res.text && !res.figure) err(op, 'Option needs "text" or a figure');
                return res;
              }
              err(op, 'Expected option text');
              return {};
            });
          }
        } else if (!out.table && !out.image && !bare) err(`${qp}.options`, `Missing options (expected ${optionCount})`);

        const a = parseAnswer(q.answer, notes);
        if (a === undefined) err(`${qp}.answer`, `Expected a letter ${LETTERS.slice(0, optionCount).join('/')} or null, found ${JSON.stringify(q.answer)}`);
        else if (a !== null && a >= optionCount) err(`${qp}.answer`, `Answer ${LETTERS[a]} is outside the ${optionCount} options`);
        else out.answer = a;

        const topic = text(q.topic, `${qp}.topic`, false, 80);
        if (topic) out.topic = topic;
        const ex = text(q.explanation, `${qp}.explanation`, false);
        if (ex) out.explanation = ex;
        const unc = text(q.uncertain, `${qp}.uncertain`, false, 500);
        if (unc) {
          out.uncertain = unc;
          warn(qp, `Transcriber flagged Q${n}: ${unc}`);
        }
        if (q.uncertain === true) {
          out.uncertain = 'Flagged as uncertain';
          warn(qp, `Transcriber flagged Q${n} as uncertain`);
        }

        const s = JSON.stringify([out.stem, out.options, out.table]);
        if (out.stem && sig.has(s)) warn(qp, `Question ${n} is identical to question ${sig.get(s)}; was it copied by mistake?`, true);
        sig.set(s, n);
        paper.questions.push(out);
      });

      paper.questions.sort((a, b) => a.n - b.n);
      if (bare && Number.isInteger(questionCount)) {
        const have = new Set(paper.questions.map((q) => q.n));
        for (let k = 1; k <= questionCount; k++) if (!have.has(k)) paper.questions.push({ n: k, answer: null });
        paper.questions.sort((a, b) => a.n - b.n);
      }
      if (Number.isInteger(questionCount)) {
        const have = new Set(paper.questions.map((q) => q.n));
        const maxN = Math.max(0, ...have);
        const gaps: number[] = [];
        for (let k = 1; k <= maxN; k++) if (!have.has(k)) gaps.push(k);
        if (gaps.length)
          warn(`${pp}.questions`, `Numbering has gaps: missing ${gaps.length > 12 ? gaps.slice(0, 12).join(', ') + '…' : gaps.join(', ')}`, true);
        if (have.size && have.size < questionCount && !gaps.length)
          warn(`${pp}.questions`, `Found ${plural(have.size, 'question')} of ${questionCount}. Fine if the rest arrive in another chunk.`, true);
      }
      doc.papers.push(paper);
    });
    if (totalQ > LIMITS.totalQuestions) err('papers', `Too many questions in one import (${totalQ})`);
  }

  if (r.answers !== undefined) {
    if (!Array.isArray(r.answers)) err('answers', 'Expected an array like [{ "paper": "id", "key": "ABCD…" }]');
    else
      r.answers.forEach((raw, ai) => {
        const ap = `answers[${ai}]`;
        if (!isObj(raw)) return err(ap, 'Expected { "paper": "id", "key": "ABCD…" }');
        const a = canon(raw, notes, 'paper');
        const pid = typeof a.paper === 'string' ? slugify(a.paper) : typeof a.id === 'string' ? slugify(a.id) : '';
        if (!pid) return err(`${ap}.paper`, 'Missing paper id');
        const key = parseKey(a.key ?? a.answers, notes);
        if (!key) return err(`${ap}.key`, 'Expected a string of letters like "ACDBA…" (use ? for unknown)');
        doc.answers.push({ paper: pid, key, path: ap });
      });
  }
  // Images in the zip that no question uses usually mean a diagram went to the wrong question.
  const unused = [...files].filter((f) => /\.(png|jpe?g|webp|gif|svg)$/i.test(f) && !referenced.has(f));
  if (unused.length)
    warn('images', `${unused.length} image${unused.length === 1 ? ' is' : 's are'} in the zip but used by no question: ${unused.slice(0, 8).join(', ')}${unused.length > 8 ? '…' : ''}. Check that every diagram is attached to the right question.`, true);
  if (!doc.papers.length && !doc.answers.length && !errors.length) err('papers', 'Nothing to import: no papers and no answers found');
  return { doc, errors, warnings, notes: [...notes] };
}
