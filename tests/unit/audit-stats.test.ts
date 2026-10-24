// Audit (logic round 1): verdict, rushed-error and KPI maths re-derived independently from the
// specification and compared with the implementation at the boundaries.
import { describe, expect, it } from 'vitest';
import { computeVerdict } from '../../src/lib/stats/verdict';
import { detectRushed } from '../../src/lib/stats/rushed';
import { bankKpi, papersDone, paceKpi, scoreKpi, sessionsKpi } from '../../src/lib/stats/kpi';
import { qualifying, rolling3 } from '../../src/lib/stats/core';
import type { SessionSummary } from '../../src/lib/types';

const DAY = 86_400_000;
let seq = 0;
function sess(p: Partial<SessionSummary> = {}): SessionSummary {
  const i = ++seq;
  return {
    id: `s${i}`, packId: 'pk', type: 'paper', mode: 'exam', paperId: 'p1', title: 't', status: 'submitted', partial: false,
    startedAt: i * 1000, endedAt: i * 1000 + 500, updatedAt: i * 1000, total: 40, answered: 40, correct: 20, timeMs: 40 * 60_000, ...p,
  };
}

// ---------- independent spec references ----------
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleSd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const conf = (delta: number, se: number) => (Math.abs(delta) >= 2 * se ? 'High' : Math.abs(delta) >= se ? 'Medium' : 'Low');

describe('verdict: binomial path (4-5 sessions)', () => {
  it('matches SE_diff = sqrt(p(1-p)/N)/sqrt(k)*sqrt(2) with k = 2 at n = 4', () => {
    const scores = [0.5, 0.5, 0.6, 0.6];
    const v = computeVerdict(scores, [40, 40, 40, 40]);
    if (v.state !== 'ready') throw new Error('locked');
    const p = 0.55;
    const se = (Math.sqrt((p * (1 - p)) / 40) / Math.sqrt(2)) * Math.SQRT2;
    expect(v.window).toBe(2);
    expect(v.seDiff).toBeCloseTo(se, 12);
    expect(v.confidence).toBe(conf(0.1, se)); // Medium
    expect(v.method).toBe('binomial');
  });

  it('SPEC DIFF: the spec SE of a 3-session mean gives Low here, the code (2 vs 2) gives Medium', () => {
    // Spec reading: latest 3-session window vs previous window, SE_mean = SE_one / sqrt(3).
    // With only 4 sessions the two 3-windows overlap (4,3,2 vs 3,2,1), as in the KPI example.
    const scores = [0.5, 0.5, 0.6, 0.6];
    const delta = mean(scores.slice(1)) - mean(scores.slice(0, 3));
    const p = mean(scores);
    const se = (Math.sqrt((p * (1 - p)) / 40) / Math.sqrt(3)) * Math.SQRT2;
    expect(conf(delta, se)).toBe('Low');
    const v = computeVerdict(scores, [40, 40, 40, 40]);
    expect(v.state === 'ready' && v.confidence).toBe('Medium');
  });

  it('locks below 4 sessions', () => {
    expect(computeVerdict([0.5, 0.6, 0.7], [40, 40, 40])).toEqual({ state: 'locked', needed: 1 });
  });

  it('confidence boundaries are inclusive at exactly 1 SE and 2 SE (binomial)', () => {
    // Construct delta = exactly z * SE by solving for the latest window.
    for (const z of [1, 2]) {
      const N = 40;
      const prev = 0.5;
      // p depends on the latest mean; iterate to a fixed point.
      let latest = 0.6;
      for (let i = 0; i < 100; i++) {
        const p = (prev + latest) / 2;
        const se = Math.sqrt((p * (1 - p)) / N);
        latest = prev + z * se + 1e-12;
      }
      const v = computeVerdict([prev, prev, latest, latest], [N, N, N, N]);
      expect(v.state === 'ready' && v.confidence).toBe(z === 2 ? 'High' : 'Medium');
    }
  });
});

