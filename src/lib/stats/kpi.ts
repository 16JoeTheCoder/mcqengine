import { bankSizeAt } from '../engine/mistakes';
import type { BankEvent, PaperMeta, SessionSummary } from '../types';
import { isComplete, mean, median, paperScore, qualifying, secPerQ, type QualifyOpts } from './core';

const DAY = 86_400_000;

export interface Kpi {
  value: number | null;
  /** Signed change; null when there is not enough data. */
  delta: number | null;
  /** True when the delta direction is an improvement (colour means good/bad, not up/down). */
  good: boolean | null;
  context: string;
}

/** Papers with at least one completed (non-partial) individual paper session. */
export function papersDone(sessions: SessionSummary[]): Set<string> {
  const done = new Set<string>();
  for (const s of sessions) if (s.type === 'paper' && isComplete(s) && s.paperId) done.add(s.paperId);
  return done;
}

export function sessionsKpi(sessions: SessionSummary[], papers: PaperMeta[], now: number): Kpi {
  const done = sessions.filter(isComplete);
  const at = (s: SessionSummary) => s.endedAt ?? s.startedAt;
  const last30 = done.filter((s) => at(s) > now - 30 * DAY).length;
  const prev30 = done.filter((s) => at(s) <= now - 30 * DAY && at(s) > now - 60 * DAY).length;
  const pd = papersDone(sessions);
  const paperCount = papers.filter((p) => pd.has(p.id)).length;
  return {
    value: done.length,
    delta: done.length ? last30 - prev30 : null,
    good: last30 === prev30 ? null : last30 > prev30,
    context: `${paperCount} of ${papers.length} papers done`,
  };
}

/**
 * Rolling window KPI: value = mean of the last 3 qualifying sessions; delta = that minus the mean
 * of the window one step earlier (sessions 10, 9, 8 against 9, 8, 7).
 */
function windowKpi(values: number[]): { value: number | null; delta: number | null } {
  const n = values.length;
  if (n < 3) return { value: null, delta: null };
  const value = mean(values.slice(n - 3));
  const delta = n >= 4 ? value - mean(values.slice(n - 4, n - 1)) : null;
  return { value, delta };
}

export function scoreKpi(sessions: SessionSummary[], o: QualifyOpts = {}): Kpi {
  const { value, delta } = windowKpi(qualifying(sessions, o).map(paperScore));
  return {
    value,
    delta,
    good: delta === null || Math.abs(delta) < 1e-9 ? null : delta > 0,
    context: 'avg of last 3',
  };
}

export function paceKpi(sessions: SessionSummary[], budgetSec: number, o: QualifyOpts = {}): Kpi {
  const { value, delta } = windowKpi(qualifying(sessions, o).map(secPerQ));
  return {
    value,
    delta,
    good: delta === null || Math.abs(delta) < 0.05 ? null : delta < 0,
    context: `budget ${fmtMinSec(budgetSec)}`,
  };
}

export function bankKpi(size: number, events: BankEvent[], now: number): Kpi {
  const weekAgo = now - 7 * DAY;
  const then = bankSizeAt(size, events, weekAgo);
  const cleared = events.filter((e) => e.kind === 'out' && e.at > weekAgo).length;
  const delta = events.length ? size - then : null;
  return {
    value: size,
    delta,
    good: delta === null || delta === 0 ? null : delta < 0,
    context: `cleared ${cleared} this week`,
  };
}

export function fmtMinSec(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Average budgeted seconds per question across a pack's papers. */
export function packBudgetSec(papers: PaperMeta[]): number {
  const valid = papers.filter((p) => p.questionCount > 0);
  if (!valid.length) return 90;
  return mean(valid.map((p) => (p.timeLimitMin * 60) / p.questionCount));
}

/** The student's typical seconds per question (median of the last 8 complete paper or random sessions). */
export function typicalPace(sessions: SessionSummary[], papers: PaperMeta[]): number {
  const recent = sessions
    .filter((s) => isComplete(s) && (s.type === 'paper' || s.type === 'random'))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 8)
    .map(secPerQ)
    .filter((x) => x > 0);
  return recent.length ? median(recent) : packBudgetSec(papers);
}
