import * as store from '../data/db';
import { applyOverride, paperComplete, paperKeyed } from '../format/merge';
import type { AnswerRecord, Pack, Paper, Question, QuestionOverride, Snip, SessionDetail, SessionMode, SessionSummary, SessionType, TimerConfig } from '../types';
import { gradeSession, type GradeResult } from './grade';
import { applyAnswer, DAILY_MS, dailySize, drillBudgetMs, dueForDaily, emptyStat, selectDrill, statKey } from './mistakes';
import { drawRandom, standardLength, type PoolItem } from './random';
import { cryptoRng, shuffle, uid } from './rng';
import { buildTimer } from './timer';
import { packBudgetSec, typicalPace } from '../stats/kpi';

export const blankAnswer = (qid: string): AnswerRecord => ({
  qid,
  choice: null,
  first: null,
  changes: 0,
  timeMs: 0,
  flagged: false,
  unsure: false,
  checked: false,
  locked: false,
});

/** Loads every paper of a pack with overrides applied. */
export async function loadPackContent(packId: string): Promise<{ papers: Paper[]; overrides: Map<string, QuestionOverride> }> {
  const [papers, ovs, snips] = await Promise.all([store.getPapers(packId), store.getOverrides(packId), store.getSnips(packId)]);
  const overrides = new Map(ovs.map((o) => [o.qid, o] as const));
  const sn = new Map(snips.map((x) => [x.qid, x] as const));
  return { papers: papers.map((p) => ({ ...p, questions: p.questions.map((q) => withRuntime(applyOverride(q, overrides.get(q.id)), p, sn.get(q.id))) })), overrides };
}

function withRuntime(q: Question, p: Paper, snip?: Snip): Question {
  const r = p.pdf?.qp ? { ...q, pdfId: p.pdf.qp } : q;
  return snip ? { ...r, snip } : r;
}

/** Random pool: keyed questions from every paper. */
export function poolOf(papers: Paper[], stats: Map<string, { timesSeen: number; lastResult?: string; lastUnsure?: boolean }>): PoolItem[] {
  const out: PoolItem[] = [];
  for (const p of papers)
    for (const q of p.questions)
      if (q.answer !== null) {
        const s = stats.get(q.id);
        out.push({ qid: q.id, timesSeen: s?.timesSeen ?? 0, lastWrong: s?.lastResult === 'wrong', lastUnsure: !!s?.lastUnsure });
      }
  return out;
}

export function packStandardLength(pack: Pack): number {
  return standardLength(pack.papers.map((p) => p.questionCount)) || 40;
}

/** Hard cap (minutes) for random and drill sessions, derived from the pack's average budget. */
export function sessionCapMin(pack: Pack, type: SessionType, questions: number): number {
  const avg = packBudgetSec(pack.papers);
  if (type === 'drill') return Math.max(1, Math.round(drillBudgetMs(avg, questions) / 60_000));
  return Math.max(1, Math.round((avg * questions) / 60));
}

export interface StartOptions {
  pack: Pack;
  type: SessionType;
  mode: SessionMode;
  paperId?: string;
  timer?: { kind: TimerConfig['kind']; minutes?: number; perQSec?: number; strict?: boolean };
  shuffle?: boolean;
  smart?: boolean;
  /** Daily 10: the student's seconds per question, used to size the session. */
  paceSec?: number;
}

/** Typed content, a whole-question image or a snip: the question can be shown on its own. */
export const isViewable = (q: Question) => !!(q.stem || q.image || q.options?.length || q.table || q.snip);

/** Questions a student can see on their own: typed content or a whole-question image. */
export function viewableIds(papers: Paper[]): string[] {
  const out: string[] = [];
  for (const p of papers) for (const q of p.questions) if (q.answer !== null && isViewable(q)) out.push(q.id);
  return out;
}

/** Ids locked by the pack's in-progress or saved sessions (never drawn by another session). */
async function lockedIds(packId: string): Promise<Set<string>> {
  const open = (await store.getOpenSessions()).filter((s) => s.packId === packId);
  const ids = new Set<string>();
  for (const s of open) (await store.getDetail(s.id))?.questionIds.forEach((q) => ids.add(q));
  return ids;
}

export class OpenSessionError extends Error {}

