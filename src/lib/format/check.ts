/** Pure pack check shared by the app and `tools/validate-pack.mjs`: no storage, no DOM beyond DOMParser. */
import { readZip, fromEntries, settle, type ImportSource } from '../data/files';
import { JsonSyntaxError, lenientParse } from './lenient';
import { validateDoc, type Issue } from './validate';

export interface CheckReport {
  ok: boolean;
  syntax?: string;
  errors: Issue[];
  warnings: Issue[];
  notes: string[];
  papers: { id: string; title: string; questions: number; questionCount: number; keyed: number; bare: boolean }[];
  images: number;
  pdfs: number;
}

export function checkSource(src: ImportSource): CheckReport {
  const base = { errors: [], warnings: [], notes: [], papers: [], images: src.files.size, pdfs: src.pdfs.size };
  if (!src.text) return { ...base, ok: false, syntax: 'No pack JSON found (expected pack.json or one .json file)' };
  try {
    const { value, notes } = lenientParse(src.text);
    const r = validateDoc(value, new Set([...src.files.keys(), ...src.pdfs.keys()]), notes);
    const keyed = (id: string, qs: { answer: number | null }[]) => {
      const k = r.doc.answers.find((a) => a.paper === id)?.key;
      return qs.filter((q, i) => q.answer !== null || (k?.[i] ?? null) !== null).length;
    };
    return {
      ...base,
      ok: !r.errors.length,
      errors: r.errors,
      warnings: r.warnings,
      notes: r.notes,
      papers: r.doc.papers.map((p) => ({ id: p.id, title: p.title, questions: p.questions.length, questionCount: p.questionCount, keyed: keyed(p.id, p.questions), bare: !!p.bare })),
    };
  } catch (e) {
    return { ...base, ok: false, syntax: e instanceof JsonSyntaxError ? `${e.message}${e.line ? ` (line ${e.line})` : ''}` : (e as Error).message };
  }
}

export { readZip, fromEntries, settle };
