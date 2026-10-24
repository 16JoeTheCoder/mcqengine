// Domain types shared by storage, engine, stats and UI.

export type Letter = 'A' | 'B' | 'C' | 'D' | 'E';
export const LETTERS: Letter[] = ['A', 'B', 'C', 'D', 'E'];

/** A figure: sanitised inline SVG, an image stored in the images store, or a placeholder. */
export type Figure =
  | { kind: 'svg'; svg: string; alt?: string }
  | { kind: 'image'; imageId: string; alt?: string }
  | { kind: 'needed'; note?: string };

export interface OptionContent {
  text?: string;
  figure?: Figure;
}

export interface OptionsTable {
  /** Column headers, one per column. */
  columns: string[];
  /** One row per option (A, B, C...), each with one cell per column. */
  rows: string[][];
}

export interface Question {
  /** Stable id: `${paperId}#${n}`. */
  id: string;
  n: number;
  stem?: string;
  /** Whole-question screenshot (image id). When present, options may be letters only. */
  image?: string;
  figure?: Figure;
  options?: OptionContent[];
  table?: OptionsTable;
  optionCount: number;
  /** Index of the correct option, or null until keyed. */
  answer: number | null;
  topic?: string;
  explanation?: string;
  /** The transcriber's note about something it could not read reliably. */
  uncertain?: string;
  /** Content hash, used to detect re-imports and conflicts. */
  hash: string;
}

export interface PaperMeta {
  id: string;
  title: string;
  group: string[];
  questionCount: number;
  /** Hard maximum, minutes. No timer may exceed it. */
  timeLimitMin: number;
  optionCount: number;
  /** Number of questions present (may be below questionCount while chunks are pending). */
  present: number;
  /** Number of questions with an answer key. */
  keyed: number;
  /** Questions that still need a figure attached. */
  figuresNeeded: number;
  addedAt: number;
}

export interface Paper extends PaperMeta {
  /** `${packId}::${paperId}` */
  key: string;
  packId: string;
  questions: Question[];
  /** The latest applied answer key, kept so later chunks of the paper are keyed on arrival. */
  pendingKey?: (number | null)[];
}

export interface Pack {
  id: string;
  title: string;
  subject: string;
  createdAt: number;
  updatedAt: number;
  lastPractisedAt?: number;
  papers: PaperMeta[];
  /** ISO date (yyyy-mm-dd), optional. */
  examDate?: string;
}

export type SessionType = 'paper' | 'random' | 'drill';
export type SessionMode = 'exam' | 'practice';
export type SessionStatus = 'active' | 'saved' | 'submitted' | 'auto-submitted';

export type TimerKind = 'none' | 'total' | 'perq';
export interface TimerConfig {
  kind: TimerKind;
  /** Hard cap for the session, ms. */
  capMs: number;
  /** Session budget, ms (<= capMs). For 'none' equals capMs. */
  totalMs: number;
  /** Per-question budget, ms (perq only). */
  perQMs?: number;
  /** Strict per-question countdowns (perq only). */
  strict?: boolean;
}

/** Per-question answer record inside a session. */
export interface AnswerRecord {
  qid: string;
  choice: number | null;
  first: number | null;
  changes: number;
  timeMs: number;
  flagged: boolean;
  unsure: boolean;
  /** Practice mode: answer was checked and is locked. */
  checked: boolean;
  /** Strict mode: question timed out or was left; no going back. */
  locked: boolean;
  /** Strict mode: remaining ms on this question's own countdown. */
  qRemainingMs?: number;
}

export interface TimerState {
  config: TimerConfig;
  /** Remaining ms at the moment of the last freeze (saved) or the last persisted tick. */
  remainingMs: number;
  /** Wall-clock end timestamp while running; absent while frozen. */
  endAt?: number;
}

/** Summary aggregates computed at submit, so dashboards read only summary rows. */
export interface SessionAggregates {
  thirds: [number, number][]; // [correct, answered] for first/middle/last third
  sure: [number, number]; // [correct, answered] when not unsure
  unsureAcc: [number, number];
  changes: { helped: number; hurt: number; neutral: number };
  /** Accuracy on the slowest quarter of answered questions vs the rest: [correct, answered]. */
  slowest: [number, number];
  rest: [number, number];
  /** Time-per-question histogram counts; bin edges in TIME_BINS. */
  hist: number[];
}

export interface SessionSummary {
  id: string;
  packId: string;
  type: SessionType;
  mode: SessionMode;
  paperId?: string;
  title: string;
  status: SessionStatus;
  partial: boolean;
  startedAt: number;
  endedAt?: number;
  updatedAt: number;
  /** Full session length (number of questions). */
  total: number;
  answered: number;
  correct: number;
  /** Sum of attributed time, ms. */
  timeMs: number;
  timer?: TimerConfig;
  agg?: SessionAggregates;
}

export interface SessionDetail {
  id: string;
  packId: string;
  questionIds: string[];
  /** paperKey per question id, so the session can load content. */
  sources: Record<string, string>;
  answers: AnswerRecord[];
  current: number;
  timer?: TimerState;
  shuffled: boolean;
  /** Answer key at submit time, by position. Reviews grade against this snapshot. */
  key?: (number | null)[];
}

export interface QuestionStat {
  /** `${packId}::${qid}` */
  key: string;
  packId: string;
  qid: string;
  timesSeen: number;
  attempts: number;
  missed: number;
  streak: number;
  lastResult?: 'correct' | 'wrong';
  lastUnsure?: boolean;
  lastAnsweredAt?: number;
  lastWrongAt?: number;
  inBank: boolean;
  /** Sum of answer time, ms, and count, for the heat grid. */
  timeSum: number;
}

export interface BankEvent {
  id?: number;
  packId: string;
  qid: string;
  at: number;
  kind: 'in' | 'out';
}

export interface QuestionOverride {
  key: string; // `${packId}::${qid}`
  packId: string;
  qid: string;
  stem?: string;
  options?: string[];
  answer?: number | null;
  figure?: Figure;
  reported?: boolean;
  note?: string;
  updatedAt: number;
}

export interface ImageRecord {
  id: string; // sha-256 hex of the bytes
  type: string;
  blob: Blob;
}

export interface Settings {
  examDate?: string;
  projection: boolean;
  rushedAlert: boolean;
  backupReminder: boolean;
  backupEvery: number;
  calibration: boolean;
  smartRandom: boolean;
  shuffleDefault: boolean;
  reduceEffects: boolean;
  confirmSubmit: boolean;
  keyHints: boolean;
  includePartialInTrend: boolean;
  /** Completed-session count at the last backup or dismissal of the reminder. */
  lastBackupAtCount: number;
  lastBackupAt?: number;
  dismissedTips: string[];
  theme: 'system' | 'light' | 'dark';
}

export const DEFAULT_SETTINGS: Settings = {
  projection: true,
  rushedAlert: true,
  backupReminder: true,
  backupEvery: 10,
  calibration: true,
  smartRandom: false,
  shuffleDefault: false,
  reduceEffects: false,
  confirmSubmit: true,
  keyHints: true,
  includePartialInTrend: false,
  lastBackupAtCount: 0,
  dismissedTips: [],
  theme: 'system',
};

/** Upper edges (seconds) of the time-per-question histogram bins; the last bin is open. */
export const TIME_BINS = [15, 30, 45, 60, 90, 120, 180];