export async function createSession(o: StartOptions, now = Date.now()): Promise<{ summary: SessionSummary; detail: SessionDetail }> {
  // One open (active or saved) session per pack, enforced in the engine, not only the UI.
  if ((await store.getOpenSessions()).some((s) => s.packId === o.pack.id))
    throw new OpenSessionError('This pack has a saved session. Resume, submit or discard it first.');
  // Daily 10 always gives instant feedback; it is a review, not a mock exam.
  if (o.type === 'daily') o = { ...o, mode: 'practice' };
  const { papers } = await loadPackContent(o.pack.id);
  const byQ = new Map<string, Paper>();
  for (const p of papers) for (const q of p.questions) byQ.set(q.id, p);
  let ids: string[] = [];
  let title = '';
  let capMin: number;

  if (o.type === 'paper') {
    const paper = papers.find((p) => p.id === o.paperId);
    if (!paper) throw new Error('Paper not found');
    const meta = o.pack.papers.find((m) => m.id === paper.id);
    if (meta && !paperComplete(meta)) throw new Error('This paper is not complete yet');
    if (meta && o.mode === 'practice' && !paperKeyed(meta)) throw new Error('Practice mode needs the answer key. Use Exam mode, or add the key first.');
    ids = paper.questions.map((q) => q.id);
    if (o.shuffle) ids = shuffle(ids, cryptoRng);
    title = paper.title;
    capMin = paper.timeLimitMin;
  } else {
    const stats = new Map((await store.getStats(o.pack.id)).map((s) => [s.qid, s] as const));
    const size = packStandardLength(o.pack);
    const locked = await lockedIds(o.pack.id);
    if (o.type === 'random') {
      ids = drawRandom(poolOf(papers, stats), size, locked, cryptoRng, o.smart);
      title = 'Random session';
    } else if (o.type === 'daily') {
      const viewable = new Set(viewableIds(papers).filter((q) => !locked.has(q)));
      ids = dueForDaily([...stats.values()], now, viewable).slice(0, dailySize(o.paceSec ?? typicalPace(await store.getSessions(o.pack.id), o.pack.papers)));
      title = 'Daily 10';
    } else {
      const eligible = new Set(poolOf(papers, new Map()).map((p) => p.qid).filter((q) => !locked.has(q)));
      ids = selectDrill([...stats.values()], size, new Set(viewableIds(papers).filter((q) => eligible.has(q))));
      title = 'Mistakes drill';
    }
    capMin = o.type === 'daily' ? DAILY_MS / 60_000 : sessionCapMin(o.pack, o.type, ids.length);
  }
  if (!ids.length) throw new Error(o.type === 'daily' ? 'Nothing is due today' : 'No questions available for this session');

  let timer: TimerConfig | undefined;
  if (o.type === 'daily') timer = { kind: 'total', capMs: DAILY_MS, totalMs: DAILY_MS };
  else if (o.mode === 'exam') {
    timer = buildTimer({ kind: o.timer?.kind ?? 'none', capMin, questions: ids.length, minutes: o.timer?.minutes, perQSec: o.timer?.perQSec, strict: o.timer?.strict });
    if (o.type === 'drill' && timer.kind === 'none') timer = { kind: 'total', capMs: timer.capMs, totalMs: timer.capMs };
  }
  const id = uid('s_');
  const summary: SessionSummary = {
    id,
    packId: o.pack.id,
    type: o.type,
    mode: o.mode,
    ...(o.paperId ? { paperId: o.paperId } : {}),
    title,
    status: 'active',
    partial: false,
    startedAt: now,
    updatedAt: now,
    total: ids.length,
    answered: 0,
    correct: 0,
    timeMs: 0,
    ...(timer ? { timer } : {}),
  };
  const sources: Record<string, string> = {};
  for (const q of ids) sources[q] = byQ.get(q)?.key ?? '';
  const answers = ids.map(blankAnswer);
  if (timer?.kind === 'perq' && timer.strict) answers.forEach((a) => (a.qRemainingMs = timer.perQMs));
  const detail: SessionDetail = {
    id,
    packId: o.pack.id,
    questionIds: ids,
    sources,
    answers,
    current: 0,
    shuffled: !!o.shuffle || o.type !== 'paper',
    ...(timer ? { timer: { config: timer, remainingMs: timer.totalMs } } : {}),
  };
  if (!(await store.createOpenSession(summary, detail)))
    throw new OpenSessionError('This pack has a saved session. Resume, submit or discard it first.');
  return { summary, detail };
}

