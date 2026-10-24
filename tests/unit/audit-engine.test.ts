// Audit (logic round 1): property-based and boundary tests of the pure engine.
// Tests marked it.fails demonstrate real bugs; they pass while the bug exists.
import { describe, expect, it } from 'vitest';
import { buildTimer, Countdown, perQuestionMaxSec, sanitizeTimer } from '../../src/lib/engine/timer';
import { drawRandom, standardLength, type PoolItem } from '../../src/lib/engine/random';
import { mulberry32, type Rng } from '../../src/lib/engine/rng';
import { applyAnswer, CLEAR_STREAK, emptyStat, selectDrill } from '../../src/lib/engine/mistakes';
import { gradeSession } from '../../src/lib/engine/grade';
import type { AnswerRecord, QuestionStat } from '../../src/lib/types';

const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

describe('random engine: randomised properties', () => {
  it('draws the right size, no duplicates, never excluded, lowest tiers first (plain and smart)', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rng = mulberry32(seed);
      const n = int(rng, 0, 60);
      const pool: PoolItem[] = [];
      for (let i = 0; i < n; i++) {
        pool.push({ qid: `q${int(rng, 0, n)}`, timesSeen: int(rng, 0, 4), lastWrong: rng() < 0.3, lastUnsure: rng() < 0.2 });
      }
      const excluded = new Set(pool.filter(() => rng() < 0.15).map((p) => p.qid));
      const size = int(rng, 0, 50);
      const smart = rng() < 0.5;
      const out = drawRandom(pool, size, excluded, rng, smart);
      // Reference: first occurrence of each non-excluded qid.
      const firstSeen = new Map<string, PoolItem>();
      for (const p of pool) if (!excluded.has(p.qid) && !firstSeen.has(p.qid)) firstSeen.set(p.qid, p);
      const avail = [...firstSeen.values()];
      expect(out.length).toBe(Math.min(size, avail.length));
      expect(new Set(out).size).toBe(out.length);
      for (const q of out) expect(excluded.has(q)).toBe(false);
      if (!out.length) continue;
      const tierOf = (q: string) => firstSeen.get(q)!.timesSeen;
      const maxTier = Math.max(...out.map(tierOf));
      // Every available question strictly below the highest tier used must be in the draw.
      for (const p of avail) if (p.timesSeen < maxTier) expect(out).toContain(p.qid);
    }
  });

  it('position in the shuffled list is not biased by tier (first slot roughly uniform)', () => {
    const pool: PoolItem[] = Array.from({ length: 10 }, (_, i) => ({ qid: `q${i}`, timesSeen: i < 5 ? 0 : 1 }));
    const counts = new Map<string, number>();
    const rng = mulberry32(7);
    const R = 20_000;
    for (let r = 0; r < R; r++) {
      const out = drawRandom(pool, 10, new Set(), rng);
      counts.set(out[0]!, (counts.get(out[0]!) ?? 0) + 1);
    }
    for (const c of counts.values()) expect(Math.abs(c / R - 0.1)).toBeLessThan(0.015);
  });

  it('standardLength: mode, ties to the longer, ignores zero/negative', () => {
    expect(standardLength([40, 40, 30])).toBe(40);
    expect(standardLength([30, 40])).toBe(40);
    expect(standardLength([0, -3])).toBe(0);
    expect(standardLength([])).toBe(0);
  });
});

