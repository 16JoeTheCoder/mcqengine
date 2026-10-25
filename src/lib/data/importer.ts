import { lenientParse, JsonSyntaxError } from '../format/lenient';
import { mergeDoc, mergePaperCopies, type MergeResult, type PaperOverrides } from '../format/merge';
import { sanitizeSvg } from '../format/svg';
import { slugify, validateDoc, type NDoc, type ValidationResult } from '../format/validate';
import { uid } from '../engine/rng';
import { regradePack } from '../engine/regrade';
import type { ImageRecord, Pack, Paper } from '../types';
import * as store from './db';
import { sha256Hex, type ImportSource } from './files';

export type ParseOutcome = { ok: true; result: ValidationResult } | { ok: false; syntax: string; line?: number };

export function parseImport(text: string, files: ReadonlySet<string> = new Set()): ParseOutcome {
  try {
    const { value, notes } = lenientParse(text);
    return { ok: true, result: validateDoc(value, files, notes) };
  } catch (e) {
    if (e instanceof JsonSyntaxError) return { ok: false, syntax: e.message, line: e.line };
    return { ok: false, syntax: (e as Error).message || 'Could not read the JSON' };
  }
}

/** Paths of every image file the document references. */
function referencedFiles(doc: NDoc): Set<string> {
  const out = new Set<string>();
  const f = (x?: { kind: string; path?: string }) => x?.kind === 'file' && x.path && out.add(x.path);
  for (const p of doc.papers)
    for (const q of p.questions) {
      if (q.image) out.add(q.image);
      f(q.figure as never);
      q.options?.forEach((o) => f(o.figure as never));
    }
  return out;
}

/** Hashes referenced images (sha-256 of bytes) so identical images dedupe across imports. */
export async function prepareImages(doc: NDoc, files: ReadonlyMap<string, Blob>): Promise<{ map: Map<string, string>; records: ImageRecord[] }> {
  const map = new Map<string, string>();
  const records: ImageRecord[] = [];
  for (const path of referencedFiles(doc)) {
    let blob = files.get(path);
    if (!blob) continue;
    if (blob.type === 'image/svg+xml' || path.toLowerCase().endsWith('.svg')) {
      const clean = sanitizeSvg(await blob.text()).svg;
      if (!clean) continue;
      blob = new Blob([clean], { type: 'image/svg+xml' });
    }
    const id = await sha256Hex(await blob.arrayBuffer());
    map.set(path, id);
    records.push({ id, type: blob.type || 'application/octet-stream', blob });
  }
  return { map, records };
}

export interface ImportTarget {
  packId: string | null;
  newPack?: { title: string; subject: string };
}

export async function planImport(doc: NDoc, target: ImportTarget, source: ImportSource | null, overrides: Record<string, PaperOverrides>) {
  const packId = target.packId ?? '__new__';
  const existing = target.packId ? await store.getPapers(target.packId) : [];
  const qov = target.packId ? new Map((await store.getOverrides(target.packId)).map((o) => [o.key, o] as const)) : new Map();
  const imgs = source ? await prepareImages(doc, source.files) : { map: new Map<string, string>(), records: [] };
  const merge = mergeDoc(doc, packId, new Map(existing.map((p) => [p.id, p] as const)), imgs.map, overrides, qov);
  if (source?.pdfs.size) await attachPdfs(doc, merge, source.pdfs);
  return { merge, images: imgs.records, imageMap: imgs.map };
}

