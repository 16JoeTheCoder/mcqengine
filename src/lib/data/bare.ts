import { LETTERS } from '../types';
import type { ImportSource } from './files';

export interface BarePaperInput {
  id: string;
  title: string;
  group: string[];
  questionCount: number;
  timeLimitMin: number;
  optionCount: number;
  qp: Blob;
  ms?: Blob;
  /** Confirmed key (question order), or undefined for Exam-only until a key arrives. */
  key?: (number | null)[];
  boundaries?: { grade: string; min: number }[];
}

/**
 * Builds a pack document plus an in-memory source for bare PDF papers, so they go through the
 * same validator, merge and commit as every other import (one hostile-input pipeline).
 */
export function bareImport(papers: BarePaperInput[], pack?: { title: string; subject: string }): { text: string; source: ImportSource } {
  const pdfs = new Map<string, Blob>();
  const doc = {
    format: 'dmc-pack/1',
    ...(pack ? { pack } : {}),
    papers: papers.map((p, i) => {
      const qp = `pdfs/${i + 1}-qp.pdf`;
      pdfs.set(qp, p.qp);
      const ms = p.ms ? `pdfs/${i + 1}-ms.pdf` : undefined;
      if (ms && p.ms) pdfs.set(ms, p.ms);
      return {
        id: p.id,
        title: p.title,
        group: p.group,
        questionCount: p.questionCount,
        timeLimitMinutes: p.timeLimitMin,
        optionCount: p.optionCount,
        bare: true,
        pdf: { questionPaper: qp, ...(ms ? { markScheme: ms } : {}) },
        ...(p.boundaries?.length ? { gradeBoundaries: Object.fromEntries(p.boundaries.map((b) => [b.grade, b.min])) } : {}),
      };
    }),
    answers: papers.filter((p) => p.key?.some((k) => k !== null)).map((p) => ({ paper: p.id, key: p.key!.map((k) => (k === null ? '?' : LETTERS[k])).join('') })),
  };
  return { text: JSON.stringify(doc), source: { name: 'PDF papers', text: null, files: new Map(), pdfs, skipped: [] } };
}

/** Cambridge MCQ papers: AS/A Level paper 1 is 75 minutes, IGCSE papers 1 and 2 are 45; otherwise 90 s per question. */
export function defaultMinutes(code: string | undefined, paper: string | undefined, questions: number): number {
  if (code && paper) {
    if (/^9\d{3}$/.test(code) && /^1\d?$/.test(paper)) return 75;
    if (/^0\d{3}$/.test(code) && /^[12]\d?$/.test(paper)) return 45;
  }
  return Math.max(1, Math.ceil((questions * 90) / 60));
}