describe('verdict: empirical path (6+ sessions)', () => {
  it('SPEC DIFF: detrended residual SD (decision 45) upgrades a steady climb from Medium to High', () => {
    const scores = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75];
    const delta = mean(scores.slice(3)) - mean(scores.slice(0, 3));
    const seSpec = (sampleSd(scores) / Math.sqrt(3)) * Math.SQRT2; // "empirical session-score variance"
    expect(conf(delta, seSpec)).toBe('Medium');
    const v = computeVerdict(scores, scores.map(() => 40));
    expect(v.state === 'ready' && v.method).toBe('empirical');
    expect(v.state === 'ready' && v.confidence).toBe('High');
  });

  const disagree = () => {
    // Latest window clearly above the previous one, but the slope over all sessions is negative.
    const scores = [0.9, 0.5, 0.6, 0.55, 0.65];
    const v = computeVerdict(scores, scores.map(() => 200));
    if (v.state !== 'ready') throw new Error('locked');
    return v;
  };
  it('setup: slope disagrees, 1 <= z < 2, confidence downgraded Medium -> Low (decision 46)', () => {
    const v = disagree();
    expect(v.slope).toBeLessThan(0);
    expect(v.delta).toBeGreaterThan(0);
    expect(v.z).toBeGreaterThanOrEqual(1);
    expect(v.z).toBeLessThan(2);
    expect(v.confidence).toBe('Low');
  });
  it.fails('BUG (label): that downgraded Low says "within noise" although |delta| >= 1 SE', () => {
    expect(disagree().label).not.toContain('within noise');
  });
});

describe('trend', () => {
  it('rolling3 starts at the third session and is the mean of i, i-1, i-2', () => {
    expect(rolling3([0.3, 0.6, 0.9, 0])).toEqual([{ index: 2, value: 0.6 }, { index: 3, value: 0.5 }]);
    expect(rolling3([1, 1])).toEqual([]);
  });
  it('qualifying: paper/random only, exam by default, no partial, drills never, chronological', () => {
    const a = sess({ endedAt: 3 });
    const b = sess({ endedAt: 1, type: 'random' });
    const list = [a, b, sess({ type: 'drill' }), sess({ mode: 'practice' }), sess({ partial: true }), sess({ status: 'saved' })];
    expect(qualifying(list).map((s) => s.id)).toEqual([b.id, a.id]);
    expect(qualifying(list, { includePractice: true })).toHaveLength(3);
  });
});

describe('rushed-error detector boundaries', () => {
  const base = (n: number, p: Partial<SessionSummary> = {}) =>
    Array.from({ length: n }, () => sess({ timeMs: 40 * 60_000, correct: 30, ...p })); // t = 60 s, score 30/40
  const cur = (secPerQ: number, correct: number, p: Partial<SessionSummary> = {}) =>
    sess({ timeMs: secPerQ * 40 * 1000, correct, endedAt: 10 ** 12, ...p });

  it('fires at exactly z = -1, t = 0.9 m_t and drop = ceil(0.07 N)', () => {
    // MAD = 0 -> s_t = 0.10 * 60 = 6; t_cur = 54 -> z = -1 and t = 0.9 m_t; drop needs ceil(2.8) = 3.
    const r = detectRushed({ current: cur(54, 27), items: [], history: base(4) });
    expect(r).toMatchObject({ baselineCount: 4, medianT: 60, sT: 6, needed: 3 });
    expect(r.z).toBeCloseTo(-1, 12);
    expect(r.triggered).toBe(true);
  });
  it('does not fire one step inside each boundary', () => {
    expect(detectRushed({ current: cur(54.01, 27), items: [], history: base(4) }).triggered).toBe(false);
    expect(detectRushed({ current: cur(54, 28), items: [], history: base(4) }).triggered).toBe(false);
  });
  it('needs 4 baseline sessions; uses only the latest 8; excludes partial, practice, drills, other packs, current', () => {
    const noise = [sess({ partial: true }), sess({ mode: 'practice' }), sess({ type: 'drill' }), sess({ packId: 'other' })];
    expect(detectRushed({ current: cur(30, 10), items: [], history: [...base(3), ...noise] }).reason).toBe('baseline');
    const old = base(5, { timeMs: 40 * 10_000 }); // fast old sessions, t = 10 s
    const recent = base(8);
    const c = cur(30, 10);
    const r = detectRushed({ current: c, items: [], history: [...old, ...recent, c] });
    expect(r.baselineCount).toBe(8);
    expect(r.medianT).toBe(60);
  });
  it('ceil(0.07 N) is exact for N where 0.07 N is an integer in decimal (N = 100 -> 7, not 8)', () => {
    const h = base(4, { total: 100, answered: 100, correct: 80, timeMs: 100 * 60_000 });
    const r = detectRushed({ current: cur(30, 73, { total: 100, answered: 100, timeMs: 100 * 30_000 }), items: [], history: h });
    expect(r.needed).toBe(7);
    expect(r.triggered).toBe(true);
  });
  it('MAD branch: s_t = 1.4826 MAD when it exceeds 10% of the median', () => {
    const ts = [40, 50, 60, 70, 80];
    const h = ts.map((t) => sess({ timeMs: t * 40_000, correct: 30 }));
    const r = detectRushed({ current: cur(30, 20), items: [], history: h });
    expect(r.medianT).toBe(60);
    expect(r.sT).toBeCloseTo(1.4826 * 10, 10);
    expect(r.trimmedMeanT).toBe(60);
  });
  it('rushed errors are wrong answers under half the median per-question time', () => {
    const items = [
      { qid: 'a', index: 0, correct: false, timeMs: 29_999 },
      { qid: 'b', index: 1, correct: false, timeMs: 30_000 },
      { qid: 'c', index: 2, correct: true, timeMs: 1000 },
    ];
    const r = detectRushed({ current: cur(54, 27), items, history: base(4) });
    expect(r.rushedErrors.map((e) => e.qid)).toEqual(['a']);
  });
});

