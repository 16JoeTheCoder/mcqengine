import type { Figure, OptionContent, Paper, PaperMeta, Question, QuestionOverride } from '../types';
import { LETTERS } from '../types';
import type { Issue, NDoc, NPaper, NQuestion, RawFigure } from './validate';

/** 53-bit FNV-1a style hash, hex. Used for change detection, not security. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const figSig = (f?: Figure) =>
  !f ? null : f.kind === 'svg' ? ['svg', f.svg] : f.kind === 'image' ? ['img', f.imageId] : ['needed'];

/** Content hash of what the student sees (stem, options, figures). Excludes answer and notes. */
export function questionHash(q: Pick<Question, 'stem' | 'image' | 'figure' | 'options' | 'table' | 'optionCount'>): string {
  return hashString(
    JSON.stringify([
      q.stem ?? null,
      q.image ?? null,
      figSig(q.figure),
      q.options?.map((o) => [o.text ?? null, figSig(o.figure)]) ?? null,
      q.table ?? null,
      q.optionCount,
    ]),
  );
}

export const questionId = (paperId: string, n: number) => `${paperId}#${n}`;
export const paperKey = (packId: string, paperId: string) => `${packId}::${paperId}`;

function toFigure(f: RawFigure | undefined, images: ReadonlyMap<string, string>): Figure | undefined {
  if (!f) return undefined;
  if (f.kind === 'svg') return { kind: 'svg', svg: f.svg, ...(f.alt ? { alt: f.alt } : {}) };
  if (f.kind === 'needed') return { kind: 'needed', ...(f.note ? { note: f.note } : {}) };
  const id = images.get(f.path);
  return id ? { kind: 'image', imageId: id, ...(f.alt ? { alt: f.alt } : {}) } : { kind: 'needed', note: `Missing image ${f.path}` };
}

export function toQuestion(paperId: string, optionCount: number, q: NQuestion, images: ReadonlyMap<string, string>): Question {
  const out: Question = { id: questionId(paperId, q.n), n: q.n, optionCount, answer: q.answer, hash: '' };
  if (q.stem !== undefined) out.stem = q.stem;
  if (q.image) {
    const id = images.get(q.image);
    if (id) out.image = id;
  }
  const fig = toFigure(q.figure, images);
  if (fig) out.figure = fig;
  if (q.options) {
    out.options = q.options.map((o) => {
      const r: OptionContent = {};
      if (o.text !== undefined) r.text = o.text;
      const of = toFigure(o.figure, images);
      if (of) r.figure = of;
      return r;
    });
  }
  if (q.table) out.table = q.table;
  if (q.topic) out.topic = q.topic;
  if (q.explanation) out.explanation = q.explanation;
  if (q.uncertain) out.uncertain = q.uncertain;
  out.hash = questionHash(out);
  return out;
}

/** Applies a stored override (Fix this question) to a question. */
export function applyOverride(q: Question, o?: QuestionOverride): Question {
  if (!o) return q;
  const r: Question = { ...q };
  if (o.stem !== undefined) r.stem = o.stem;
  if (o.options && r.options) r.options = r.options.map((op, i) => (o.options?.[i] !== undefined ? { ...op, text: o.options[i] } : op));
  if (o.answer !== undefined) r.answer = o.answer;
  if (o.figure !== undefined) r.figure = o.figure;
  return r;
}

export interface PaperOverrides {
  title?: string;
  group?: string[];
  questionCount?: number;
  timeLimitMin?: number;
}

export interface PaperPlan {
  id: string;
  title: string;
  status: 'new' | 'merge' | 'identical';
  added: number;
  unchanged: number;
  keyed: number;
}

export interface MergeResult {
  papers: Paper[];
  plan: PaperPlan[];
  answersApplied: number;
  conflicts: Issue[];
}

export const DEFAULT_SEC_PER_Q = 90;

export function metaOf(p: Paper): PaperMeta {
  return {
    id: p.id,
    title: p.title,
    group: p.group,
    questionCount: p.questionCount,
    timeLimitMin: p.timeLimitMin,
    optionCount: p.optionCount,
    present: p.questions.length,
    keyed: p.questions.filter((q) => q.answer !== null).length,
    figuresNeeded: p.questions.filter((q) => q.figure?.kind === 'needed' || q.options?.some((o) => o.figure?.kind === 'needed')).length,
    addedAt: p.addedAt,
  };
}

/** A paper can be started only when every question is present and keyed. */
export const paperReady = (m: PaperMeta) => m.present >= m.questionCount && m.keyed >= m.questionCount;

/**
 * Merges a validated document into a pack's existing papers. Chunks of the same paper merge by
 * question number; identical content is skipped; different content for an existing number is a
 * conflict (nothing is written when there are conflicts). Answer keys fill null answers; a key
 * that contradicts an existing answer is a conflict.
 */
