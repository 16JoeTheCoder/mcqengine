import { bareImport, defaultMinutes } from '../data/bare';
import { exportPackZip } from '../data/backup';
import * as store from '../data/db';
import { readZip, sha256Hex, type ImportSource } from '../data/files';
import { checkSource, type CheckReport } from '../format/check';
import { pairFiles, parseFileName } from '../format/filename';
import { resolvePaperKeys, type KeyResolution } from '../format/identity';
import { lenientParse } from '../format/lenient';
import { validateDoc } from '../format/validate';
import { MANIFEST_FORMAT, MANIFEST_LIMITS, type SetManifest, type SetMeta } from '../../../shared/manifest';
import { isPaperKey, qpKeyOf } from '../../../shared/paper-key';
import { backend, type Backend } from '../backend';
import { BackendError } from '../backend/types';
import type { Pack } from '../types';

/**
 * Posting a set to the Library. The set keeps its permanent ID: posting a pack from this device
 * uses the pack's own set ID, so it is the same set everywhere and a later post is a new version
 * of it, never a second set. Files are stored once by hash: the client hashes each file, asks
 * which ones the server lacks, uploads only those, then publishes a small manifest.
 */
export const MAX_SET_BYTES = MANIFEST_LIMITS.versionBytes;

export interface Prepared {
  source: ImportSource;
  setId: string;
  /** The Library version this post builds on (0 for a new set). */
  base: number;
  /** The local pack this came from, if any; it is linked to the posted version. */
  packId?: string;
  meta: SetMeta;
  report: CheckReport;
  /** Paper key per paper: found, missing, or needing confirmation (the matching table). */
  keys: KeyResolution[];
  facts: string[];
}

const EXT_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf' };
const typeOf = (path: string, blob: Blob) => EXT_TYPE[path.split('.').pop()?.toLowerCase() ?? ''] ?? (blob.type || 'application/octet-stream');

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
  if (!r.ok) throw new BackendError(r.syntax ?? `This set has ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}: ${r.errors[0]?.path}: ${r.errors[0]?.message}`);
  if (!r.papers.length) throw new BackendError('There are no papers to share');
  return r;
}

function docOf(src: ImportSource) {
  const { value, notes } = lenientParse(src.text ?? '');
  return validateDoc(value, new Set([...src.files.keys(), ...src.pdfs.keys()]), notes).doc;
}

/** Cover-page text of each question paper, read lazily with pdf.js; missing in tests and on failure. */
async function coverText(src: ImportSource): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (typeof document === 'undefined' || !src.pdfs.size) return out;
  try {
    const { openPdf, pdfText } = await import('../pdf/pdf');
    for (const [path, blob] of src.pdfs) {
      const doc = await openPdf(blob);
      out.set(path, (await pdfText(doc, 1)).join('\n'));
    }
  } catch { /* the review table asks the user instead */ }
  return out;
}

async function finish(src: ImportSource, setId: string, base: number, meta: SetMeta, packId?: string): Promise<Prepared> {
  const report = mustPass(checkSource(src));
  const doc = docOf(src);
  return { source: src, setId, base, ...(packId ? { packId } : {}), meta, report, keys: resolvePaperKeys(doc, await coverText(src)), facts: factsOf(report, src) };
}

/** A pack on this device. Someone else's Library set cannot be re-posted. */
export async function prepareFromPack(pack0: Pack, be: Backend | null = backend): Promise<Prepared> {
  if (pack0.origin?.kind === 'library' && !pack0.setId) throw new BackendError('This pack came from the school Library. Post your changes from the set owner’s device, or make your own copy.');
  const pack = await store.ensureSetId(pack0.id);
  let base = pack.libraryVersion ?? 0;
  if (be && pack.origin?.kind === 'library') {
    const remote = await be.getSet(pack.setId!).catch(() => null);
    if (remote && !remote.set.mine) throw new BackendError(`This set belongs to ${remote.set.ownerName}. Only they can post a new version.`);
  }
  if (be && base) {
    // If the set was deleted from the Library, post it again as a new set with the same ID.
    const remote = await be.getSet(pack.setId!).catch((e: BackendError) => (e.status === 404 ? null : Promise.reject(e)));
    if (!remote) base = 0;
  }
  const [papers, ovs, snips] = await Promise.all([store.getPapers(pack.id), store.getOverrides(pack.id), store.getSnips(pack.id)]);
  const { blob } = await exportPackZip(pack, papers, ovs, snips, { library: true });
  const src = await readZip(blob, `${pack.id}.zip`);
  const code = papers.map((p) => p.paperKey ?? p.id).find((k) => /^\d{4}[_-]/.test(k))?.slice(0, 4) ?? '';
  return finish(src, pack.setId!, base, { title: pack.title, description: '', subject: pack.subject, code }, pack.id);
}

