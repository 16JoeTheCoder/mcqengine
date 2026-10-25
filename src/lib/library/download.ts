import { readZip } from '../data/files';
import { commitImport, parseImport, planImport } from '../data/importer';
import { backend } from '../backend';
import { BackendError, type LibrarySet } from '../backend/types';

/** Library packs get a fixed id, so the same set is the same pack on every device (and in sync). */
export const libraryPackId = (setId: string) => `lib-${setId.replace(/[^a-z0-9-]/gi, '').slice(0, 40)}`;

/**
 * Downloads a set through a short-lived signed URL and imports it through the same hostile-input
 * pipeline as any file: guarded unzip, lenient read, strict validation, merge, one transaction.
 * Downloading again updates the same local pack.
 */
export async function downloadSet(set: LibrarySet): Promise<string> {
  if (!backend) throw new BackendError('The Library is not set up');
  const blob = await backend.download('sets', set.filePath);
  if (!blob) throw new BackendError('This set is no longer available');
  const src = await readZip(blob, `${set.title}.zip`);
  if (src.backup || !src.text) throw new BackendError('This set is not a DMC pack');
  const parsed = parseImport(src.text, new Set([...src.files.keys(), ...src.pdfs.keys()]));
  if (!parsed.ok) throw new BackendError(`This set could not be read: ${parsed.syntax}`);
  if (parsed.result.errors.length) throw new BackendError(`This set has ${parsed.result.errors.length} problem(s) and was not imported`);
  const target = { packId: null, newPack: { title: set.title, subject: set.subject, id: libraryPackId(set.id), origin: { kind: 'library' as const, setId: set.id, title: set.title } } };
  const { merge, images } = await planImport(parsed.result.doc, target, src, {});
  if (merge.conflicts.length) throw new BackendError(`This set changed since you downloaded it: ${merge.conflicts[0]!.message}`);
  return commitImport(target, merge, images);
}