export function mergeDoc(
  doc: NDoc,
  packId: string,
  existing: ReadonlyMap<string, Paper>,
  images: ReadonlyMap<string, string>,
  overrides: Record<string, PaperOverrides> = {},
  questionOverrides: ReadonlyMap<string, QuestionOverride> = new Map(),
  now = Date.now(),
): MergeResult {
  const conflicts: Issue[] = [];
  const out = new Map<string, Paper>();
  const plan: PaperPlan[] = [];
  let answersApplied = 0;

  doc.papers.forEach((np: NPaper, pi) => {
    const ov = overrides[np.id] ?? {};
    const prev = out.get(np.id) ?? existing.get(np.id);
    const questionCount = ov.questionCount ?? np.questionCount;
    const timeLimitMin = ov.timeLimitMin ?? np.timeLimitMin ?? prev?.timeLimitMin ?? Math.ceil((questionCount * DEFAULT_SEC_PER_Q) / 60);
    const base: Paper = prev
      ? { ...prev, questions: prev.questions.slice() }
      : {
          key: paperKey(packId, np.id),
          packId,
          id: np.id,
          title: np.title,
          group: np.group,
          questionCount,
          timeLimitMin,
          optionCount: np.optionCount,
          present: 0,
          keyed: 0,
          figuresNeeded: 0,
          addedAt: now,
          questions: [],
        };
    if (ov.title) base.title = ov.title;
    if (ov.group) base.group = ov.group;
    if (ov.questionCount) base.questionCount = ov.questionCount;
    if (ov.timeLimitMin) base.timeLimitMin = ov.timeLimitMin;
    if (prev && !ov.questionCount && prev.questionCount !== np.questionCount)
      conflicts.push({ path: `papers[${pi}].questionCount`, message: `Paper "${np.id}" already has ${prev.questionCount} questions; this import says ${np.questionCount}. Correct the count in the review table if the paper really changed.` });
    if (prev && prev.optionCount !== np.optionCount)
      conflicts.push({ path: `papers[${pi}].optionCount`, message: `Paper "${np.id}" already has ${prev.optionCount} options per question, this import has ${np.optionCount}` });

    const byN = new Map(base.questions.map((q) => [q.n, q] as const));
    let added = 0;
    let unchanged = 0;
    let keyed = 0;
    np.questions.forEach((nq, qi) => {
      const q = toQuestion(np.id, np.optionCount, nq, images);
      const have = byN.get(q.n);
      if (!have) {
        const pend = base.pendingKey?.[q.n - 1];
        if (q.answer === null && pend !== undefined && pend !== null) q.answer = pend;
        byN.set(q.n, q);
        added++;
        return;
      }
      const ovr = questionOverrides.get(`${packId}::${have.id}`);
      const sameContent = have.hash === q.hash || questionHash(applyOverride(have, ovr)) === q.hash;
      if (!sameContent) {
        conflicts.push({
          path: `papers[${pi}].questions[${qi}]`,
          message: `Question ${q.n} of "${np.id}" already exists with different content. Fix it in the app instead, or remove it from this import.`,
        });
        return;
      }
      unchanged++;
      if (q.answer !== null && have.answer === null) {
        byN.set(q.n, { ...have, answer: q.answer });
        keyed++;
      } else if (q.answer !== null && have.answer !== q.answer && ovr?.answer === undefined)
        conflicts.push({
          path: `papers[${pi}].questions[${qi}].answer`,
          message: `Question ${q.n} of "${np.id}" is keyed ${LETTERS[have.answer ?? 0]} already; this import says ${LETTERS[q.answer]}`,
        });
    });
    base.questions = [...byN.values()].sort((a, b) => a.n - b.n);
    Object.assign(base, metaOf(base));
    out.set(np.id, base);
    plan.push({ id: np.id, title: base.title, status: prev ? (added || keyed ? 'merge' : 'identical') : 'new', added, unchanged, keyed });
  });

  doc.answers.forEach((a) => {
    const p0 = out.get(a.paper) ?? existing.get(a.paper);
    if (!p0) {
      conflicts.push({ path: `${a.path}.paper`, message: `No paper "${a.paper}" in this pack or import. Check the paper id.` });
      return;
    }
    const p: Paper = { ...p0, questions: p0.questions.slice() };
    if (a.key.length !== p.questionCount) {
      conflicts.push({ path: `${a.path}.key`, message: `Key has ${a.key.length} answers but "${a.paper}" has ${p.questionCount} questions` });
      return;
    }
    const bad = a.key.findIndex((k) => k !== null && k >= p.optionCount);
    if (bad >= 0) {
      conflicts.push({ path: `${a.path}.key`, message: `Answer ${bad + 1} is outside the ${p.optionCount} options` });
      return;
    }
    let applied = 0;
    p.questions = p.questions.map((q) => {
      const k = a.key[q.n - 1];
      if (k === null || k === undefined) return q;
      if (q.answer === null) {
        applied++;
        return { ...q, answer: k };
      }
      const ovr = questionOverrides.get(`${packId}::${q.id}`);
      if (q.answer !== k && ovr?.answer === undefined)
        conflicts.push({ path: `${a.path}.key`, message: `Question ${q.n} of "${a.paper}" is keyed ${LETTERS[q.answer]} already; the key says ${LETTERS[k]}` });
      return q;
    });
    p.pendingKey = a.key;
    answersApplied += applied;
    Object.assign(p, metaOf(p));
    out.set(p.id, p);
    const pl = plan.find((x) => x.id === p.id);
    if (pl) {
      pl.keyed += applied;
      if (pl.status === 'identical' && applied) pl.status = 'merge';
    } else plan.push({ id: p.id, title: p.title, status: applied ? 'merge' : 'identical', added: 0, unchanged: 0, keyed: applied });
  });

  return { papers: [...out.values()], plan, answersApplied, conflicts };
}
