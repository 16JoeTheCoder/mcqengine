import * as store from '../data/db';
import type { BankEvent, QuestionStat, SessionDetail, SessionSummary } from '../types';
import { gradeSession } from './grade';
import { applyAnswer, emptyStat } from './mistakes';
import { countsSeen, loadPackContent } from './session';

const finished = (s: SessionSummary) => s.status === 'submitted' || s.status === 'auto-submitted';

/** The key a stored session is graded with: its snapshot, else the current key. */
export function sessionKey(d: SessionDetail, current: ReadonlyMap<string, number | null>): (number | null)[] {
  return d.questionIds.map((q, i) => (current.has(q) ? (current.get(q) ?? null) : (d.key?.[i] ?? null)));
}

/**
 * Question stats and mistakes-bank events are a pure replay of graded sessions in the order they
 * ended. Rebuilding them after a regrade or a sync merge keeps every device consistent, and a key
 * correction can never leave a stale streak behind.
 */
export function replayStats(packId: string, rows: { s: SessionSummary; d: SessionDetail }[]): { stats: QuestionStat[]; events: BankEvent[] } {
  const stats = new Map<string, QuestionStat>();
  const events: BankEvent[] = [];
  const ordered = rows.filter(({ s }) => finished(s) && !s.awaitingKey).sort((a, b) => (a.s.endedAt ?? 0) - (b.s.endedAt ?? 0) || a.s.id.localeCompare(b.s.id));
  for (const { s, d } of ordered) {
    const key = new Map(d.questionIds.map((q, i) => [q, d.key?.[i] ?? null] as const));
    const g = gradeSession(d.answers, (q) => key.get(q), s.status === 'auto-submitted');
    const at = s.endedAt ?? s.updatedAt;
    for (const it of g.items) {
      const prev = stats.get(it.qid) ?? emptyStat(packId, it.qid);
      const { stat, event } = applyAnswer(prev, { correct: it.correct, unsure: it.unsure, timeMs: it.timeMs, at, countSeen: countsSeen(s.type) });
      stats.set(it.qid, stat);
      if (event) events.push({ packId, qid: it.qid, at, kind: event });
    }
  }
  return { stats: [...stats.values()], events };
}

/** Replaces a pack's stats and bank events with a replay of its sessions. */
export async function rebuildStats(packId: string): Promise<void> {
  const d = await store.db();
  const sessions = await d.getAllFromIndex('sessions', 'packId', packId);
  const rows: { s: SessionSummary; d: SessionDetail }[] = [];
  for (const s of sessions) {
    if (!finished(s)) continue;
    const det = await d.get('sessionDetail', s.id);
    if (det) rows.push({ s, d: det });
  }
  const { stats, events } = replayStats(packId, rows);
  await store.write(async () => {
    const tx = d.transaction(['questionStats', 'bankEvents'], 'readwrite');
    for (const name of ['questionStats', 'bankEvents'] as const) {
      const idx = tx.objectStore(name).index('packId');
      for (let c = await idx.openCursor(IDBKeyRange.only(packId)); c; c = await c.continue()) await c.delete();
    }
    for (const s of stats) await tx.objectStore('questionStats').put(s);
    for (const e of events) await tx.objectStore('bankEvents').add(e);
    await tx.done;
  });
}

/**
 * Regrades every finished session of a pack whose key changed (a key attached, corrected, or a
 * session that was waiting for one), then rebuilds stats. Returns the number of sessions regraded.
 */
export async function regradePack(packId: string, now = Date.now()): Promise<number> {
  const { papers } = await loadPackContent(packId);
  const current = new Map<string, number | null>();
  for (const p of papers) for (const q of p.questions) current.set(q.id, q.answer);
  const d = await store.db();
  let changed = 0;
  for (const s of await d.getAllFromIndex('sessions', 'packId', packId)) {
    if (!finished(s)) continue;
    const det = await d.get('sessionDetail', s.id);
    if (!det) continue;
    const key = sessionKey(det, current);
    if (!s.awaitingKey && det.key && key.every((k, i) => k === det.key?.[i])) continue;
    const byQ = new Map(det.questionIds.map((q, i) => [q, key[i] ?? null] as const));
    const g = gradeSession(det.answers, (q) => byQ.get(q), s.status === 'auto-submitted');
    const awaitingKey = g.unkeyed > 0;
    const { awaitingKey: _a, ...rest } = s;
    const summary: SessionSummary = { ...rest, answered: g.answered, correct: awaitingKey ? 0 : g.correct, partial: g.partial, agg: g.agg, updatedAt: now, ...(awaitingKey ? { awaitingKey } : {}) };
    await store.saveSessionState(summary, { ...det, key });
    changed++;
  }
  if (changed) await rebuildStats(packId);
  return changed;
}
