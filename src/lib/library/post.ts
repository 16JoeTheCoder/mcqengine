import { bareImport, defaultMinutes } from '../data/bare';
import { exportPackZip } from '../data/backup';
import * as store from '../data/db';
import { readZip, type ImportSource } from '../data/files';
import { checkSource, type CheckReport } from '../format/check';
import { pairFiles, parseFileName } from '../format/filename';
import { backend, type Backend } from '../backend';
import { BackendError, type SetMeta } from '../backend/types';
import type { Pack } from '../types';

export const MAX_SET_BYTES = 100 * 1024 * 1024;

export interface Prepared {
  zip: Blob;
  meta: SetMeta;
  report: CheckReport;
  /** Shown as read-only facts in the post dialog. */
  facts: string[];
}

async function zipSource(src: ImportSource): Promise<Blob> {
  const { zipSync, strToU8 } = await import('fflate');
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = { 'pack.json': strToU8(src.text ?? '') };
  for (const [p, b] of src.files) files[p] = new Uint8Array(await b.arrayBuffer());
  for (const [p, b] of src.pdfs) files[p] = [new Uint8Array(await b.arrayBuffer()), { level: 0 }];
  return new Blob([zipSync(files, { level: 6 }) as BlobPart], { type: 'application/zip' });
}

function describe(report: CheckReport, title: string, subject: string, code: string): Prepared['meta'] {
  return {
    title,
    description: '',
    subject,
    code,
    paperCount: report.papers.length,
    questionCount: report.papers.reduce((a, p) => a + p.questionCount, 0),
    keyed: report.papers.length > 0 && report.papers.every((p) => p.keyed >= p.questionCount),
  };
}

function factsOf(r: CheckReport, src: ImportSource): string[] {
  const keyed = r.papers.filter((p) => p.keyed >= p.questionCount).length;
  const bare = r.papers.filter((p) => p.bare).length;
  return [
    `${r.papers.length} paper${r.papers.length === 1 ? '' : 's'}`,
    `${r.papers.reduce((a, p) => a + p.questionCount, 0)} questions`,
    keyed === r.papers.length ? 'all keyed' : `${keyed} of ${r.papers.length} keyed`,
    ...(bare ? [`${bare} PDF-only`] : []),
    ...(src.pdfs.size ? [`${src.pdfs.size} PDF${src.pdfs.size === 1 ? '' : 's'}`] : []),
  ];
}

/** Validates through the same hostile-input checks as an import; refuses anything that would not import. */
function mustPass(r: CheckReport): CheckReport {
  if (!r.ok) throw new BackendError(r.syntax ?? `This pack has ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}: ${r.errors[0]?.path}: ${r.errors[0]?.message}`);
  if (!r.papers.length) throw new BackendError('There are no papers to share');
  return r;
}

/** A pack already on this device. Library downloads cannot be re-posted. */
export async function prepareFromPack(pack: Pack): Promise<Prepared> {
  const [papers, ovs, snips] = await Promise.all([store.getPapers(pack.id), store.getOverrides(pack.id), store.getSnips(pack.id)]);
  const { blob } = await exportPackZip(pack, papers, ovs, snips);
  const src = await readZip(blob, `${pack.id}.zip`);
  const report = mustPass(checkSource(src));
  const code = /^(\d{4})-/.exec(papers[0]?.id ?? '')?.[1] ?? '';
  return { zip: blob, meta: describe(report, pack.title, pack.subject, code), report, facts: factsOf(report, src) };
}

