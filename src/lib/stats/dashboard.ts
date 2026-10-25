import type { BankEvent, Pack, QuestionStat, SessionSummary } from '../types';
import { TIME_BINS } from '../types';
import { accuracy, isComplete, mean, ols, paperScore, qualifying, rolling3, secPerQ, type QualifyOpts } from './core';
import { bankKpi, packBudgetSec, paceKpi, papersDone, scoreKpi, sessionsKpi } from './kpi';
import { computeVerdict, projectScore } from './verdict';
import { bankSizeAt } from '../engine/mistakes';

export type Metric = 'score' | 'pace' | 'accuracy';
export type Range = 'all' | '30d' | '10';

export interface Filters {
  includePractice: boolean;
  includePartial: boolean;
  range: Range;
  group: string; // paper group prefix joined by " > ", or ''
}

const DAY = 86_400_000;
export const metricValue = (m: Metric, s: SessionSummary) => (m === 'score' ? paperScore(s) : m === 'pace' ? secPerQ(s) : accuracy(s));

export function filterSessions(pack: Pack, sessions: SessionSummary[], f: Filters, now: number): SessionSummary[] {
  const groupOf = new Map(pack.papers.map((p) => [p.id, p.group.join(' > ')] as const));
  let q = qualifying(sessions, { includePractice: f.includePractice, includePartial: f.includePartial });
  if (f.group) q = q.filter((s) => s.type === 'paper' && (groupOf.get(s.paperId ?? '') ?? '').startsWith(f.group));
  if (f.range === '30d') q = q.filter((s) => (s.endedAt ?? 0) > now - 30 * DAY);
  if (f.range === '10') q = q.slice(-10);
  return q;
}

export function trend(sessions: SessionSummary[], metric: Metric) {
  const values = sessions.map((s) => metricValue(metric, s));
  const roll = rolling3(values);
  // Noise for the band: one session's SD (empirical with 6+, else binomial for proportions).
  const N = mean(sessions.map((s) => s.total)) || 40;
  let sdOne: number;
  // Same noise model as the verdict: residual scatter around the trend line with 6+ sessions.
  if (values.length >= 6) {
    const r = values.slice(-10);
    sdOne = ols(r.map((_, i) => i), r).residSd;
  }
  else if (metric === 'pace') sdOne = (mean(values) || 60) * 0.15;
  else {
    const p = Math.min(0.95, Math.max(0.05, mean(values) || 0.5));
    sdOne = Math.sqrt((p * (1 - p)) / N);
  }
  // Same floor as the verdict: never less than half a question of noise.
  if (metric !== 'pace') sdOne = Math.max(sdOne, 0.5 / N);
  const se = sdOne / Math.sqrt(3);
  return {
    raw: values.map((y, i) => ({ x: i + 1, y })),
    rolling: roll.map((r) => ({ x: r.index + 1, y: r.value })),
    band: roll.map((r) => ({ x: r.index + 1, lo: Math.max(0, r.value - se), hi: r.value + se })),
    sdOne,
  };
}

