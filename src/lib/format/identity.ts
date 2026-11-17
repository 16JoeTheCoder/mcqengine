import { isPaperKey, paperKeyFromCover, paperKeyFromName, qpKeyOf } from '../../../shared/paper-key';
import type { Paper, PaperMeta, Question } from '../types';
import type { NDoc } from './validate';

/**
 * Identity and matching rules, used by import, post, download, sync and restore:
 *  * a set is matched only by its permanent set ID, never by title;
 *  * a paper is matched by its canonical Cambridge key (or, for legacy papers, its stored id);
 *  * a question is matched by paper key + number, and its content hash separates
 *    "same question" (link, no duplicate) from "edited question" (a keep-mine-or-theirs choice).
 */
export type KeyStatus = 'found' | 'confirm' | 'missing';
export interface KeyResolution {
  /** The paper's id as written in the document. */
  docId: string;
  title: string;
  key: string | null;
  status: KeyStatus;
  /** Where the key came from, for the review table. */
  from?: 'file name' | 'cover page' | 'DMC export' | 'confirmed';
  /** A guess the user must confirm (from an AI-written id). */
  suggestion?: string;
}

/** The AI-written id is only a hint: `9702-s24-12`, `9702_s24_qp_12`, `9702 s24 p12`. */
function hintFromId(id: string): string | null {
  const direct = paperKeyFromName(id);
  if (direct) return qpKeyOf(direct);
  const m = /^(\d{4})[_\s-]+([msw])(\d{2})[_\s-]+(?:p|paper[_\s-]*)?(\d{1,2})$/i.exec(id.trim());
  return m ? `${m[1]}_${m[2]!.toLowerCase()}${m[3]}_qp_${m[4]!.padStart(2, '0')}` : null;
}

/**
 * Works out each paper's key from what can be trusted: the question paper's file name, the
 * cover page text (when `coverText` has it, keyed by the PDF path), or a key DMC itself wrote
 * into an export (a document carrying a set ID). An AI-written id is offered as a suggestion only.
 */
export function resolvePaperKeys(doc: NDoc, coverText: ReadonlyMap<string, string> = new Map(), confirmed: Readonly<Record<string, string>> = {}): KeyResolution[] {
  return doc.papers.map((p) => {
    const base = { docId: p.id, title: p.title };
    const fixed = confirmed[p.id];
    if (fixed && isPaperKey(fixed)) return { ...base, key: qpKeyOf(fixed), status: 'found', from: 'confirmed' };
    for (const name of [p.pdf?.questionPaper, p.source?.questionPaper, p.pdf?.markScheme, p.source?.markScheme]) {
      const k = name ? paperKeyFromName(name) : null;
      if (k) return { ...base, key: qpKeyOf(k), status: 'found', from: 'file name' };
    }
    const cover = p.pdf?.questionPaper ? coverText.get(p.pdf.questionPaper) : undefined;
    const fromCover = cover ? paperKeyFromCover(cover) : null;
    if (fromCover) return { ...base, key: qpKeyOf(fromCover), status: 'found', from: 'cover page' };
    const trusted = doc.pack?.setId ? (p.key ?? (isPaperKey(p.id) ? p.id : null)) : null;
    if (trusted) return { ...base, key: qpKeyOf(trusted), status: 'found', from: 'DMC export' };
    const hint = hintFromId(p.id);
    return hint ? { ...base, key: null, status: 'confirm', suggestion: hint } : { ...base, key: null, status: 'missing' };
  });
}

/**
 * Gives each resolved paper its canonical id. A paper already in the pack under that key keeps
 * its stored id (legacy papers stay linked to their sessions); otherwise the key becomes the id,
 * so question IDs read `9702_s24_qp_12#7`. Answer keys follow the rename. Unresolved papers keep
 * the document's id. Returns the doc id -> final id map.
 */
export function applyPaperKeys(doc: NDoc, resolved: KeyResolution[], existing: Iterable<Pick<PaperMeta, 'id' | 'paperKey'>>): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const p of existing) {
    if (p.paperKey) byKey.set(p.paperKey, p.id);
    if (isPaperKey(p.id)) byKey.set(p.id, p.id);
  }
  const rename = new Map<string, string>();
  doc.papers.forEach((p, i) => {
    const r = resolved[i];
    if (!r?.key) return;
    const id = byKey.get(r.key) ?? r.key;
    rename.set(p.id, id);
    p.id = id;
    p.key = r.key;
  });
  for (const a of doc.answers) a.paper = rename.get(a.paper) ?? a.paper;
  // Two document papers that resolve to the same key are the same paper: their questions merge.
  return rename;
}

export type QuestionMatch = 'new' | 'same' | 'changed';
/** Same key and same hash: already there. Same key, different hash: a new version. */
export function matchQuestion(local: Pick<Question, 'hash'> | undefined, incoming: Pick<Question, 'hash'>): QuestionMatch {
  if (!local) return 'new';
  return local.hash === incoming.hash ? 'same' : 'changed';
}

/** Finds the local paper that is the same paper as `incoming`: by key first, then by id. */
export function matchPaper<T extends Pick<Paper, 'id' | 'paperKey'>>(locals: T[], incoming: Pick<Paper, 'id' | 'paperKey'>): T | undefined {
  if (incoming.paperKey) {
    const byKey = locals.find((p) => p.paperKey === incoming.paperKey || p.id === incoming.paperKey);
    if (byKey) return byKey;
  }
  return locals.find((p) => p.id === incoming.id);
}
