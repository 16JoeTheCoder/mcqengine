import type { TimerConfig, TimerKind } from '../types';

/** Largest per-question budget (seconds) that keeps questions x seconds within the cap. */
export function perQuestionMaxSec(capMin: number, questions: number): number {
  if (questions <= 0) return 0;
  return Math.floor((capMin * 60) / questions);
}

const clampInt = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));

/**
 * Builds a timer configuration, clamping every input so the budget can never exceed the cap.
 * This is the engine-side enforcement; the UI clamps too.
 */
export function buildTimer(opts: {
  kind: TimerKind;
  capMin: number;
  questions: number;
  minutes?: number;
  perQSec?: number;
  strict?: boolean;
}): TimerConfig {
  const capMin = Math.max(1, Math.round(opts.capMin));
  const capMs = capMin * 60_000;
  if (opts.kind === 'total') {
    const minutes = clampInt(opts.minutes ?? capMin, 1, capMin);
    return { kind: 'total', capMs, totalMs: minutes * 60_000 };
  }
  if (opts.kind === 'perq') {
    const max = perQuestionMaxSec(capMin, opts.questions);
    if (max < 1) return { kind: 'none', capMs, totalMs: capMs };
    const sec = clampInt(opts.perQSec ?? max, 1, max);
    return {
      kind: 'perq',
      capMs,
      totalMs: Math.min(capMs, sec * 1000 * opts.questions),
      perQMs: sec * 1000,
      strict: !!opts.strict,
    };
  }
  return { kind: 'none', capMs, totalMs: capMs };
}

/** Re-applies the clamp to a stored config (defends against tampered or stale data). */
export function sanitizeTimer(c: TimerConfig, questions: number): TimerConfig {
  const capMs = Math.max(60_000, c.capMs);
  const totalMs = Math.min(capMs, Math.max(1000, c.totalMs));
  if (c.kind === 'perq' && c.perQMs) {
    const perQMs = Math.min(c.perQMs, Math.floor(capMs / Math.max(1, questions)));
    return { ...c, capMs, perQMs, totalMs: Math.min(totalMs, perQMs * questions) };
  }
  return { ...c, capMs, totalMs };
}

/**
 * A countdown anchored to an absolute wall-clock end timestamp.
 * Remaining time is computed from the end timestamp, never by counting intervals, so tab
 * sleep, laptop sleep and timer throttling are all charged correctly. A monotonic clock is
 * used only to detect the wall clock being set backwards; remaining time never increases.
 */
export class Countdown {
  endAt: number;
  private lastWall: number;
  private lastMono: number;
  private lastRemaining: number;

  constructor(remainingMs: number, wall: number, mono: number) {
    this.lastRemaining = Math.max(0, remainingMs);
    this.endAt = wall + this.lastRemaining;
    this.lastWall = wall;
    this.lastMono = mono;
  }

  remaining(wall: number, mono: number): number {
    const dWall = wall - this.lastWall;
    const dMono = Math.max(0, mono - this.lastMono);
    if (dWall < -1000) {
      // Wall clock moved backwards: re-anchor using the monotonic elapsed time.
      this.endAt = wall + Math.max(0, this.lastRemaining - dMono);
    }
    const r = Math.max(0, Math.min(this.endAt - wall, this.lastRemaining));
    this.lastRemaining = r;
    this.lastWall = wall;
    this.lastMono = mono;
    return r;
  }
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Live-region thresholds as fractions of the budget, plus the one-minute mark. */
export function crossedThreshold(prevMs: number, nowMs: number, totalMs: number): string | null {
  const marks: [number, string][] = [
    [totalMs * 0.5, 'Half of your time remains.'],
    [totalMs * 0.25, 'A quarter of your time remains.'],
    [totalMs * 0.1, 'Ten percent of your time remains.'],
    [60_000, 'One minute remains.'],
  ];
  let msg: string | null = null;
  for (const [t, m] of marks) if (prevMs > t && nowMs <= t && t > 0) msg = m;
  return msg;
}
