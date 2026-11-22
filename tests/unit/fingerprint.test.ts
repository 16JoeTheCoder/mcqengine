import { describe, expect, it } from 'vitest';
import { FP_BANDS, FP_HEX, FP_MIN_SHINGLES, FP_SAME, bandsOf, fingerprintOf, normaliseText, shingles, similarity } from '../../shared/fingerprint';

/** Deterministic synthetic text: `words` words drawn from a 5000-word made-up vocabulary. */
function synthetic(seed: number, words: number): string {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(`w${(next() % 5000).toString(36)}x`);
  return out.join(' ');
}
const fp = (t: string) => fingerprintOf(t)!;

describe('fingerprintOf', () => {
  const a = synthetic(1, 400);
  it('is 512 hex characters and deterministic', () => {
    const f = fp(a);
    expect(f).toHaveLength(FP_HEX);
    expect(f).toMatch(/^[0-9a-f]{512}$/);
    expect(fingerprintOf(a)).toBe(f);
  });
  it('is null under 60 shingles and set at exactly 60', () => {
    expect(fingerprintOf('')).toBeNull();
    expect(fingerprintOf(synthetic(2, 30))).toBeNull();
    // n distinct words give n - 4 shingles.
    const distinct = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`).join(' ');
    expect(shingles(distinct(FP_MIN_SHINGLES + 3)).size).toBe(FP_MIN_SHINGLES - 1);
    expect(fingerprintOf(distinct(FP_MIN_SHINGLES + 3))).toBeNull();
    expect(fingerprintOf(distinct(FP_MIN_SHINGLES + 4))).not.toBeNull();
  });
});

describe('similarity', () => {
  const text = synthetic(7, 400);
  it('is 1 for the same text', () => expect(similarity(fp(text), fp(text))).toBe(1));
  it('ignores whitespace, case and punctuation', () => {
    const noisy = text.toUpperCase().split(' ').join('  \n\t ').replace(/ /g, ', ') + '!!';
    expect(normaliseText(noisy)).toBe(normaliseText(text));
    expect(similarity(fp(text), fp(noisy))).toBe(1);
  });
  it('stays at or above 0.9 when one sentence of about 400 words changes', () => {
    const w = text.split(' ');
    const changed = [...w.slice(0, 200), ...synthetic(99, 12).split(' '), ...w.slice(212)].join(' ');
    expect(changed).not.toBe(text);
    const s = similarity(fp(text), fp(changed));
    expect(s).toBeGreaterThanOrEqual(FP_SAME);
    expect(s).toBeLessThan(1);
  });
  it('is below 0.5 for two different papers', () => {
    expect(similarity(fp(synthetic(11, 400)), fp(synthetic(12, 400)))).toBeLessThan(0.5);
    expect(similarity(fp(synthetic(13, 600)), fp(synthetic(14, 300)))).toBeLessThan(0.5);
  });
  it('is 0 for invalid input', () => {
    const f = fp(text);
    expect(similarity('', f)).toBe(0);
    expect(similarity(f, 'abc')).toBe(0);
    expect(similarity(f.slice(1), f)).toBe(0);
    expect(similarity(f.toUpperCase(), f)).toBe(0);
    expect(similarity('z'.repeat(FP_HEX), f)).toBe(0);
    expect(similarity(undefined as unknown as string, null as unknown as string)).toBe(0);
  });
});

describe('bandsOf', () => {
  it('returns 16 distinct strings, equal for equal prints and mostly different otherwise', () => {
    const a = fp(synthetic(21, 400));
    const bands = bandsOf(a);
    expect(bands).toHaveLength(FP_BANDS);
    expect(new Set(bands).size).toBe(FP_BANDS);
    expect(bandsOf(a)).toEqual(bands);
    const other = bandsOf(fp(synthetic(22, 400)));
    expect(bands.filter((b) => other.includes(b))).toEqual([]);
  });
  it('a near-copy shares at least one band', () => {
    const t = synthetic(23, 400);
    const w = t.split(' ');
    const changed = [...w.slice(0, 100), ...synthetic(5, 10).split(' '), ...w.slice(110)].join(' ');
    const shared = bandsOf(fp(t)).filter((b) => bandsOf(fp(changed)).includes(b));
    expect(shared.length).toBeGreaterThan(0);
  });
});