/** A zip, or question paper and mark scheme PDFs. A zip exported from DMC keeps its set ID. */
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
    if (src.backup) throw new BackendError('That is a personal backup. Post a paper set instead (Share it from the set, or choose a set on this device).');
    const p = parseFileName(files[0]!.name);
    title = p.subject && p.code ? `${p.subject} ${p.code}` : p.title;
    subject = p.subject ?? '';
    code = p.code ?? '';
  } else throw new BackendError('Choose one paper-set zip, or question paper PDFs');
  let setId: string = crypto.randomUUID();
  try {
    const doc = docOf(src);
    if (doc.pack?.title) title = doc.pack.title;
    if (doc.pack?.subject) subject = doc.pack.subject;
    if (doc.pack?.setId) setId = doc.pack.setId;
  } catch { /* the check below reports it */ }
  const local = await store.findPackBySetId(setId);
  return finish(src, setId, local?.libraryVersion ?? 0, { title, description: '', subject, code }, local?.id);
}

export interface PlanFile { hash: string; type: string; size: number; label: string; blob: Blob }
export interface PostPlan {
  setId: string;
  base: number;
  packId?: string;
  manifest: SetManifest;
  files: PlanFile[];
  /** Hashes already on the server or uploaded by this post. */
  done: string[];
}

/**
 * Builds the manifest: the pack document (with its set ID and confirmed keys written in), every
 * file it references by hash, and for each paper whose key the Library already knows, a link to
 * the stored files instead of an upload of this device's copy.
 */
export async function buildPlan(prep: Prepared, meta: SetMeta, confirmed: Record<string, string>, cover: Blob | null, be: Backend | null = backend): Promise<PostPlan> {
  const keys = prep.keys.map((k) => (confirmed[k.docId] && isPaperKey(confirmed[k.docId]) ? { ...k, key: qpKeyOf(confirmed[k.docId]!), status: 'found' as const } : k));
  const missing = keys.filter((k) => !k.key);
  if (missing.length && missing.some((k) => k.status === 'confirm')) throw new BackendError(`Confirm the paper key for ${missing.filter((k) => k.status === 'confirm').map((k) => k.title).join(', ')} first`);
  const raw = lenientParse(prep.source.text ?? '').value as { pack?: Record<string, unknown>; papers?: Record<string, unknown>[] };
  raw.pack = { ...(raw.pack ?? {}), title: meta.title, subject: meta.subject, setId: prep.setId };
  const files: PlanFile[] = [];
  const byPath: Record<string, string> = {};
  const add = async (path: string, blob: Blob, label: string) => {
    if (blob.size > MANIFEST_LIMITS.fileBytes) throw new BackendError(`${label} is ${(blob.size / 1048576).toFixed(1)} MB; files are limited to 25 MB each`);
    const hash = await sha256Hex(await blob.arrayBuffer());
    byPath[path] = hash;
    if (!files.some((f) => f.hash === hash)) files.push({ hash, type: typeOf(path, blob), size: blob.size, label, blob });
    return hash;
  };
  for (const [path, blob] of prep.source.pdfs) await add(path, blob, path.split('/').pop() ?? path);
  for (const [path, blob] of prep.source.files) await add(path, blob, path.split('/').pop() ?? path);

  const registry = be ? await be.lookupPapers([...new Set(keys.map((k) => k.key).filter((k): k is string => !!k))]) : [];
  const doc = docOf(prep.source);
  const papers: SetManifest['papers'] = [];
  doc.papers.forEach((p, i) => {
    const key = keys[i]?.key ?? null;
    const rawPaper = raw.papers?.[i];
    if (rawPaper && key) rawPaper.key = key;
    const reg = key ? registry.find((r) => r.key === key) : undefined;
    let qp = p.pdf?.questionPaper ? byPath[p.pdf.questionPaper] : undefined;
    let ms = p.pdf?.markScheme ? byPath[p.pdf.markScheme] : undefined;
    // Same paper key already in the Library: link its stored files, upload nothing new for them.
    const link = (h: string | null | undefined, path: string | undefined, kind: 'questionPaper' | 'markScheme', name: string) => {
      if (!h) return undefined;
      const at = path ?? `pdfs/${name}.pdf`;
      byPath[at] = h;
      if (rawPaper) rawPaper.pdf = { ...((rawPaper.pdf as Record<string, string> | undefined) ?? {}), [kind]: at };
      return h;
    };
    if (reg?.qp && reg.qp !== qp) qp = link(reg.qp, p.pdf?.questionPaper, 'questionPaper', key!);
    if (reg?.ms && reg.ms !== ms) ms = link(reg.ms, p.pdf?.markScheme, 'markScheme', reg.msKey);
    const r = prep.report.papers[i];
    papers.push({ id: p.id, key, title: p.title, questionCount: p.questionCount, keyed: Math.min(p.questionCount, r?.keyed ?? 0), ...(qp ? { qp } : {}), ...(ms ? { ms } : {}), ...(p.bare ? { bare: true } : {}) });
  });
  // Files linked from the registry replace this device's copies, which then need no upload.
  const used = new Set(Object.values(byPath));
  const packText = JSON.stringify(raw);
  const packBlob = new Blob([packText], { type: 'application/json' });
  const packHash = await sha256Hex(packText);
  const all = files.filter((f) => used.has(f.hash));
  all.unshift({ hash: packHash, type: 'application/json', size: packBlob.size, label: 'Typed questions', blob: packBlob });
  let coverHash: string | undefined;
  if (cover) {
    coverHash = await sha256Hex(await cover.arrayBuffer());
    if (!all.some((f) => f.hash === coverHash)) all.push({ hash: coverHash, type: cover.type || 'image/png', size: cover.size, label: 'Cover', blob: cover });
  }
  const total = all.reduce((a, f) => a + f.size, 0) + [...used].filter((h) => !all.some((f) => f.hash === h)).length;
  if (total > MAX_SET_BYTES) throw new BackendError('A set version is limited to 200 MB. Split it into two sets.');
  const manifest: SetManifest = { format: MANIFEST_FORMAT, pack: packHash, ...(coverHash ? { cover: coverHash } : {}), files: Object.fromEntries(Object.entries(byPath).sort()), papers, meta: { title: meta.title.trim().slice(0, 120), description: meta.description.trim().slice(0, 1000), subject: meta.subject.slice(0, 80), code: meta.code.slice(0, 20) } };
  return { setId: prep.setId, base: prep.base, ...(prep.packId ? { packId: prep.packId } : {}), manifest, files: all, done: [] };
}

