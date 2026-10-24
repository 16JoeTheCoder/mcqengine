import { lenientParse, JsonSyntaxError } from '../format/lenient';
import { mergeDoc, type MergeResult, type PaperOverrides } from '../format/merge';
import { sanitizeSvg } from '../format/svg';
import { slugify, validateDoc, type NDoc, type ValidationResult } from '../format/validate';
import { uid } from '../engine/rng';
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
  return { merge, images: imgs.records, imageMap: imgs.map };
}

/** Writes a planned import. Refuses when the plan has conflicts. Returns the pack id. */
export async function commitImport(target: ImportTarget, merge: MergeResult, images: ImageRecord[], now = Date.now()): Promise<string> {
  if (merge.conflicts.length) throw new Error('Resolve the conflicts before importing');
  let pack: Pack | undefined = target.packId ? await store.getPack(target.packId) : undefined;
  if (!pack) {
    const title = target.newPack?.title.trim() || 'Untitled pack';
    const base = slugify(title) || 'pack';
    const exists = await store.getPack(base);
    pack = { id: exists ? `${base}-${uid().slice(0, 5)}` : base, title, subject: target.newPack?.subject.trim() ?? '', createdAt: now, updatedAt: now, papers: [] };
  }
  const packId = pack.id;
  const papers: Paper[] = merge.papers.map((p) => ({ ...p, packId, key: `${packId}::${p.id}` }));
  const metas = new Map(pack.papers.map((m) => [m.id, m] as const));
  for (const p of papers) {
    const { key: _k, packId: _p, questions: _q, pendingKey: _pk, ...meta } = p;
    metas.set(p.id, meta);
  }
  const updated: Pack = { ...pack, papers: [...metas.values()], updatedAt: now };
  await store.savePackAndPapers(updated, papers, images);
  return packId;
}