describe('KPIs', () => {
  it('paper score: last-3 mean, delta vs the window one step earlier (10,9,8 vs 9,8,7)', () => {
    const list = Array.from({ length: 10 }, (_, i) => sess({ correct: (i + 1) * 4 })); // scores 0.1..1.0
    const k = scoreKpi(list);
    expect(k.value).toBeCloseTo(0.9, 12);
    expect(k.delta).toBeCloseTo(0.9 - 0.8, 12);
    expect(scoreKpi(list.slice(0, 3)).delta).toBeNull();
    expect(scoreKpi(list.slice(0, 2)).value).toBeNull();
  });
  it('pace: avg seconds per answered question; lower is good', () => {
    const list = [60, 60, 60, 30].map((s) => sess({ timeMs: s * 40_000 }));
    const k = paceKpi(list, 90);
    expect(k.value).toBe(50);
    expect(k.delta).toBe(-10);
    expect(k.good).toBe(true);
  });
  it('sessions: completed count; delta last 30 days vs the 30 before', () => {
    const now = 100 * DAY;
    const list = [sess({ endedAt: now - DAY }), sess({ endedAt: now - 31 * DAY }), sess({ endedAt: now - 32 * DAY }), sess({ status: 'saved', endedAt: now })];
    const k = sessionsKpi(list, [], now);
    expect(k.value).toBe(3);
    expect(k.delta).toBe(-1);
  });
  it('bank: delta vs a week ago and cleared this week', () => {
    const now = 100 * DAY;
    const ev = [
      { packId: 'pk', qid: 'a', at: now - 10 * DAY, kind: 'in' as const },
      { packId: 'pk', qid: 'b', at: now - 2 * DAY, kind: 'in' as const },
      { packId: 'pk', qid: 'a', at: now - DAY, kind: 'out' as const },
      { packId: 'pk', qid: 'c', at: now - DAY, kind: 'in' as const },
    ];
    const k = bankKpi(2, ev, now);
    expect(k.delta).toBe(1);
    expect(k.context).toBe('cleared 1 this week');
  });

  it.fails('BUG: a paper auto-submitted with zero answers counts as "done"', () => {
    const s = sess({ status: 'auto-submitted', answered: 0, correct: 0, paperId: 'p9' });
    expect(papersDone([s]).has('p9')).toBe(false);
  });
});