/** PDFs stored by content hash and linked to their papers; snips become snip records. */
async function attachPdfs(doc: NDoc, merge: MergeResult, pdfs: ReadonlyMap<string, Blob>) {
  const ids = new Map<string, string>();
  merge.pdfs = [];
  merge.snips = [];
  const idOf = async (path?: string) => {
    if (!path) return undefined;
    if (ids.has(path)) return ids.get(path);
    const blob = pdfs.get(path);
    if (!blob) return undefined;
    const buf = await blob.arrayBuffer();
    if (!new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength))).includes('%PDF-')) return undefined;
    const id = await sha256Hex(buf);
    ids.set(path, id);
    merge.pdfs!.push({ id, name: (path.split('/').pop() ?? path).slice(0, 200), size: buf.byteLength, blob: new Blob([buf], { type: 'application/pdf' }), addedAt: Date.now() });
    return id;
  };
  for (const np of doc.papers) {
    const paper = merge.papers.find((p) => p.id === np.id);
    if (!paper) continue;
    const qp = await idOf(np.pdf?.questionPaper);
    const ms = await idOf(np.pdf?.markScheme);
    if (qp || ms) paper.pdf = { ...paper.pdf, ...(qp ? { qp } : {}), ...(ms ? { ms } : {}) };
    if (np.bare) paper.bare = true;
    for (const q of np.questions)
      if (q.snip && qp) merge.snips.push({ key: '', packId: '', qid: `${np.id}#${q.n}`, pdfId: qp, ...q.snip, updatedAt: Date.now() });
  }
}

/** Writes a planned import. Refuses when the plan has conflicts. Returns the pack id. */
export async function commitImport(target: ImportTarget, merge: MergeResult, images: ImageRecord[], now = Date.now()): Promise<string> {
  if (merge.conflicts.length) throw new Error('Resolve the conflicts before importing');
  const packId = await writeImport(target, merge, images, now);
  // Keys that arrived with this import grade any session that was waiting for them.
  if (target.packId) await regradePack(packId, now);
  return packId;
}

function writeImport(target: ImportTarget, merge: MergeResult, images: ImageRecord[], now: number): Promise<string> {
  // Read-modify-write of the pack inside one transaction, so concurrent imports cannot drop papers.
  return store.write(async () => {
    const tx = (await store.db()).transaction(['packs', 'papers', 'images', 'pdfs', 'snips'], 'readwrite');
    const packs = tx.objectStore('packs');
    let pack: Pack | undefined = target.packId ? await packs.get(target.packId) : undefined;
    if (!pack) {
      const title = target.newPack?.title.trim() || 'Untitled pack';
      const base = slugify(title) || 'pack';
      // A random suffix keeps ids unique across devices too, so backups never collide on title;
      // a counter guarantees uniqueness on this device.
      let id = `${base}-${uid().slice(0, 6)}`;
      for (let k = 2; await packs.get(id); k++) id = `${base}-${uid().slice(0, 6)}-${k}`;
      pack = { id, title, subject: target.newPack?.subject.trim() ?? '', createdAt: now, updatedAt: now, papers: [] };
    }
    const packId = pack.id;
    const papers: Paper[] = [];
    for (const p0 of merge.papers) {
      const p: Paper = { ...p0, packId, key: `${packId}::${p0.id}` };
      // Keep questions stored since this import was planned (another tab, another chunk).
      const stored = await tx.objectStore('papers').get(p.key);
      papers.push(stored ? mergePaperCopies(p, stored) : p);
    }
    const metas = new Map(pack.papers.map((m) => [m.id, m] as const));
    for (const p of papers) {
      const { key: _k, packId: _p, questions: _q, pendingKey: _pk, ...meta } = p;
      metas.set(p.id, meta);
    }
    await packs.put({ ...pack, papers: [...metas.values()], updatedAt: now });
    for (const p of papers) await tx.objectStore('papers').put(p);
    for (const i of images) await tx.objectStore('images').put(i);
    for (const f of merge.pdfs ?? []) if (!(await tx.objectStore('pdfs').get(f.id))) await tx.objectStore('pdfs').put(f);
    for (const sn of merge.snips ?? []) await tx.objectStore('snips').put({ ...sn, packId, key: `${packId}::${sn.qid}` });
    await tx.done;
    return packId;
  });
}
