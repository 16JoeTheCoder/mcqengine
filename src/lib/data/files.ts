/** Reading import sources (text, json, zip, folder) into text plus a map of image files. */
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_ZIP_BYTES = 100_000_000;
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
  /** Present when the source is a DMC backup rather than a pack document. */
  backup?: { manifest: string; data: string; images: Map<string, Blob> };
  skipped: string[];
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Unzips in memory. Ignores __MACOSX and dotfiles; refuses oversized archives. */
export async function readZip(file: Blob, name: string): Promise<ImportSource> {
  if (file.size > MAX_ZIP_BYTES) throw new Error('Zip is larger than 100 MB');
  const { unzipSync } = await import('fflate');
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (f) => !f.name.startsWith('__MACOSX') && !/(^|\/)\./.test(f.name) && f.originalSize <= MAX_ZIP_BYTES,
  });
  return settle(
    fromEntries(
      name,
      Object.entries(entries).map(([p, bytes]) => [norm(p), bytes] as const),
    ),
  );
}

function fromEntries(name: string, list: (readonly [string, Uint8Array | Blob])[]): ImportSource {
  const src: ImportSource = { name, text: null, files: new Map(), skipped: [] };
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
    for (const [p, b] of items) if (p.startsWith('images/')) images.set(p.slice(7), toBlob(b, 'application/octet-stream'));
    pending.push(
      Promise.all([decode(manifest[1]), decode(data[1])]).then(([m, d]) => {
        src.backup = { manifest: m, data: d, images };
      }),
    );
  } else {
    const jsons = items.filter(([p]) => /\.json$/i.test(p));
    const main = jsons.find(([p]) => /(^|\/)pack\.json$/i.test(p)) ?? jsons[0];
    if (main) pending.push(decode(main[1]).then((t) => void (src.text = t)));
    for (const [p, b] of items) {
      const type = imageType(p);
      if (!type) continue;
      const size = b instanceof Blob ? b.size : b.byteLength;
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
      return { name: f.name, text: await f.text(), files: new Map(), skipped: [] };
    }
  }
  // A folder (webkitdirectory) or several files at once.
  const zip = files.find((f) => /\.zip$/i.test(f.name));
  if (zip) return readZip(zip, zip.name);
  const list = files.map((f) => [norm((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name), f] as const);
  return settle(fromEntries(files.length > 1 ? `${files.length} files` : (files[0]?.name ?? 'files'), list));
}

async function settle(s: ImportSource): Promise<ImportSource> {
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
