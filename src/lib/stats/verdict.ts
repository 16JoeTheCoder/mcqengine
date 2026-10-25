import { mean, ols } from './core';

export type Confidence = 'High' | 'Medium' | 'Low';
export type Direction = 'Rising' | 'Flat' | 'Falling';

export interface Verdict {
  state: 'ready';
  direction: Direction;
  label: string;
  confidence: Confidence;
  sentence: string;
  delta: number;
  seDiff: number;
  z: number;
  window: number;
  latestMean: number;
  previousMean: number;
  slope: number;
  method: 'empirical' | 'binomial';
}

export const MIN_VERDICT_SESSIONS = 4;

const pts = (x: number) => `${Math.abs(x * 100).toFixed(1).replace(/\.0$/, '')} point${Math.abs(x * 100) === 1 ? '' : 's'}`;

/**
 * Trend verdict over chronological qualifying session scores (fractions 0-1).
 *
 * Window k = min(3, floor(n / 2)); compares the mean of the latest k sessions to the k before.
 * Noise: with 6+ sessions, the residual SD of one session around an OLS line over the last
 * (up to) 10 sessions (the empirical session-score variance, detrended so a genuine trend is
 * not mistaken for noise); otherwise the binomial SE sqrt(p(1-p)/N). SE of a k-session mean
 * is that / sqrt(k); SE of the difference of two windows is SE_mean x sqrt(2).
 * Confidence: High if |delta| >= 2 SE, Medium if >= 1 SE, else Low (within noise).
 * If the OLS slope disagrees in sign with the window delta, confidence drops one level.
 */
export function computeVerdict(
  scores: number[],
  lengths: number[],
): Verdict | { state: 'locked'; needed: number } {
  const n = scores.length;
  if (n < MIN_VERDICT_SESSIONS) return { state: 'locked', needed: MIN_VERDICT_SESSIONS - n };
  const k = Math.min(3, Math.floor(n / 2));
  const latest = scores.slice(n - k);
  const previous = scores.slice(n - 2 * k, n - k);
  const latestMean = mean(latest);
  const previousMean = mean(previous);
  const delta = latestMean - previousMean;

  const recent = scores.slice(Math.max(0, n - 10));
  const fit = ols(
    recent.map((_, i) => i),
    recent,
  );

  let sdOne: number;
  let method: 'empirical' | 'binomial';
  const N = Math.max(1, mean(lengths.slice(n - 2 * k)));
  if (n >= 6 && Number.isFinite(fit.residSd)) {
    sdOne = fit.residSd;
    method = 'empirical';
  } else {
    const p = Math.min(1 - 1 / N, Math.max(1 / N, mean([...latest, ...previous])));
    sdOne = Math.sqrt((p * (1 - p)) / N);
    method = 'binomial';
  }
  // A perfectly consistent record still has at least one question's worth of noise.
  sdOne = Math.max(sdOne, 0.5 / N);
  const seMean = sdOne / Math.sqrt(k);
  const seDiff = seMean * Math.SQRT2;
  const z = Math.abs(delta) / seDiff;

  let confidence: Confidence = z >= 2 ? 'High' : z >= 1 ? 'Medium' : 'Low';
  const disagrees = delta !== 0 && fit.slope !== 0 && Math.sign(fit.slope) !== Math.sign(delta);
  if (disagrees) confidence = confidence === 'High' ? 'Medium' : 'Low';

  const up = delta > 0;
  let direction: Direction;
  let label: string;
  if (confidence === 'Low' && disagrees && z >= 1) {
    direction = up ? 'Rising' : 'Falling';
    label = `Mixed signals, possibly ${up ? 'rising' : 'falling'}`;
  } else if (confidence === 'Low') {
    if (z < 0.5) {
      direction = 'Flat';
      label = 'Flat, within noise';
    } else {
      direction = up ? 'Rising' : 'Falling';
      label = `Possibly ${up ? 'rising' : 'falling'}, within noise`;
    }
  } else {
    direction = up ? 'Rising' : 'Falling';
    label = direction;
  }

  const lead = `Your last ${k} sessions average ${(latestMean * 100).toFixed(0)}%, ${
    delta === 0 ? 'level with' : `${up ? 'up' : 'down'} ${pts(delta)} on`
  } the ${k} before.`;
  const noise = `Typical noise for that comparison is about ±${pts(seDiff)}`;
  let tail: string;
  if (confidence === 'Low')
    tail = `${noise}, so this could easily be chance. Keep going; more sessions will make it clearer.`;
  else tail = `${noise}, so this change is ${confidence === 'High' ? 'very likely' : 'probably'} real.`;
  if (disagrees) tail += ' Your longer-run slope points the other way, which lowers confidence.';

  return {
    state: 'ready',
    direction,
    label,
    confidence,
    sentence: `${lead} ${tail}`,
    delta,
    seDiff,
    z,
    window: k,
    latestMean,
    previousMean,
    slope: fit.slope,
    method,
  };
}

/**
 * Indicative projection to an exam date. Starts from the latest 3-session mean and adds a
 * damped trend: the OLS slope per day over the last (up to) 10 sessions, halved and applied to
 * at most 21 days. The 80% interval combines the level's noise and the slope's uncertainty.
 */
export function projectScore(
  points: { at: number; score: number }[],
  examAt: number,
  noiseSd: number,
): { value: number; lo: number; hi: number; days: number } | null {
  if (points.length < 5) return null;
  const recent = points.slice(-10);
  const t0 = recent[0]?.at ?? 0;
  const days = Math.max(0, (examAt - (recent[recent.length - 1]?.at ?? 0)) / 86_400_000);
  const fit = ols(
    recent.map((p) => (p.at - t0) / 86_400_000),
    recent.map((p) => p.score),
  );
  const level = mean(recent.slice(-3).map((p) => p.score));
  const h = Math.min(days, 21) * 0.5;
  const value = level + fit.slope * h;
  const slopeSe = Number.isFinite(fit.slopeSe) ? fit.slopeSe : 0;
  const se = Math.sqrt((noiseSd / Math.sqrt(3)) ** 2 + (slopeSe * h) ** 2);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return { value: clamp(value), lo: clamp(value - 1.28 * se), hi: clamp(value + 1.28 * se), days };
}