/** Drills and Daily 10 never touch random's seen counts. */
export const countsSeen = (t: SessionType) => t === 'paper' || t === 'random';

/** Questions for a session, with overrides applied, keyed by id. */
export async function loadSessionQuestions(detail: SessionDetail): Promise<Map<string, Question>> {
  const keys = [...new Set(Object.values(detail.sources))];
  const [papers, ovs, snips] = await Promise.all([Promise.all(keys.map((k) => store.getPaper(k))), store.getOverrides(detail.packId), store.getSnips(detail.packId)]);
  const overrides = new Map(ovs.map((o) => [o.qid, o] as const));
  const sn = new Map(snips.map((x) => [x.qid, x] as const));
  const map = new Map<string, Question>();
  for (const p of papers) if (p) for (const q of p.questions) map.set(q.id, withRuntime(applyOverride(q, overrides.get(q.id)), p, sn.get(q.id)));
  return map;
}

/**
 * Submits a session: grades it, updates question stats and the mistakes bank, and stores the
 * summary, all in one transaction. Idempotent: a second call on a finished session is a no-op.
 */
export async function submitSession(sessionId: string, auto: boolean, now = Date.now()): Promise<{ summary: SessionSummary; grade: GradeResult } | null> {
  const d = await store.db();
  const detail = await d.get('sessionDetail', sessionId);
  const pre = await d.get('sessions', sessionId);
  if (!detail || !pre) return null;
  const questions = await loadSessionQuestions(detail);
  const grade = gradeSession(detail.answers, (qid) => questions.get(qid)?.answer, auto);

  return store.write(async () => {
    const tx = d.transaction(['sessions', 'sessionDetail', 'questionStats', 'bankEvents', 'packs'], 'readwrite');
    const sessions = tx.objectStore('sessions');
    const current = await sessions.get(sessionId);
    if (!current || current.status === 'submitted' || current.status === 'auto-submitted') {
      await tx.done;
      return current ? { summary: current, grade } : null;
    }
    const awaitingKey = grade.unkeyed > 0;
    const statsStore = tx.objectStore('questionStats');
    // A session waiting for its key changes no stats until it is graded (regrade.ts).
    for (const it of awaitingKey ? [] : grade.items) {
      const key = statKey(detail.packId, it.qid);
      const prev = (await statsStore.get(key)) ?? emptyStat(detail.packId, it.qid);
      const { stat, event } = applyAnswer(prev, { correct: it.correct, unsure: it.unsure, timeMs: it.timeMs, at: now, countSeen: countsSeen(current.type) });
      await statsStore.put(stat);
      if (event) await tx.objectStore('bankEvents').add({ packId: detail.packId, qid: it.qid, at: now, kind: event });
    }
    const summary: SessionSummary = {
      ...current,
      status: auto ? 'auto-submitted' : 'submitted',
      partial: grade.partial,
      answered: grade.answered,
      correct: awaitingKey ? 0 : grade.correct,
      ...(awaitingKey ? { awaitingKey: true } : {}),
      // Recorded time never exceeds the session budget (a sleep past time zero is not time spent).
      timeMs: current.timer ? Math.min(grade.timeMs, current.timer.totalMs) : grade.timeMs,
      agg: grade.agg,
      endedAt: now,
      updatedAt: now,
    };
    await sessions.put(summary);
    // Snapshot the key used for grading, so later key fixes never make the review disagree.
    const det: SessionDetail = { ...detail, key: detail.questionIds.map((q) => questions.get(q)?.answer ?? null) };
    if (det.timer) det.timer = { ...det.timer, endAt: undefined };
    await tx.objectStore('sessionDetail').put(det);
    const pack = await tx.objectStore('packs').get(detail.packId);
    if (pack) await tx.objectStore('packs').put({ ...pack, lastPractisedAt: now });
    await tx.done;
    return { summary, grade };
  });
}

/** Daily 10 for a pack today: how many questions are due and how many fit in ten minutes. */
export async function dailyPlan(pack: Pack, now = Date.now()): Promise<{ due: number; size: number }> {
  const stats = await store.getStats(pack.id);
  if (!stats.some((s) => s.inBank)) return { due: 0, size: 0 };
  const { papers } = await loadPackContent(pack.id);
  const due = dueForDaily(stats, now, new Set(viewableIds(papers))).length;
  const size = dailySize(typicalPace(await store.getSessions(pack.id), pack.papers));
  return { due, size: Math.min(due, size) };
}
