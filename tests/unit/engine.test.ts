import { describe, expect, it } from 'vitest';
import { buildTimer, Countdown, crossedThreshold, perQuestionMaxSec, sanitizeTimer } from '../../src/lib/engine/timer';
import { drawRandom, standardLength, type PoolItem } from '../../src/lib/engine/random';
import { mulberry32 } from '../../src/lib/engine/rng';
import { applyAnswer, bankSizeAt, drillBudgetMs, emptyStat, selectDrill } from '../../src/lib/engine/mistakes';
import { gradeSession } from '../../src/lib/engine/grade';
import type { AnswerRecord } from '../../src/lib/types';

describe('timer clamp rules', () => {
  it('per-question max is floor(cap*60/questions)', () => {
    expect(perQuestionMaxSec(75, 40)).toBe(112);
    expect(perQuestionMaxSec(60, 7)).toBe(514);
  });
  it('fixed total never exceeds the cap', () => {
    expect(buildTimer({ kind: 'total', capMin: 75, questions: 40, minutes: 500 }).totalMs).toBe(75 * 60_000);
    expect(buildTimer({ kind: 'total', capMin: 75, questions: 40, minutes: 30 }).totalMs).toBe(30 * 60_000);
    expect(buildTimer({ kind: 'total', capMin: 75, questions: 40, minutes: -5 }).totalMs).toBe(60_000);
    expect(buildTimer({ kind: 'total', capMin: 75, questions: 40, minutes: NaN }).totalMs).toBe(60_000);
  });
  it('per-question budget is clamped so questions x seconds <= cap', () => {
    const t = buildTimer({ kind: 'perq', capMin: 75, questions: 40, perQSec: 1000, strict: true });
    expect(t.perQMs).toBe(112_000);
    expect(t.totalMs).toBeLessThanOrEqual(t.capMs);
    expect(t.strict).toBe(true);
  });
  it('no limit uses the cap', () => {
    const t = buildTimer({ kind: 'none', capMin: 45, questions: 30 });
    expect(t.totalMs).toBe(45 * 60_000);
  });
  it('sanitizeTimer re-clamps tampered configs', () => {
    const t = sanitizeTimer({ kind: 'perq', capMs: 60_000, totalMs: 9e9, perQMs: 9e9 }, 10);
    expect(t.totalMs).toBeLessThanOrEqual(60_000);
    expect(t.perQMs).toBe(6000);
  });
});

describe('Countdown (timestamp based)', () => {
  it('computes remaining from the end timestamp', () => {
    const c = new Countdown(60_000, 1_000_000, 0);
    expect(c.remaining(1_010_000, 10_000)).toBe(50_000);
  });
  it('charges laptop sleep even if the monotonic clock paused', () => {
    const c = new Countdown(600_000, 0, 0);
    // 5 minutes of sleep: wall advanced, monotonic did not.
    expect(c.remaining(300_000, 10)).toBe(300_000);
  });
  it('ignores interval throttling (no counting of ticks)', () => {
    const c = new Countdown(60_000, 0, 0);
    expect(c.remaining(59_999, 59_999)).toBe(1);
    expect(c.remaining(70_000, 70_000)).toBe(0);
  });
  it('never increases when the wall clock is set backwards', () => {
    const c = new Countdown(600_000, 1_000_000, 0);
    expect(c.remaining(1_100_000, 100_000)).toBe(500_000);
    // Clock set back an hour; one more second really elapsed.
    const r = c.remaining(1_100_000 - 3_600_000, 101_000);
    expect(r).toBe(499_000);
    expect(c.remaining(1_100_000 - 3_600_000 + 1000, 102_000)).toBe(498_000);
  });
  it('remaining is monotonic non-increasing under random clocks', () => {
    const rng = mulberry32(7);
    const c = new Countdown(1_000_000, 0, 0);
    let wall = 0;
    let mono = 0;
    let last = Infinity;
    for (let i = 0; i < 2000; i++) {
      const step = rng() * 2000;
      mono += step;
      wall += rng() < 0.05 ? (rng() - 0.6) * 100_000 : step;
      const r = c.remaining(wall, mono);
      expect(r).toBeLessThanOrEqual(last);
      expect(r).toBeGreaterThanOrEqual(0);
      last = r;
    }
  });
  it('announces thresholds once each', () => {
    expect(crossedThreshold(3_100_000, 2_900_000, 6_000_000)).toMatch(/Half/);
    expect(crossedThreshold(2_900_000, 2_800_000, 6_000_000)).toBeNull();
    expect(crossedThreshold(61_000, 59_000, 6_000_000)).toMatch(/One minute/);
  });
});

