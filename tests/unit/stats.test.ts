import { describe, expect, it } from 'vitest';
import { mad, median, ols, qualifying, rolling3, trimmedMean } from '../../src/lib/stats/core';
import { computeVerdict, projectScore } from '../../src/lib/stats/verdict';
import { detectRushed } from '../../src/lib/stats/rushed';
import { bankKpi, paceKpi, scoreKpi, sessionsKpi } from '../../src/lib/stats/kpi';
import type { SessionSummary } from '../../src/lib/types';

let seq = 0;
const S = (o: Partial<SessionSummary> = {}): SessionSummary => {
  seq++;
  return {
    id: `s${seq}`, packId: 'p', type: 'paper', mode: 'exam', title: 't', status: 'submitted', partial: false,
    startedAt: seq * 1000, endedAt: seq * 1000 + 500, updatedAt: seq, total: 40, answered: 40, correct: 30, timeMs: 40 * 90_000, ...o,
  };
};

describe('core statistics', () => {
  it('median and MAD', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
  });
  it('trimmed mean drops extremes only with 5 or more values', () => {
    expect(trimmedMean([1, 2, 3, 4])).toBe(2.5);
    expect(trimmedMean([0, 2, 3, 4, 100])).toBe(3);
  });
  it('OLS recovers a line', () => {
    const f = ols([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(f.slope).toBeCloseTo(2);
    expect(f.intercept).toBeCloseTo(1);
  });
  it('rolling-3 starts at the third session', () => {
    expect(rolling3([0.3, 0.6, 0.9, 0.3])).toEqual([
      { index: 2, value: 0.6 },
      { index: 3, value: 0.6 },
    ]);
    expect(rolling3([1, 2])).toEqual([]);
  });
  it('qualifying excludes partial, drills and practice by default', () => {
    const list = [S(), S({ partial: true }), S({ type: 'drill' }), S({ mode: 'practice' }), S({ status: 'saved' }), S({ type: 'random' })];
    expect(qualifying(list)).toHaveLength(2);
    expect(qualifying(list, { includePractice: true })).toHaveLength(3);
    expect(qualifying(list, { includePartial: true })).toHaveLength(3);
  });
});

describe('verdict', () => {
  it('requires 4 qualifying sessions', () => {
    expect(computeVerdict([0.5, 0.6, 0.7], [40, 40, 40])).toEqual({ state: 'locked', needed: 1 });
  });
  it('binomial noise with fewer than 6 sessions; SE maths', () => {
    // 4 sessions: k = 2. p = 0.6, N = 40 -> SE1 = sqrt(.24/40) = 0.07746; SEmean = /sqrt2; SEdiff = SE1.
    const v = computeVerdict([0.55, 0.55, 0.65, 0.65], [40, 40, 40, 40]);
    if (v.state !== 'ready') throw new Error();
    expect(v.method).toBe('binomial');
    expect(v.window).toBe(2);
    expect(v.seDiff).toBeCloseTo(Math.sqrt(0.24 / 40), 6);
    expect(v.delta).toBeCloseTo(0.1);
    expect(v.confidence).toBe('Medium'); // z = 1.29
    expect(v.direction).toBe('Rising');
  });
  it('within noise is labelled as such', () => {
    const v = computeVerdict([0.6, 0.6, 0.62, 0.62], [40, 40, 40, 40]);
    if (v.state !== 'ready') throw new Error();
    expect(v.confidence).toBe('Low');
    expect(v.label).toMatch(/within noise/);
  });
  it('high confidence for a large consistent rise (empirical noise)', () => {
    const v = computeVerdict([0.4, 0.42, 0.41, 0.6, 0.62, 0.61], [40, 40, 40, 40, 40, 40]);
    if (v.state !== 'ready') throw new Error();
    expect(v.method).toBe('empirical');
    expect(v.confidence).toBe('High');
    expect(v.label).toBe('Rising');
  });
  it('flat when nothing changes', () => {
    const v = computeVerdict([0.7, 0.7, 0.7, 0.7, 0.7, 0.7], Array(6).fill(40));
    if (v.state !== 'ready') throw new Error();
    expect(v.direction).toBe('Flat');
  });
  it('projection is damped and bounded', () => {
    const day = 86_400_000;
    const pts = Array.from({ length: 8 }, (_, i) => ({ at: i * day, score: 0.5 + i * 0.02 }));
    const p = projectScore(pts, 7 * day + 100 * day, 0.05)!;
    // Horizon capped at 21 days, halved: 0.02 * 10.5 = 0.21 above level.
    expect(p.value).toBeLessThanOrEqual(1);
    expect(p.lo).toBeLessThanOrEqual(p.value);
    expect(p.hi).toBeGreaterThanOrEqual(p.value);
    expect(projectScore(pts.slice(0, 4), 10 * day, 0.05)).toBeNull();
  });
});

describe('rushed-error alert', () => {
  // Baseline: 90 s/question, 30/40.
  const base = () => Array.from({ length: 6 }, () => S({ timeMs: 40 * 90_000, correct: 30 }));
  const items = (n: number, wrongFast: number) =>
    Array.from({ length: n }, (_, i) => ({ qid: `q${i}`, index: i, correct: i >= wrongFast, timeMs: i < wrongFast ? 20_000 : 60_000 }));

  it('triggers when faster and worse by at least ceil(7% of N)', () => {
    // t = 60 s (<= 0.9 * 90), s_t = max(0, 9) = 9, z = -3.3; drop = 30 - 27 = 3 >= ceil(2.8) = 3.
    const cur = S({ timeMs: 40 * 60_000, correct: 27, endedAt: 1e12 });
    const r = detectRushed({ current: cur, items: items(40, 3), history: base() });
    expect(r.needed).toBe(3);
    expect(r.triggered).toBe(true);
    expect(r.rushedErrors).toHaveLength(3);
    expect(r.secLessPerQ).toBeCloseTo(30);
    expect(r.minLessOnPaper).toBeCloseTo(20);
  });
  it('does not trigger when the drop is one question short', () => {
    const cur = S({ timeMs: 40 * 60_000, correct: 28, endedAt: 1e12 });
    expect(detectRushed({ current: cur, items: [], history: base() }).triggered).toBe(false);
  });
  it('boundary: t exactly 0.9 m_t and z exactly -1 triggers', () => {
    // m_t = 90, s_t = 9 (MAD 0), t = 81 -> z = -1, t = 0.9 m_t.
    const cur = S({ timeMs: 40 * 81_000, correct: 27, endedAt: 1e12 });
    expect(detectRushed({ current: cur, items: [], history: base() }).triggered).toBe(true);
  });
  it('boundary: slightly slower than 0.9 m_t does not trigger', () => {
    const cur = S({ timeMs: 40 * 81_500, correct: 20, endedAt: 1e12 });
    expect(detectRushed({ current: cur, items: [], history: base() }).triggered).toBe(false);
  });
  it('needs at least 4 baseline sessions and excludes partial/practice/drills', () => {
    const hist = [S(), S(), S(), S({ partial: true }), S({ mode: 'practice' }), S({ type: 'drill' })];
    const cur = S({ timeMs: 40 * 30_000, correct: 10, endedAt: 1e12 });
    const r = detectRushed({ current: cur, items: [], history: hist });
    expect(r.baselineCount).toBe(3);
    expect(r.triggered).toBe(false);
  });
  it('uses only the last 8 sessions, robust to outliers', () => {
    const hist = [...Array.from({ length: 5 }, () => S({ timeMs: 40 * 10_000 })), ...base(), S({ timeMs: 40 * 900_000 }), S()];
    const cur = S({ timeMs: 40 * 60_000, correct: 27, endedAt: 1e12 });
    const r = detectRushed({ current: cur, items: [], history: hist });
    expect(r.baselineCount).toBe(8);
    expect(r.medianT).toBe(90);
    expect(r.triggered).toBe(true);
  });
  it('never triggers on a partial session', () => {
    const cur = S({ timeMs: 20 * 30_000, answered: 20, correct: 5, partial: true, endedAt: 1e12 });
    expect(detectRushed({ current: cur, items: [], history: base() }).triggered).toBe(false);
  });
});

describe('KPIs', () => {
  it('paper score compares windows 10,9,8 against 9,8,7', () => {
    const scores = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28];
    const list = scores.map((c) => S({ correct: c }));
    const k = scoreKpi(list);
    expect(k.value).toBeCloseTo((24 + 26 + 28) / 120);
    expect(k.delta).toBeCloseTo((28 - 22) / 3 / 40);
    expect(k.good).toBe(true);
  });
  it('em dash state below 3 sessions', () => {
    expect(scoreKpi([S(), S()]).value).toBeNull();
  });
  it('falling pace is good', () => {
    const list = [100, 100, 100, 70].map((sec) => S({ timeMs: 40 * sec * 1000 }));
    const k = paceKpi(list, 112);
    expect(k.delta).toBeLessThan(0);
    expect(k.good).toBe(true);
    expect(k.context).toBe('budget 1:52');
  });
  it('sessions done counts last 30 days vs previous', () => {
    const now = 100 * 86_400_000;
    const list = [S({ endedAt: now - 1000 }), S({ endedAt: now - 2000 }), S({ endedAt: now - 40 * 86_400_000, paperId: 'x' })];
    const k = sessionsKpi(list, [{ id: 'x' } as never, { id: 'y' } as never], now);
    expect(k.value).toBe(3);
    expect(k.delta).toBe(1);
    expect(k.context).toBe('1 of 2 papers done');
  });
  it('shrinking mistakes bank is good', () => {
    const now = 30 * 86_400_000;
    const k = bankKpi(2, [{ packId: 'p', qid: 'a', at: now - 1000, kind: 'out' }], now);
    expect(k.delta).toBe(-1);
    expect(k.good).toBe(true);
    expect(k.context).toBe('cleared 1 this week');
  });
});
