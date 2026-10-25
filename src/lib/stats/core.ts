import type { SessionSummary } from '../types';

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Median absolute deviation (unscaled). */
export function mad(xs: number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Sample standard deviation (n - 1). */
export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/** Ordinary least squares fit y = a + b x. Returns slope, intercept, residual SD and slope SE. */
export function ols(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    sxx += dx * dx;
    sxy += dx * ((ys[i] as number) - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let rss = 0;
  for (let i = 0; i < n; i++) rss += ((ys[i] as number) - (intercept + slope * (xs[i] as number))) ** 2;
  const residSd = n > 2 ? Math.sqrt(rss / (n - 2)) : NaN;
  const slopeSe = n > 2 && sxx > 0 ? residSd / Math.sqrt(sxx) : NaN;
  return { slope, intercept, residSd, slopeSe };
}

/** Mean with the single highest and lowest dropped when there are 5 or more values. */
export function trimmedMean(xs: number[]): number {
  if (xs.length < 5) return mean(xs);
  const s = xs.slice().sort((a, b) => a - b);
  return mean(s.slice(1, -1));
}

export const isComplete = (s: SessionSummary) =>
  (s.status === 'submitted' || s.status === 'auto-submitted') && !s.partial && s.answered > 0;

export const isFinished = (s: SessionSummary) => s.status === 'submitted' || s.status === 'auto-submitted';

export const paperScore = (s: SessionSummary) => (s.total ? s.correct / s.total : 0);
export const accuracy = (s: SessionSummary) => (s.answered ? s.correct / s.answered : 0);
export const secPerQ = (s: SessionSummary) => (s.answered ? s.timeMs / 1000 / s.answered : 0);

export interface QualifyOpts {
  includePractice?: boolean;
  includePartial?: boolean;
}

/** Qualifying sessions for trend, verdict and KPIs: finished paper or random, Exam mode by default. */
export function qualifying(sessions: SessionSummary[], o: QualifyOpts = {}): SessionSummary[] {
  return sessions
    .filter(
      (s) =>
        isFinished(s) &&
        (o.includePartial || !s.partial) &&
        (s.type === 'paper' || s.type === 'random') &&
        (o.includePractice || s.mode === 'exam') &&
        s.answered > 0,
    )
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
}

/** Rolling mean of three: for each index i >= 2, the mean of values i-2..i. */
export function rolling3(values: number[]): { index: number; value: number }[] {
  const out: { index: number; value: number }[] = [];
  for (let i = 2; i < values.length; i++)
    out.push({ index: i, value: ((values[i] as number) + (values[i - 1] as number) + (values[i - 2] as number)) / 3 });
  return out;
}
