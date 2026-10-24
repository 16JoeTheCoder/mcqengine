import * as store from '../data/db';
import { applyOverride, paperReady } from '../format/merge';
import type { AnswerRecord, Pack, Paper, Question, QuestionOverride, SessionDetail, SessionMode, SessionSummary, SessionType, TimerConfig } from '../types';
import { gradeSession, type GradeResult } from './grade';
import { applyAnswer, drillBudgetMs, emptyStat, selectDrill, statKey } from './mistakes';
import { drawRandom, standardLength, type PoolItem } from './random';
import { cryptoRng, shuffle, uid } from './rng';
import { buildTimer } from './timer';
import { packBudgetSec } from '../stats/kpi';

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
  const [papers, ovs] = await Promise.all([store.getPapers(packId), store.getOverrides(packId)]);
  const overrides = new Map(ovs.map((o) => [o.qid, o] as const));
  return { papers: papers.map((p) => ({ ...p, questions: p.questions.map((q) => applyOverride(q, overrides.get(q.id))) })), overrides };
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
    if (meta && !paperReady(meta)) throw new Error('This paper is not complete or not fully keyed yet');
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
    } else {
      const eligible = new Set(poolOf(papers, new Map()).map((p) => p.qid).filter((q) => !locked.has(q)));
      ids = selectDrill([...stats.values()], size, eligible);
      title = 'Mistakes drill';
    }
    capMin = sessionCapMin(o.pack, o.type, ids.length);
  }
  if (!ids.length) throw new Error('No questions available for this session');

  let timer: TimerConfig | undefined;
  if (o.mode === 'exam') {
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

/** Questions for a session, with overrides applied, keyed by id. */
export async function loadSessionQuestions(detail: SessionDetail): Promise<Map<string, Question>> {
  const keys = [...new Set(Object.values(detail.sources))];
  const [papers, ovs] = await Promise.all([Promise.all(keys.map((k) => store.getPaper(k))), store.getOverrides(detail.packId)]);
  const overrides = new Map(ovs.map((o) => [o.qid, o] as const));
  const map = new Map<string, Question>();
  for (const p of papers) if (p) for (const q of p.questions) map.set(q.id, applyOverride(q, overrides.get(q.id)));
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
    const statsStore = tx.objectStore('questionStats');
    for (const it of grade.items) {
      const key = statKey(detail.packId, it.qid);
      const prev = (await statsStore.get(key)) ?? emptyStat(detail.packId, it.qid);
      const { stat, event } = applyAnswer(prev, { correct: it.correct, unsure: it.unsure, timeMs: it.timeMs, at: now, countSeen: current.type !== 'drill' });
      await statsStore.put(stat);
      if (event) await tx.objectStore('bankEvents').add({ packId: detail.packId, qid: it.qid, at: now, kind: event });
    }
    const summary: SessionSummary = {
      ...current,
      status: auto ? 'auto-submitted' : 'submitted',
      partial: grade.partial,
      answered: grade.answered,
      correct: grade.correct,
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