const pool = (spec: [string, number][]): PoolItem[] => spec.map(([qid, timesSeen]) => ({ qid, timesSeen }));

describe('random engine', () => {
  it('standard length is the most common paper length, ties to the longer', () => {
    expect(standardLength([40, 40, 30])).toBe(40);
    expect(standardLength([30, 40])).toBe(40);
    expect(standardLength([])).toBe(0);
  });
  it('draws from the lowest tier first and fills from the next', () => {
    const p = pool([
      ['a', 0], ['b', 0], ['c', 1], ['d', 1], ['e', 1], ['f', 2],
    ]);
    const out = drawRandom(p, 4, new Set(), mulberry32(1));
    expect(out).toHaveLength(4);
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out.filter((x) => ['c', 'd', 'e'].includes(x))).toHaveLength(2);
    expect(out).not.toContain('f');
  });
  it('uses all questions when the pool is smaller than the session', () => {
    const out = drawRandom(pool([['a', 3], ['b', 0]]), 40, new Set(), mulberry32(2));
    expect(out.sort()).toEqual(['a', 'b']);
  });
  it('never draws locked questions or duplicates', () => {
    const p = pool([['a', 0], ['a', 0], ['b', 0], ['c', 0]]);
    const out = drawRandom(p, 5, new Set(['b']), mulberry32(3));
    expect(out.sort()).toEqual(['a', 'c']);
  });
  it('exhausts tiers in order across many draws (property test)', () => {
    const rng = mulberry32(11);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rng() * 60);
      const p = Array.from({ length: n }, (_, i) => ({ qid: `q${i}`, timesSeen: Math.floor(rng() * 4) }));
      const locked = new Set(p.filter(() => rng() < 0.1).map((x) => x.qid));
      const size = 1 + Math.floor(rng() * 50);
      const out = drawRandom(p, size, locked, rng);
      const avail = p.filter((x) => !locked.has(x.qid));
      expect(out.length).toBe(Math.min(size, avail.length));
      expect(new Set(out).size).toBe(out.length);
      out.forEach((q) => expect(locked.has(q)).toBe(false));
      // Every drawn question's tier <= every undrawn available question's tier... unless the drawn tier was partially taken.
      const drawnMax = Math.max(...out.map((q) => p.find((x) => x.qid === q)!.timesSeen), -1);
      const undrawnMin = Math.min(...avail.filter((x) => !out.includes(x.qid)).map((x) => x.timesSeen), Infinity);
      expect(drawnMax).toBeLessThanOrEqual(undrawnMin);
    }
  });
  it('smart random biases within a tier toward wrong and unsure', () => {
    const p: PoolItem[] = Array.from({ length: 20 }, (_, i) => ({ qid: `q${i}`, timesSeen: 1, lastWrong: i < 2 }));
    let hits = 0;
    const rng = mulberry32(5);
    for (let t = 0; t < 2000; t++) {
      const out = drawRandom(p, 2, new Set(), rng, true);
      hits += out.filter((q) => q === 'q0' || q === 'q1').length;
    }
    // Uniform would give 2000 * 2 * 2/20 = 400; weight 3 roughly doubles to triples it.
    expect(hits).toBeGreaterThan(700);
  });
  it('smart random still respects tiers', () => {
    const p: PoolItem[] = [
      { qid: 'fresh', timesSeen: 0 },
      { qid: 'wrong', timesSeen: 3, lastWrong: true },
    ];
    expect(drawRandom(p, 1, new Set(), mulberry32(9), true)).toEqual(['fresh']);
  });
});