const PENDING = 'pendingPost';
export async function savePending(p: PostPlan | null) {
  const d = await store.db();
  if (p) await d.put('meta', p, PENDING);
  else await d.delete('meta', PENDING);
}
export const loadPending = async () => {
  const p = (await (await store.db()).get('meta', PENDING)) as PostPlan | undefined;
  return p && p.manifest?.format === MANIFEST_FORMAT ? p : null;
};

export type PostStep = { step: 'checking' } | { step: 'uploading'; file: number; files: number; label: string; sent: number; total: number } | { step: 'publishing' };

/**
 * Posts a plan: check which files the server lacks, upload those one by one (progress per file
 * and per byte; a failure names the file), then publish the manifest. Every finished file is
 * saved, so a cancelled or failed post resumes where it stopped, also after a reload.
 */
export async function postSet(plan: PostPlan, onStep: (s: PostStep) => void, signal: AbortSignal, be: Backend | null = backend): Promise<{ version: number }> {
  if (!be) throw new BackendError('The Library is not set up');
  await savePending(plan);
  onStep({ step: 'checking' });
  const needed = new Set([plan.manifest.pack, ...(plan.manifest.cover ? [plan.manifest.cover] : []), ...Object.values(plan.manifest.files)]);
  const missing = new Set(await be.checkBlobs([...needed]));
  const todo = plan.files.filter((f) => missing.has(f.hash));
  const unknown = [...missing].filter((h) => !plan.files.some((f) => f.hash === h));
  if (unknown.length) throw new BackendError('A linked Library file is no longer stored. Choose the files again.');
  const total = todo.reduce((a, f) => a + f.size, 0);
  let before = 0;
  for (const [i, f] of todo.entries()) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
      await be.uploadBlob(f.hash, f.blob, f.type, (sent) => onStep({ step: 'uploading', file: i + 1, files: todo.length, label: f.label, sent: before + sent, total }), signal);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new BackendError(`${f.label}: ${(e as Error).message}`, (e as BackendError).status);
    }
    before += f.size;
    plan.done.push(f.hash);
    await savePending(plan);
  }
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  onStep({ step: 'publishing' });
  const { version } = await be.publishVersion(plan.setId, plan.base, plan.manifest);
  await savePending(null);
  if (plan.packId) {
    const pack = await store.getPack(plan.packId);
    if (pack && (pack.setId === plan.setId)) await store.putPack({ ...pack, libraryVersion: version, updatedAt: Math.max(Date.now(), pack.updatedAt + 1) });
  }
  return { version };
}
