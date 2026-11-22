import { isFingerprint } from './fingerprint';
import { isPaperKey } from './paper-key';

/**
 * A Library set version: a small JSON manifest. Every file it names is stored once in R2 at
 * `blobs/<sha256>`; the manifest holds only hashes. `pack` is the typed content (a dmc-pack/1
 * document, with `pack.setId`); `files` maps each path that document references to its hash.
 */
export const MANIFEST_FORMAT = 'dmc-set/1';
export const MANIFEST_LIMITS = { papers: 200, files: 3000, titleChars: 120, descriptionChars: 1000, fileBytes: 25 * 1024 * 1024, versionBytes: 200 * 1024 * 1024 } as const;

export interface ManifestPaper {
  /** Paper id inside the pack document. */
  id: string;
  /** Cambridge code (`9702_s24_qp_12`) read automatically, or null. A label, not the identity. */
  key: string | null;
  title: string;
  questionCount: number;
  keyed: number;
  qp?: string;
  ms?: string;
  bare?: boolean;
  /** Text fingerprint of the question paper (shared/fingerprint.ts). */
  fp?: string;
}
export interface SetMeta { title: string; description: string; subject: string; code: string }
export interface SetManifest {
  format: typeof MANIFEST_FORMAT;
  pack: string;
  cover?: string;
  files: Record<string, string>;
  papers: ManifestPaper[];
  meta: SetMeta;
}
/** As served: the server adds the set ID and version. */
export interface PublishedManifest extends SetManifest { setId: string; version: number }

const HASH = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (m: string): never => { throw new Error(m); };
const text = (v: unknown, name: string, max: number, min = 0) => (typeof v === 'string' && v.length <= max && v.trim().length >= min ? v : fail(`${name} must be text of at most ${max} characters`));

/** Strict shape check, identical on both sides. Returns the hashes the manifest points at. */
export function validateManifest(v: unknown): { manifest: SetManifest; hashes: Set<string> } {
  if (!isObj(v) || v.format !== MANIFEST_FORMAT) fail('Not a DMC set manifest');
  const m = v as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!['format', 'pack', 'cover', 'files', 'papers', 'meta'].includes(k)) fail(`Unexpected field "${k.slice(0, 40)}" in the manifest`);
  const hashes = new Set<string>();
  const h = (x: unknown, what: string) => (typeof x === 'string' && HASH.test(x) ? (hashes.add(x), x) : fail(`${what} must be a file hash`));
  h(m.pack, 'pack');
  if (m.cover !== undefined) h(m.cover, 'cover');
  if (!isObj(m.files) || Object.keys(m.files).length > MANIFEST_LIMITS.files) fail(`files must map at most ${MANIFEST_LIMITS.files} paths to hashes`);
  for (const [path, x] of Object.entries(m.files as Record<string, unknown>)) {
    if (path.length > 300 || !/^(pdfs|images)\/[^\\]+$/.test(path) || path.includes('..')) fail('File paths must be inside pdfs/ or images/');
    h(x, `files["${path.slice(0, 40)}"]`);
  }
  if (!Array.isArray(m.papers) || !m.papers.length || m.papers.length > MANIFEST_LIMITS.papers) fail(`A set needs 1 to ${MANIFEST_LIMITS.papers} papers`);
  const ids = new Set<string>();
  for (const p of m.papers as unknown[]) {
    if (!isObj(p)) fail('Invalid paper');
    const pp = p as Record<string, unknown>;
    for (const k of Object.keys(pp)) if (!['id', 'key', 'title', 'questionCount', 'keyed', 'qp', 'ms', 'bare', 'fp'].includes(k)) fail(`Unexpected paper field "${k.slice(0, 40)}"`);
    const id = text(pp.id, 'Paper id', 64, 1);
    if (ids.has(id)) fail(`Paper "${id}" appears twice`);
    ids.add(id);
    if (pp.key !== null && !(isPaperKey(pp.key) && pp.key.includes('_qp_'))) fail(`Paper "${id}" has an invalid paper key`);
    text(pp.title, 'Paper title', MANIFEST_LIMITS.titleChars, 1);
    if (!Number.isInteger(pp.questionCount) || Number(pp.questionCount) < 1 || Number(pp.questionCount) > 200) fail('questionCount must be 1 to 200');
    if (!Number.isInteger(pp.keyed) || Number(pp.keyed) < 0 || Number(pp.keyed) > Number(pp.questionCount)) fail('keyed must be 0 to questionCount');
    if (pp.qp !== undefined) h(pp.qp, 'qp');
    if (pp.ms !== undefined) h(pp.ms, 'ms');
    if (pp.bare !== undefined && typeof pp.bare !== 'boolean') fail('bare must be true or false');
    if (pp.fp !== undefined && !isFingerprint(pp.fp)) fail('fp must be a text fingerprint');
  }
  if (!isObj(m.meta)) fail('Missing meta');
  const meta = m.meta as Record<string, unknown>;
  for (const k of Object.keys(meta)) if (!['title', 'description', 'subject', 'code'].includes(k)) fail(`Unexpected meta field "${k.slice(0, 40)}"`);
  text(meta.title, 'Title', MANIFEST_LIMITS.titleChars, 1);
  text(meta.description, 'Description', MANIFEST_LIMITS.descriptionChars);
  text(meta.subject, 'Subject', 80);
  text(meta.code, 'Code', 20);
  return { manifest: v as unknown as SetManifest, hashes };
}

/** File types the Library accepts, checked against the real bytes on upload. */
export const BLOB_TYPES = ['application/pdf', 'application/json', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'] as const;
export type BlobType = (typeof BLOB_TYPES)[number];

/** Magic-byte check of the first bytes against the declared type. */
export function sniffMatches(type: string, head: Uint8Array): boolean {
  const s = (i: number, bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  const ascii = new TextDecoder().decode(head.subarray(0, 512)).replace(/^\uFEFF/, '').trimStart();
  switch (type) {
    case 'application/pdf': return s(0, [0x25, 0x50, 0x44, 0x46]); // %PDF
    case 'image/png': return s(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return s(0, [0xff, 0xd8, 0xff]);
    case 'image/webp': return s(0, [0x52, 0x49, 0x46, 0x46]) && s(8, [0x57, 0x45, 0x42, 0x50]);
    case 'image/gif': return s(0, [0x47, 0x49, 0x46, 0x38]);
    case 'image/svg+xml': return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(ascii);
    case 'application/json': return ascii.startsWith('{');
    default: return false;
  }
}