describe('timer clamps: randomised', () => {
  it('no buildTimer input can exceed the cap; per-question max = floor(cap*60/q)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 5000; i++) {
      const capMin = int(rng, 1, 300);
      const questions = int(rng, 1, 400);
      const kind = (['none', 'total', 'perq'] as const)[int(rng, 0, 2)]!;
      const t = buildTimer({ kind, capMin, questions, minutes: (rng() - 0.2) * 1000, perQSec: (rng() - 0.2) * 5000, strict: rng() < 0.5 });
      expect(t.capMs).toBe(capMin * 60_000);
      expect(t.totalMs).toBeLessThanOrEqual(t.capMs);
      expect(t.totalMs).toBeGreaterThan(0);
      if (t.kind === 'perq') {
        expect(t.perQMs!).toBeLessThanOrEqual(perQuestionMaxSec(capMin, questions) * 1000);
        expect(t.perQMs! * questions).toBeLessThanOrEqual(t.capMs);
      }
    }
  });

  it('sanitizeTimer keeps totals within the stored cap for tampered positive configs', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 2000; i++) {
      const q = int(rng, 1, 200);
      const c = sanitizeTimer({ kind: 'perq', capMs: int(rng, 1, 1e7), totalMs: int(rng, 1, 1e9), perQMs: int(rng, 1, 1e8) }, q);
      expect(c.totalMs).toBeLessThanOrEqual(c.capMs);
      expect(c.perQMs! * q).toBeLessThanOrEqual(c.capMs);
    }
  });

  it.fails('BUG: sanitizeTimer lets a negative perQMs through, giving a negative session budget', () => {
    const c = sanitizeTimer({ kind: 'perq', capMs: 600_000, totalMs: 600_000, perQMs: -5000 }, 10);
    expect(c.totalMs).toBeGreaterThan(0);
  });
});

describe('Countdown under random wall and monotonic clocks', () => {
  /**
   * Simulates a session: real elapsed time advances both clocks; sleep advances wall only (the
   * monotonic clock may pause); occasional manual backward wall-clock changes.
   */
  function run(seed: number, allowBack: boolean) {
    const rng = mulberry32(seed);
    const initial = int(rng, 0, 3_600_000);
    let wall = 1_700_000_000_000 + int(rng, 0, 1e9);
    let mono = int(rng, 0, 1e6);
    let truth = 0; // true elapsed ms
    const c = new Countdown(initial, wall, mono);
    let prev = initial;
    for (let step = 0; step < 300; step++) {
      const roll = rng();
      if (roll < 0.75) {
        const dt = int(rng, 0, 5000);
        wall += dt;
        mono += dt;
        truth += dt;
      } else if (roll < 0.9) {
        const sleep = int(rng, 0, 600_000);
        wall += sleep;
        if (rng() < 0.5) mono += sleep; // some platforms keep the monotonic clock running in sleep
        truth += sleep;
      } else if (allowBack) {
        wall -= int(rng, 2000, 7_200_000); // clock set back by more than the 1 s threshold
      }
      const r = c.remaining(wall, mono);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(prev); // never increases
      prev = r;
      if (!allowBack) expect(r).toBe(Math.max(0, initial - truth)); // exact when the clock is honest
      else expect(r).toBeLessThanOrEqual(Math.max(0, initial - truth) + 1); // never more than the truth
    }
  }
  it('honest clocks: remaining = initial - elapsed exactly, sleep charged', () => {
    for (let s = 1; s <= 300; s++) run(s, false);
  });
  it('backward jumps (with real time between ticks) never give time back', () => {
    for (let s = 1; s <= 300; s++) run(s, true);
  });

  it.fails('BUG: a backward jump that roughly cancels a long tick gap is not detected and refunds the gap', () => {
    // Background tab: the tick fires after 60 s of real time (both clocks moved 60 s), but the
    // wall clock was also set back 60.5 s meanwhile. dWall = -0.5 s, which is above the -1 s
    // threshold, so no re-anchor: the 60 s really elapsed are never charged.
    const c = new Countdown(600_000, 1_000_000, 0);
    const r = c.remaining(1_000_000 + 60_000 - 60_500, 60_000);
    expect(r).toBe(540_000);
  });
});