describe('mistakes bank', () => {
  const base = emptyStat('p', 'q');
  const ans = (correct: boolean, unsure = false, countSeen = true) => ({ correct, unsure, timeMs: 1000, at: 1, countSeen });
  it('wrong puts a question in the bank', () => {
    const r = applyAnswer(base, ans(false));
    expect(r.stat.inBank).toBe(true);
    expect(r.event).toBe('in');
    expect(r.stat.missed).toBe(1);
  });
  it('correct but unsure (shaky) puts it in the bank', () => {
    expect(applyAnswer(base, ans(true, true)).stat.inBank).toBe(true);
  });
  it('leaves after two consecutive correct, sure answers', () => {
    let s = applyAnswer(base, ans(false)).stat;
    let r = applyAnswer(s, ans(true));
    expect(r.stat.inBank).toBe(true);
    r = applyAnswer(r.stat, ans(true));
    expect(r.stat.inBank).toBe(false);
    expect(r.event).toBe('out');
    s = r.stat;
    expect(applyAnswer(s, ans(true)).event).toBeNull();
  });
  it('an unsure correct answer resets the streak', () => {
    let s = applyAnswer(base, ans(false)).stat;
    s = applyAnswer(s, ans(true)).stat;
    s = applyAnswer(s, ans(true, true)).stat;
    s = applyAnswer(s, ans(true)).stat;
    expect(s.inBank).toBe(true);
  });
  it('drills do not count towards timesSeen', () => {
    expect(applyAnswer(base, ans(false, false, false)).stat.timesSeen).toBe(0);
    expect(applyAnswer(base, ans(false)).stat.timesSeen).toBe(1);
  });
  it('drill selection prioritises missed count then recency', () => {
    const mk = (qid: string, missed: number, lastWrongAt: number, inBank = true) => ({ ...emptyStat('p', qid), missed, lastWrongAt, inBank });
    const stats = [mk('a', 1, 5), mk('b', 3, 1), mk('c', 1, 9), mk('d', 9, 9, false)];
    expect(selectDrill(stats, 10, new Set(['a', 'b', 'c', 'd']))).toEqual(['b', 'c', 'a']);
    expect(selectDrill(stats, 2, new Set(['a', 'b', 'c']))).toEqual(['b', 'c']);
  });
  it('drill budget is clamped per question', () => {
    expect(drillBudgetMs(10, 10)).toBe(300_000);
    expect(drillBudgetMs(1000, 10)).toBe(1_800_000);
  });
  it('bank size a week ago replays events', () => {
    expect(bankSizeAt(5, [{ at: 10, kind: 'in' }, { at: 20, kind: 'out' }, { at: 1, kind: 'in' }], 5)).toBe(5);
    expect(bankSizeAt(5, [{ at: 10, kind: 'in' }, { at: 10, kind: 'in' }], 5)).toBe(3);
  });
});

const rec = (qid: string, choice: number | null, extra: Partial<AnswerRecord> = {}): AnswerRecord => ({
  qid, choice, first: choice, changes: 0, timeMs: 10_000, flagged: false, unsure: false, checked: false, locked: false, ...extra,
});

describe('grading', () => {
  const key: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 };
  it('grades only answered questions; manual submit with blanks is partial', () => {
    const g = gradeSession([rec('a', 0), rec('b', 0), rec('c', null), rec('d', null)], (q) => key[q], false);
    expect(g.answered).toBe(2);
    expect(g.correct).toBe(1);
    expect(g.partial).toBe(true);
    expect(g.items.map((i) => i.qid)).toEqual(['a', 'b']);
  });
  it('auto-submit is never partial', () => {
    expect(gradeSession([rec('a', 0), rec('b', null)], (q) => key[q], true).partial).toBe(false);
  });
  it('full submit is complete', () => {
    expect(gradeSession([rec('a', 0), rec('b', 1)], (q) => key[q], false).partial).toBe(false);
  });
  it('tracks answer changes helped/hurt', () => {
    const g = gradeSession(
      [rec('a', 0, { first: 1, changes: 1 }), rec('b', 0, { first: 1, changes: 2 }), rec('c', 0, { first: 1, changes: 1 })],
      (q) => key[q],
      false,
    );
    expect(g.agg.changes).toEqual({ helped: 1, hurt: 1, neutral: 1 });
  });
  it('splits into thirds and calibration buckets', () => {
    const answers = Array.from({ length: 9 }, (_, i) => rec(`q${i}`, 0, { unsure: i % 2 === 0 }));
    const g = gradeSession(answers, () => 0, false);
    expect(g.agg.thirds).toEqual([[3, 3], [3, 3], [3, 3]]);
    expect(g.agg.unsureAcc).toEqual([5, 5]);
    expect(g.agg.sure).toEqual([4, 4]);
  });
});
