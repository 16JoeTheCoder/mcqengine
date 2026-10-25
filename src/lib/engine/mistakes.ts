import type { QuestionStat } from '../types';

export const statKey = (packId: string, qid: string) => `${packId}::${qid}`;

export function emptyStat(packId: string, qid: string): QuestionStat {
  return {
    key: statKey(packId, qid),
    packId,
    qid,
    timesSeen: 0,
    attempts: 0,
    missed: 0,
    streak: 0,
    inBank: false,
    timeSum: 0,
  };
}

/** Consecutive correct, sure answers needed to leave the mistakes bank. */
export const CLEAR_STREAK = 2;

/**
 * Applies one graded answer to a question's stats.
 * Wrong, or correct but Unsure ("shaky"), puts the question in the bank and resets the streak.
 * Correct and sure extends the streak; a banked question leaves after CLEAR_STREAK in a row.
 * `countSeen` is false for drills, which never touch random's seen counts.
 */
export function applyAnswer(
  prev: QuestionStat,
  a: { correct: boolean; unsure: boolean; timeMs: number; at: number; countSeen: boolean },
): { stat: QuestionStat; event: 'in' | 'out' | null } {
  const s: QuestionStat = { ...prev };
  s.attempts += 1;
  if (a.countSeen) s.timesSeen += 1;
  s.timeSum += Math.max(0, a.timeMs);
  s.lastAnsweredAt = a.at;
  s.lastResult = a.correct ? 'correct' : 'wrong';
  s.lastUnsure = a.unsure;
  let event: 'in' | 'out' | null = null;
  if (!a.correct || a.unsure) {
    if (!a.correct) {
      s.missed += 1;
      s.lastWrongAt = a.at;
    }
    s.streak = 0;
    if (!s.inBank) {
      event = 'in';
      s.stage = 0;
    } else s.stage = a.correct ? (s.stage ?? 0) + 1 : 0;
    s.inBank = true;
  } else {
    s.streak += 1;
    if (s.inBank) s.stage = (s.stage ?? 0) + 1;
    if (s.inBank && s.streak >= CLEAR_STREAK) {
      s.inBank = false;
      delete s.stage;
      event = 'out';
    }
  }
  return { stat: s, event };
}

/** Drill selection: most-missed first, then most recently wrong, up to `size`. */
export function selectDrill(stats: QuestionStat[], size: number, eligible: ReadonlySet<string>): string[] {
  return stats
    .filter((s) => s.inBank && eligible.has(s.qid))
    .sort(
      (a, b) =>
        b.missed - a.missed ||
        (b.lastWrongAt ?? b.lastAnsweredAt ?? 0) - (a.lastWrongAt ?? a.lastAnsweredAt ?? 0) ||
        a.qid.localeCompare(b.qid),
    )
    .slice(0, Math.max(0, size))
    .map((s) => s.qid);
}

/** Drill time budget: average seconds per question across the pack, clamped to 30-180 s. */
export function drillBudgetMs(avgSecPerQ: number, questions: number): number {
  const sec = Math.min(180, Math.max(30, Number.isFinite(avgSecPerQ) ? avgSecPerQ : 90));
  return Math.round(sec * questions) * 1000;
}

/** Bank size at time `at`, by replaying in/out events (current size is authoritative). */
export function bankSizeAt(currentSize: number, events: { at: number; kind: 'in' | 'out' }[], at: number): number {
  let size = currentSize;
  for (const e of events) if (e.at > at) size += e.kind === 'in' ? -1 : 1;
  return Math.max(0, size);
}

// ---------- Daily 10 ----------

/** Days after the last answer before a banked question is due again, by schedule stage. */
export const DAILY_INTERVALS = [1, 3, 7, 14];
export const DAILY_MS = 10 * 60_000;
export const DAILY_MIN = 3;
export const DAILY_MAX = 20;

/** Whole local calendar days from a to b (so 23:50 to 00:10 is one day). */
export function dayDiff(a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / 86_400_000);
}

/** Days overdue (0 = due today, negative = not due yet). */
export function overdueDays(s: QuestionStat, now: number): number {
  const interval = DAILY_INTERVALS[Math.min(DAILY_INTERVALS.length - 1, Math.max(0, s.stage ?? 0))] as number;
  return dayDiff(s.lastAnsweredAt ?? 0, now) - interval;
}

/** Banked, viewable questions due today: most overdue first, then most missed. */
export function dueForDaily(stats: QuestionStat[], now: number, viewable: ReadonlySet<string>): string[] {
  return stats
    .filter((s) => s.inBank && viewable.has(s.qid) && overdueDays(s, now) >= 0)
    .sort((a, b) => overdueDays(b, now) - overdueDays(a, now) || b.missed - a.missed || a.qid.localeCompare(b.qid))
    .map((s) => s.qid);
}

/** How many questions fit in ten minutes at the student's pace, within 3 to 20. */
export function dailySize(secPerQ: number): number {
  const pace = Number.isFinite(secPerQ) && secPerQ > 0 ? secPerQ : 90;
  return Math.min(DAILY_MAX, Math.max(DAILY_MIN, Math.floor(DAILY_MS / 1000 / pace)));
}