describe('mistakes bank state machine: randomised against a reference', () => {
  it('in/out, streak, missed, timesSeen and events match a spec reference', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed);
      let s = emptyStat('p', 'x#1');
      let inBank = false;
      let goods = 0;
      let missed = 0;
      let seen = 0;
      const steps = int(rng, 1, 30);
      for (let i = 0; i < steps; i++) {
        const correct = rng() < 0.6;
        const unsure = rng() < 0.25;
        const countSeen = rng() < 0.7;
        const r = applyAnswer(s, { correct, unsure, timeMs: 1000, at: i, countSeen });
        // Reference
        const wasIn = inBank;
        if (!correct || unsure) {
          inBank = true;
          goods = 0;
        } else {
          goods++;
          if (inBank && goods >= CLEAR_STREAK) inBank = false;
        }
        if (!correct) missed++;
        if (countSeen) seen++;
        s = r.stat;
        expect(s.inBank).toBe(inBank);
        expect(s.missed).toBe(missed);
        expect(s.timesSeen).toBe(seen);
        expect(s.attempts).toBe(i + 1);
        expect(r.event).toBe(!wasIn && inBank ? 'in' : wasIn && !inBank ? 'out' : null);
      }
    }
  });

  it('drill selection: eligible bank members only, most missed then most recent wrong, capped', () => {
    const mk = (qid: string, missed: number, lastWrongAt: number, inBank = true): QuestionStat => ({ ...emptyStat('p', qid), missed, lastWrongAt, inBank });
    const stats = [mk('a', 1, 50), mk('b', 3, 10), mk('c', 3, 20), mk('d', 9, 99, false), mk('e', 5, 1)];
    expect(selectDrill(stats, 3, new Set(['a', 'b', 'c', 'd']))).toEqual(['c', 'b', 'a']);
    expect(selectDrill(stats, 0, new Set(['a']))).toEqual([]);
  });
});

describe('grading edge cases', () => {
  const rec = (qid: string, choice: number | null, extra: Partial<AnswerRecord> = {}): AnswerRecord => ({
    qid, choice, first: choice, changes: 0, timeMs: 10_000, flagged: false, unsure: false, checked: false, locked: false, ...extra,
  });
  const key = () => 0;

  it('zero answered, manual submit: partial, nothing graded', () => {
    const g = gradeSession([rec('a', null), rec('b', null)], key, false);
    expect(g).toMatchObject({ answered: 0, correct: 0, partial: true });
  });
  it('all unanswered auto-submit: complete (decision 34), nothing graded, time still summed', () => {
    const g = gradeSession([rec('a', null), rec('b', null)], key, true);
    expect(g).toMatchObject({ answered: 0, correct: 0, partial: false, timeMs: 20_000 });
    expect(g.items).toEqual([]);
  });
  it('an answered question whose key is missing is not graded and makes a manual submit partial', () => {
    const g = gradeSession([rec('a', 0), rec('b', 1)], (q) => (q === 'a' ? 0 : null), false);
    expect(g).toMatchObject({ answered: 1, correct: 1, partial: true });
  });
  it('single-question session puts its only answer in the first third', () => {
    const g = gradeSession([rec('a', 0)], key, false);
    expect(g.agg.thirds).toEqual([[1, 1], [0, 0], [0, 0]]);
  });
  it('answer changes: helped / hurt / neutral', () => {
    const g = gradeSession(
      [rec('a', 0, { first: 1, changes: 1 }), rec('b', 1, { first: 0, changes: 1 }), rec('c', 2, { first: 3, changes: 2 })],
      key,
      false,
    );
    expect(g.agg.changes).toEqual({ helped: 1, hurt: 1, neutral: 1 });
  });
  it('histogram edges are upper-exclusive (15 s goes to the 15-30 bin)', () => {
    const g = gradeSession([rec('a', 0, { timeMs: 14_999 }), rec('b', 0, { timeMs: 15_000 }), rec('c', 0, { timeMs: 999_000 })], key, false);
    expect(g.agg.hist[0]).toBe(1);
    expect(g.agg.hist[1]).toBe(1);
    expect(g.agg.hist[g.agg.hist.length - 1]).toBe(1);
  });
});
