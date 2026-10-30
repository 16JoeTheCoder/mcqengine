/** Reading import sources (text, json, zip, folder) into text plus maps of image and PDF files. */
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_ZIP_BYTES = 100_000_000;
/** Zip guards: entry count, per-entry and total decompressed size (counted while inflating). */
export const ZIP_LIMITS = { entries: 2000, entryBytes: 60_000_000, totalBytes: 300_000_000 };
export const MAX_PDF_FILE_BYTES = 60_000_000;
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

export const imageType = (path: string) => IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];

export interface ImportSource {
  name: string;
  text: string | null;
  /** Image files by path relative to the JSON (e.g. "images/q5.png"). */
  files: Map<string, Blob>;
  /** PDF files by path (e.g. "pdfs/9702_s23_qp_12.pdf"). */
  pdfs: Map<string, Blob>;
  /** Present when the source is a DMC backup rather than a pack document. */
  backup?: { manifest: string; data: string; images: Map<string, Blob>; pdfs: Map<string, Blob> };
  skipped: string[];
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Paths that could escape a folder if anyone ever wrote them to disk: refused outright. */
export function unsafePath(p: string): boolean {
  return /\0/.test(p) || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').some((seg) => seg === '..');
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ZipError extends Error {}

/**
 * Unzips in memory, defensively. Every pack is hostile input: paths with "..", absolute paths and
 * drive letters are refused; entry count is capped; decompressed bytes are counted as they are
 * inflated, so a zip bomb (or a header that lies about sizes) stops at the limit instead of
 * filling memory. __MACOSX and dotfiles are skipped.
 */
export async function unzipGuarded(file: Blob, limits = ZIP_LIMITS): Promise<[string, Uint8Array][]> {
  if (file.size > MAX_ZIP_BYTES) throw new ZipError('Zip is larger than 100 MB');
  const { Unzip, UnzipInflate } = await import('fflate');
  const out: [string, Uint8Array][] = [];
  let failure: string | null = null;
  let count = 0;
  let total = 0;
  const uz = new Unzip((entry) => {
    if (failure) return;
    const name = norm(entry.name);
    if (++count > limits.entries) {
      failure = `The zip has more than ${limits.entries} files`;
      return;
    }
    if (unsafePath(name)) {
      failure = `Unsafe path in the zip: ${name.slice(0, 80)}`;
      return;
    }
    if (name.endsWith('/') || name.startsWith('__MACOSX') || /(^|\/)\./.test(name)) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    entry.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) {
        failure = 'The zip is damaged';
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > limits.entryBytes || total > limits.totalBytes) {
        failure = 'The zip expands to more than the size limit, so it was not opened';
        entry.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const all = new Uint8Array(size);
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.length;
        }
        out.push([name, all]);
      }
    };
    entry.start();
  });
  uz.register(UnzipInflate);
  const buf = new Uint8Array(await file.arrayBuffer());
  const step = 1 << 20;
  try {
    for (let i = 0; i < buf.length && !failure; i += step) uz.push(buf.subarray(i, i + step), i + step >= buf.length);
    if (!buf.length) uz.push(buf, true);
  } catch {
    failure ??= 'The zip could not be read';
  }
  if (!failure && count === 0 && buf.length) failure = 'This is not a zip file, or it is damaged';
  if (failure) throw new ZipError(failure);
  return out;
}

export async function readZip(file: Blob, name: string): Promise<ImportSource> {
  return settle(fromEntries(name, await unzipGuarded(file)));
}

export function fromEntries(name: string, list: (readonly [string, Uint8Array | Blob])[]): ImportSource {
  const src: ImportSource = { name, text: null, files: new Map(), pdfs: new Map(), skipped: [] };
  const toBlob = (b: Uint8Array | Blob, type: string) => (b instanceof Blob ? b : new Blob([b as BlobPart], { type }));
  const decode = async (b: Uint8Array | Blob) => (b instanceof Blob ? b.text() : new TextDecoder().decode(b));
  // Strip a single top-level folder so "pack/images/q1.png" matches "images/q1.png".
  const tops = new Set(list.map(([p]) => p.split('/')[0]));
  const strip = tops.size === 1 && list.every(([p]) => p.includes('/'));
  const items = list.map(([p, b]) => [strip ? p.slice(p.indexOf('/') + 1) : p, b] as const).filter(([p]) => p && !p.endsWith('/'));
  const manifest = items.find(([p]) => p === 'dmc-backup.json');
  const data = items.find(([p]) => p === 'data.json');
  const pending: Promise<void>[] = [];
  if (manifest && data) {
    const images = new Map<string, Blob>();
    const pdfs = new Map<string, Blob>();
    for (const [p, b] of items) if (p.startsWith('images/')) images.set(p.slice(7), toBlob(b, 'application/octet-stream'));
    for (const [p, b] of items) if (p.startsWith('pdfs/')) pdfs.set(p.slice(5), toBlob(b, 'application/pdf'));
    pending.push(
      Promise.all([decode(manifest[1]), decode(data[1])]).then(([m, d]) => {
        src.backup = { manifest: m, data: d, images, pdfs };
      }),
    );
  } else {
    const jsons = items.filter(([p]) => /\.json$/i.test(p));
    const main = jsons.find(([p]) => /(^|\/)pack\.json$/i.test(p)) ?? jsons[0];
    if (main) pending.push(decode(main[1]).then((t) => void (src.text = t)));
    for (const [p, b] of items) {
      const size0 = b instanceof Blob ? b.size : b.byteLength;
      if (/\.pdf$/i.test(p)) {
        if (size0 > MAX_PDF_FILE_BYTES) src.skipped.push(`${p} (over 60 MB)`);
        else src.pdfs.set(p, toBlob(b, 'application/pdf'));
        continue;
      }
      const type = imageType(p);
      if (!type) continue;
      const size = size0;
      if (size > MAX_IMAGE_BYTES) src.skipped.push(`${p} (over 5 MB)`);
      else src.files.set(p, toBlob(b, type));
    }
  }
  (src as ImportSource & { ready: Promise<unknown> }).ready = Promise.all(pending);
  return src;
}

export async function readFiles(files: File[]): Promise<ImportSource> {
  if (files.length === 1) {
    const f = files[0] as File;
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip') return readZip(f, f.name);
    if (/\.(json|txt|md)$/i.test(f.name) || f.type.startsWith('text/') || f.type === 'application/json') {
      if (f.size > 15_000_000) throw new Error('File is larger than 15 MB');
      return { name: f.name, text: await f.text(), files: new Map(), pdfs: new Map(), skipped: [] };
    }
  }
  // A folder (webkitdirectory) or several files at once.
  const zip = files.find((f) => /\.zip$/i.test(f.name));
  if (zip) return readZip(zip, zip.name);
  const list = files.map((f) => [norm((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name), f] as const);
  return settle(fromEntries(files.length > 1 ? `${files.length} files` : (files[0]?.name ?? 'files'), list));
}

export async function settle(s: ImportSource): Promise<ImportSource> {
  await (s as ImportSource & { ready?: Promise<unknown> }).ready;
  delete (s as ImportSource & { ready?: unknown }).ready;
  return s;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