/** A zip, or question paper and mark scheme PDFs. */
export async function prepareFromFiles(files: File[]): Promise<Prepared> {
  let src: ImportSource;
  let title = '';
  let subject = '';
  let code = '';
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (pdfs.length && pdfs.length === files.length) {
    const { papers } = pairFiles(pdfs);
    const first = papers[0]?.parsed;
    title = first?.subject && first.code ? `${first.subject} ${first.code}` : (first?.title ?? 'PDF papers');
    subject = first?.subject ?? '';
    code = first?.code ?? '';
    const built = bareImport(
      papers.map((p) => ({ id: p.parsed.id ?? p.parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title: p.parsed.title, group: p.parsed.group, questionCount: 40, timeLimitMin: defaultMinutes(p.parsed.code, p.parsed.paper, 40), optionCount: 4, qp: p.qp, ...(p.ms ? { ms: p.ms } : {}) })),
      { title, subject },
    );
    src = { ...built.source, text: built.text };
  } else if (files.length === 1 && /\.zip$/i.test(files[0]!.name)) {
    src = await readZip(files[0]!, files[0]!.name);
    if (src.backup) throw new BackendError('That is a personal backup. Share a pack instead (Pack for friends, or choose a pack on this device).');
    const p = parseFileName(files[0]!.name);
    title = p.subject && p.code ? `${p.subject} ${p.code}` : p.title;
    subject = p.subject ?? '';
    code = p.code ?? '';
  } else throw new BackendError('Choose one pack zip, or question paper PDFs');
  const report = mustPass(checkSource(src));
  try {
    const doc = JSON.parse(src.text ?? '{}') as { pack?: { title?: string; subject?: string } };
    if (doc.pack?.title) title = doc.pack.title;
    if (doc.pack?.subject) subject = doc.pack.subject;
  } catch {
    /* lenient JSON: keep the file-name guess */
  }
  const zip = files.length === 1 && /\.zip$/i.test(files[0]!.name) ? files[0]! : await zipSource(src);
  return { zip, meta: describe(report, title, subject, code), report, facts: factsOf(report, src) };
}

export interface PostPlan {
  id: string;
  ownerId: string;
  meta: SetMeta;
  ownerName: string;
  zip: Blob;
  cover: Blob | null;
  /** Finished steps: 'zip', 'cover', 'row'. */
  done: string[];
}

const PENDING = 'pendingPost';

export async function savePending(p: PostPlan | null) {
  const d = await store.db();
  if (p) await d.put('meta', p, PENDING);
  else await d.delete('meta', PENDING);
}
export const loadPending = async () => ((await (await store.db()).get('meta', PENDING)) as PostPlan | undefined) ?? null;

export const setPaths = (p: Pick<PostPlan, 'ownerId' | 'id'>) => ({ file: `${p.ownerId}/${p.id}/pack.zip`, cover: `${p.ownerId}/${p.id}/cover.png` });

/**
 * Posts a set: uploads the zip and the cover into the poster's own folder, then creates the row,
 * which the server accepts only once the file is there. Progress is per byte; every finished step
 * is saved, so a cancelled or failed post resumes where it stopped (also after a reload). The
 * server re-checks membership, folder, quota and size on every step.
 */
export async function postSet(plan: PostPlan, onProgress: (sent: number, total: number) => void, signal: AbortSignal, be: Backend | null = backend): Promise<void> {
  if (!be) throw new BackendError('The Library is not set up');
  if (plan.zip.size > MAX_SET_BYTES) throw new BackendError('Sets are limited to 100 MB');
  await savePending(plan);
  const total = plan.zip.size + (plan.cover?.size ?? 0);
  const paths = setPaths(plan);
  const steps: { key: string; path: string; blob: Blob; type: string; before: number }[] = [{ key: 'zip', path: paths.file, blob: plan.zip, type: 'application/zip', before: 0 }];
  if (plan.cover) steps.push({ key: 'cover', path: paths.cover, blob: plan.cover, type: 'image/png', before: plan.zip.size });
  for (const s of steps) {
    if (plan.done.includes(s.key)) {
      onProgress(s.before + s.blob.size, total);
      continue;
    }
    try {
      await be.upload('sets', { path: s.path, blob: s.blob, contentType: s.type }, (n) => onProgress(s.before + n, total), signal);
    } catch (e) {
      // A retried upload that already landed is fine.
      if (!(e instanceof BackendError && /already exists/.test(e.message))) throw e;
    }
    plan.done.push(s.key);
    await savePending(plan);
  }
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (!plan.done.includes('row')) {
    await be.createSet(plan.id, { ...plan.meta, ownerName: plan.ownerName, fileSize: plan.zip.size, hasCover: !!plan.cover, coverExt: 'png' });
    plan.done.push('row');
  }
  await savePending(null);
}
