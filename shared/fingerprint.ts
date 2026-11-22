/**
 * Paper identity without typed keys. Two PDFs are the same paper when their bytes are identical
 * (SHA-256, the blob hash) or, for the same paper saved again with different bytes, when their
 * text is nearly identical. The text fingerprint is a MinHash of 5-word shingles from the first
 * pages; similarity is the share of equal slots (an estimate of Jaccard similarity). Shared by the
 * app (which reads the PDF text) and the Worker (which matches fingerprints). Pure and deterministic.
 */
export const FP_SLOTS = 64;
export const FP_HEX = FP_SLOTS * 8;
export const FP_BANDS = 16;
/** Same paper at or above this similarity. */
export const FP_SAME = 0.9;
/** Fewer shingles than this (a scanned PDF, an answer sheet) gives no fingerprint: hash only. */
export const FP_MIN_SHINGLES = 60;
const SHINGLE = 5;

/** Lower case, letters and digits only, one space between words. */
export function normaliseText(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function fnv(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Final avalanche so nearby seeds give independent orders.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function shingles(text: string): Set<string> {
  const w = normaliseText(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(w.slice(i, i + SHINGLE).join(' '));
  return out;
}

/** 512 hex characters, or null when the text is too short to identify the paper. */
export function fingerprintOf(text: string): string | null {
  const sh = shingles(text);
  if (sh.size < FP_MIN_SHINGLES) return null;
  const mins = new Array<number>(FP_SLOTS).fill(0xffffffff);
  for (const s of sh) {
    for (let k = 0; k < FP_SLOTS; k++) {
      const h = fnv(s, Math.imul(k + 1, 0x9e3779b1));
      if (h < mins[k]!) mins[k] = h;
    }
  }
  return mins.map((m) => m.toString(16).padStart(8, '0')).join('');
}

export const isFingerprint = (v: unknown): v is string => typeof v === 'string' && v.length === FP_HEX && /^[0-9a-f]+$/.test(v);

/** Estimated Jaccard similarity of two fingerprints, 0 to 1. */
export function similarity(a: string, b: string): number {
  if (!isFingerprint(a) || !isFingerprint(b)) return 0;
  let same = 0;
  for (let k = 0; k < FP_SLOTS; k++) if (a.slice(k * 8, k * 8 + 8) === b.slice(k * 8, k * 8 + 8)) same++;
  return same / FP_SLOTS;
}

/** Locality-sensitive bands: papers sharing any band are candidates (16 bands of 4 slots). */
export function bandsOf(fp: string): string[] {
  const per = FP_SLOTS / FP_BANDS;
  return Array.from({ length: FP_BANDS }, (_, b) => `${b.toString(16)}:${fp.slice(b * per * 8, (b + 1) * per * 8)}`);
}
