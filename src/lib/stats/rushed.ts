import { isComplete, mad, median, paperScore, trimmedMean } from './core';
import type { SessionSummary } from '../types';

export interface RushedInput {
  current: SessionSummary;
  /** Per-question times and correctness for the current session. */
  items: { qid: string; index: number; correct: boolean; timeMs: number }[];
  history: SessionSummary[];
}

export interface RushedReport {
  triggered: boolean;
  reason?: string;
  baselineCount: number;
  tCur: number;
  medianT: number;
  sT: number;
  z: number;
  /** Seconds less per question than the median. */
  secLessPerQ: number;
  /** Minutes less on the paper than the median paper time (at the current paper length). */
  minLessOnPaper: number;
  trimmedMeanT: number;
  finishMs: number;
  dropQuestions: number;
  dropPoints: number;
  needed: number;
  rushedErrors: { qid: string; index: number; timeMs: number }[];
}

export const RUSHED_BASELINE = 8;
export const RUSHED_MIN_BASELINE = 4;

/** Baseline: the last 8 completed (non-partial) exam-mode paper/random sessions of the pack, excluding the current one. */
export function rushedBaseline(current: SessionSummary, history: SessionSummary[]): SessionSummary[] {
  return history
    .filter(
      (s) =>
        s.id !== current.id &&
        s.packId === current.packId &&
        isComplete(s) &&
        s.mode === 'exam' &&
        (s.type === 'paper' || s.type === 'random') &&
        s.answered > 0 &&
        (s.endedAt ?? 0) <= (current.endedAt ?? Infinity),
    )
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, RUSHED_BASELINE);
}

/**
 * Rushed-error detector. t = total time / questions answered (seconds).
 * m_t = median(t), s_t = max(1.4826 MAD(t), 0.10 m_t), z = (t_cur - m_t) / s_t,
 * m_a = median paper score. Triggers when z <= -1, t_cur <= 0.9 m_t and the accuracy drop is at
 * least ceil(0.07 N) questions on this paper.
 */
export function detectRushed({ current, items, history }: RushedInput): RushedReport {
  const base = rushedBaseline(current, history);
  const t = (s: SessionSummary) => s.timeMs / 1000 / s.answered;
  const ts = base.map(t);
  const N = current.total;
  const tCur = current.answered ? t(current) : 0;
  const medianT = median(ts);
  const sT = Math.max(1.4826 * mad(ts), 0.1 * medianT);
  const z = (tCur - medianT) / sT;
  const mA = median(base.map(paperScore));
  const aCur = paperScore(current);
  const dropQuestions = (mA - aCur) * N;
  const needed = Math.ceil(0.07 * N - 1e-9);
  const eps = 1e-9;
  const report: RushedReport = {
    triggered: false,
    baselineCount: base.length,
    tCur,
    medianT,
    sT,
    z,
    secLessPerQ: medianT - tCur,
    minLessOnPaper: ((medianT - tCur) * N) / 60,
    trimmedMeanT: trimmedMean(ts),
    finishMs: current.timeMs,
    dropQuestions,
    dropPoints: (mA - aCur) * 100,
    needed,
    rushedErrors: items
      .filter((i) => !i.correct && i.timeMs / 1000 < 0.5 * medianT)
      .map(({ qid, index, timeMs }) => ({ qid, index, timeMs })),
  };
  if (current.partial || current.mode !== 'exam' || current.type === 'drill')
    return { ...report, reason: 'not-qualifying' };
  if (base.length < RUSHED_MIN_BASELINE) return { ...report, reason: 'baseline' };
  if (!current.answered) return { ...report, reason: 'empty' };
  report.triggered = z <= -1 + eps && tCur <= 0.9 * medianT + eps && dropQuestions >= needed - eps;
  return report;
}
