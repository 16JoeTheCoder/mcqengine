import { FP_SAME, similarity } from '../../../shared/fingerprint';
import { isPaperKey, paperKeyFromCover, paperKeyFromName, qpKeyOf } from '../../../shared/paper-key';
import type { Paper, PaperMeta, Question } from '../types';
import type { NDoc } from './validate';

/**
 * Identity and matching rules, used by import, post, download, sync and restore:
 *  * a set is matched only by its permanent set ID, never by title;
 *  * a paper is matched by its file hash, then its text fingerprint, then its Cambridge code
 *    (read automatically; legacy papers keep their stored id);
 *  * a question is matched by paper key + number, and its content hash separates
 *    "same question" (link, no duplicate) from "edited question" (a keep-mine-or-theirs choice).
 */
export type KeyStatus = 'found' | 'missing';
export interface KeyResolution {
  /** The paper's id as written in the document. */
  docId: string;
  title: string;
  /** The Cambridge code, found automatically; a label and a hint, never typed by the user. */
  key: string | null;
  status: KeyStatus;
  /** Where the key came from, for the review table. */
  from?: 'file name' | 'cover page' | 'DMC export' | 'confirmed';
  /** Text fingerprint of the question paper (shared/fingerprint.ts), when it has enough text. */
  fingerprint?: string;
}

type Texts = ReadonlyMap<string, string | { cover: string; fingerprint: string | null }>;

/**
 * Works out each paper's Cambridge code from what can be trusted: the question paper's file
 * name, its cover page, or a code DMC itself wrote into an export (a document carrying a set ID).
 * Nothing is asked of the user: an AI-written id is never trusted, and a paper without a code is
 * matched by its file hash and text fingerprint instead. `texts` is keyed by the PDF path.
 */
export function resolvePaperKeys(doc: NDoc, texts: Texts = new Map(), confirmed: Readonly<Record<string, string>> = {}): KeyResolution[] {
  return doc.papers.map((p) => {
    const t = p.pdf?.questionPaper ? texts.get(p.pdf.questionPaper) : undefined;
    const cover = typeof t === 'string' ? t : t?.cover;
    const fingerprint = typeof t === 'object' && t?.fingerprint ? t.fingerprint : undefined;
    const base = { docId: p.id, title: p.title, ...(fingerprint ? { fingerprint } : {}) };
    const fixed = confirmed[p.id];
    if (fixed && isPaperKey(fixed)) return { ...base, key: qpKeyOf(fixed), status: 'found', from: 'confirmed' };
    for (const name of [p.pdf?.questionPaper, p.source?.questionPaper, p.pdf?.markScheme, p.source?.markScheme]) {
      const k = name ? paperKeyFromName(name) : null;
      if (k) return { ...base, key: qpKeyOf(k), status: 'found', from: 'file name' };
    }
    const fromCover = cover ? paperKeyFromCover(cover) : null;
    if (fromCover) return { ...base, key: qpKeyOf(fromCover), status: 'found', from: 'cover page' };
    const trusted = doc.pack?.setId ? (p.key ?? (isPaperKey(p.id) ? p.id : null)) : null;
    if (trusted) return { ...base, key: qpKeyOf(trusted), status: 'found', from: 'DMC export' };
    return { ...base, key: null, status: 'missing' };
  });
}

/**
 * Gives each resolved paper its canonical id. A paper already in the pack under that key keeps
 * its stored id (legacy papers stay linked to their sessions); otherwise the key becomes the id,
 * so question IDs read `9702_s24_qp_12#7`. Answer keys follow the rename. Unresolved papers keep
 * the document's id. Returns the doc id -> final id map.
 */
export function applyPaperKeys(doc: NDoc, resolved: KeyResolution[], existing: Iterable<Pick<PaperMeta, 'id' | 'paperKey' | 'fingerprint'>>): Map<string, string> {
  const byKey = new Map<string, string>();
  const prints: [string, string][] = [];
  for (const p of existing) {
    if (p.paperKey) byKey.set(p.paperKey, p.id);
    if (isPaperKey(p.id)) byKey.set(p.id, p.id);
    if (p.fingerprint) prints.push([p.fingerprint, p.id]);
  }
  const rename = new Map<string, string>();
  doc.papers.forEach((p, i) => {
    const r = resolved[i];
    if (!r) return;
    if (r.fingerprint) p.fingerprint = r.fingerprint;
    // Same text as a paper already here (the same PDF saved again): it is that paper.
    const byText = r.fingerprint ? prints.map(([fp, id]) => [similarity(fp, r.fingerprint!), id] as const).filter(([s]) => s >= FP_SAME).sort((a, b) => b[0] - a[0])[0]?.[1] : undefined;
    if (!r.key && !byText) return;
    const id = (r.key ? byKey.get(r.key) : undefined) ?? byText ?? r.key!;
    rename.set(p.id, id);
    p.id = id;
    if (r.key) p.key = r.key;
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