export function packAnalytics(pack: Pack, sessions: SessionSummary[], stats: QuestionStat[], events: BankEvent[], f: Filters, now: number, examDate?: string) {
  const o: QualifyOpts = { includePractice: f.includePractice, includePartial: f.includePartial };
  const q = filterSessions(pack, sessions, f, now);
  const budget = packBudgetSec(pack.papers);
  const bankSize = stats.filter((s) => s.inBank).length;
  const verdict = computeVerdict(
    q.map(paperScore),
    q.map((s) => s.total),
  );
  const keyedTotal = pack.papers.reduce((a, p) => a + p.keyed, 0);
  const seen = stats.filter((s) => s.timesSeen > 0).length;
  const done = papersDone(sessions);
  const t = trend(q, 'score');
  let projection = null;
  if (examDate) {
    const at = Date.parse(examDate);
    if (Number.isFinite(at) && at > now) projection = projectScore(q.map((s) => ({ at: s.endedAt ?? s.startedAt, score: paperScore(s) })), at, t.sdOne);
  }

  const sumPairs = (pick: (s: SessionSummary) => [number, number] | undefined) => {
    let c = 0;
    let n = 0;
    for (const s of q) {
      const p = pick(s);
      if (p) {
        c += p[0];
        n += p[1];
      }
    }
    return n ? { acc: c / n, n } : { acc: null, n: 0 };
  };
  const thirds = [0, 1, 2].map((i) => sumPairs((s) => s.agg?.thirds[i]));
  const hist = new Array<number>(TIME_BINS.length + 1).fill(0);
  for (const s of q) s.agg?.hist.forEach((v, i) => (hist[i] = (hist[i] ?? 0) + v));
  const changes = { helped: 0, hurt: 0, neutral: 0 };
  for (const s of q) if (s.agg) for (const k of ['helped', 'hurt', 'neutral'] as const) changes[k] += s.agg.changes[k];

  // Calibration and answer changes use every finished session (more data, same meaning).
  const all = sessions.filter((s) => (s.status === 'submitted' || s.status === 'auto-submitted') && s.agg);
  const cal = (k: 'sure' | 'unsureAcc') => {
    let c = 0;
    let n = 0;
    for (const s of all) {
      c += s.agg![k][0];
      n += s.agg![k][1];
    }
    return { acc: n ? c / n : null, n };
  };

  // Mistakes bank over time: one point per day with events, plus today.
  const sortedEvents = events.slice().sort((a, b) => a.at - b.at);
  const bankSeries: { x: number; y: number }[] = [];
  if (sortedEvents.length) {
    const first = Math.floor(sortedEvents[0]!.at / DAY);
    const last = Math.floor(now / DAY);
    const step = Math.max(1, Math.ceil((last - first + 1) / 60));
    for (let d = first; d <= last; d += step) bankSeries.push({ x: d - first + 1, y: bankSizeAt(bankSize, sortedEvents, (d + 1) * DAY - 1) });
  }

  const activity = new Map<string, number>();
  for (const s of sessions) if (s.endedAt && (s.status === 'submitted' || s.status === 'auto-submitted')) {
    const k = new Date(s.endedAt).toISOString().slice(0, 10);
    activity.set(k, (activity.get(k) ?? 0) + 1);
  }

  // Per-paper ladder: first, latest, best (complete paper sessions only).
  const ladder = pack.papers.map((p) => {
    const ps = sessions.filter((s) => s.type === 'paper' && s.paperId === p.id && isComplete(s)).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    const scores = ps.map(paperScore);
    return { paper: p, attempts: ps.length, first: scores[0] ?? null, latest: scores[scores.length - 1] ?? null, best: scores.length ? Math.max(...scores) : null, lastAt: ps[ps.length - 1]?.endedAt };
  });

  return {
    q,
    budget,
    kpis: {
      sessions: sessionsKpi(sessions, pack.papers, now),
      score: scoreKpi(sessions, o),
      pace: paceKpi(sessions, budget, o),
      bank: bankKpi(bankSize, events, now),
    },
    verdict,
    projection,
    coverage: { papersDone: pack.papers.filter((p) => done.has(p.id)).length, papers: pack.papers.length, unseen: keyedTotal ? Math.max(0, keyedTotal - seen) / keyedTotal : 0, keyedTotal },
    thirds,
    hist,
    changes,
    calibration: { sure: cal('sure'), unsure: cal('unsureAcc') },
    slowVsRest: { slow: sumPairs((s) => s.agg?.slowest), rest: sumPairs((s) => s.agg?.rest) },
    speedScore: q.map((s) => ({ x: secPerQ(s), y: paperScore(s) })),
    bankSize,
    bankSeries,
    activity,
    ladder,
  };
}

export type Analytics = ReturnType<typeof packAnalytics>;
