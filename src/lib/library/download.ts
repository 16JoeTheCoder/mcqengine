import * as store from '../data/db';
import type { ImportSource } from '../data/files';
import { commitImport, parseImport, planImport } from '../data/importer';
import { backend, type Backend } from '../backend';
import { BackendError, type LibrarySet } from '../backend/types';
import type { PublishedManifest } from '../../../shared/manifest';

/** New Library downloads get a fixed local id, so every device agrees (legacy form kept). */
export const libraryPackId = (setId: string) => `lib-${setId.replace(/[^a-z0-9-]/gi, '').slice(0, 40)}`;

export type DownloadResult = { packId: string; version: number } | { needsChoice: number };

/** Files already on this device (by hash) are reused; only the rest are fetched. */
async function gather(m: PublishedManifest, be: Backend, onFile: (n: number, of: number) => void): Promise<ImportSource> {
  const packBlob = await be.getBlob(m.pack);
  if (!packBlob) throw new BackendError('This set is no longer available');
  const files = new Map<string, Blob>();
  const pdfs = new Map<string, Blob>();
  const entries = Object.entries(m.files);
  let n = 0;
  const fetched = new Map<string, Blob>();
  for (const [path, hash] of entries) {
    onFile(++n, entries.length);
    const isPdf = path.startsWith('pdfs/');
    let blob: Blob | null | undefined = fetched.get(hash) ?? (isPdf ? (await store.getPdf(hash))?.blob : (await store.getImage(hash))?.blob);
    if (!blob) blob = await be.getBlob(hash);
    if (!blob) throw new BackendError(`A file of this set is missing (${path.split('/').pop()}). Ask the owner to post it again.`);
    fetched.set(hash, blob);
    (isPdf ? pdfs : files).set(path, blob);
  }
  return { name: `${m.meta.title}.zip`, text: await packBlob.text(), files, pdfs, skipped: [] };
}

/**
 * Downloads a set (or updates the local copy) through the same hostile-input pipeline as any
 * file. The local pack with the set's ID is updated in place, never duplicated, whether it was
 * downloaded before, posted from this device, or synced from another. Papers match by key and
 * questions by key + number + content hash; when questions were edited on both sides, the
 * first call returns `needsChoice` and the caller asks "keep mine or use the Library's".
 */
export async function downloadSet(set: Pick<LibrarySet, 'id' | 'title' | 'subject' | 'mine'>, opts: { prefer?: 'mine' | 'theirs'; onFile?: (n: number, of: number) => void } = {}, be: Backend | null = backend): Promise<DownloadResult> {
  if (!be) throw new BackendError('The Library is not set up');
  const { manifest } = await be.getSet(set.id);
  const src = await gather(manifest, be, opts.onFile ?? (() => {}));
  const parsed = parseImport(src.text!, new Set([...src.files.keys(), ...src.pdfs.keys()]));
  if (!parsed.ok) throw new BackendError(`This set could not be read: ${parsed.syntax}`);
  if (parsed.result.errors.length) throw new BackendError(`This set has ${parsed.result.errors.length} problem(s) and was not imported`);
  const local = await store.findPackBySetId(set.id);
  const target = local
    ? { packId: local.id }
    : { packId: null, newPack: { title: manifest.meta.title || set.title, subject: manifest.meta.subject || set.subject, id: libraryPackId(set.id), setId: set.id, libraryVersion: manifest.version, ...(set.mine ? {} : { origin: { kind: 'library' as const, setId: set.id, title: set.title } }) } };
  // The manifest's keys are the server's record of each paper; they count as confirmed.
  const keys = Object.fromEntries(manifest.papers.filter((p) => p.key).map((p) => [p.id, p.key!]));
  const plan = await planImport(parsed.result.doc, target, src, {}, { keys, ...(opts.prefer ? { prefer: opts.prefer } : {}) });
  if (!opts.prefer && plan.merge.changed.length) return { needsChoice: plan.merge.changed.length };
  if (plan.merge.conflicts.length) throw new BackendError(`This set could not be merged with your copy: ${plan.merge.conflicts[0]!.message}`);
  const packId = await commitImport(plan.target, plan.merge, plan.images);
  const pack = await store.getPack(packId);
  if (pack) await store.putPack({ ...pack, setId: pack.setId ?? set.id, libraryVersion: Math.max(pack.libraryVersion ?? 0, manifest.version), updatedAt: Math.max(Date.now(), pack.updatedAt + 1) });
  return { packId, version: manifest.version };
}

/** A local copy older than the Library's latest version. */
export function updateAvailable(set: Pick<LibrarySet, 'id' | 'version'>, packs: { setId?: string; origin?: { setId: string }; libraryVersion?: number }[]): 'none' | 'current' | 'update' {
  const local = packs.find((p) => p.setId === set.id) ?? packs.find((p) => p.origin?.setId === set.id);
  if (!local) return 'none';
  return (local.libraryVersion ?? 0) < set.version ? 'update' : 'current';
}
