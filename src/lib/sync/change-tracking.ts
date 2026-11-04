import type { IDBPDatabase } from 'idb';
import type { DmcSchema } from '../data/db';
import type { SessionSummary } from '../types';
import type { SyncRecord } from '../backend/types';

export const SESSION_REVISIONS = 'sessionRevisions';
type Meta = { get(key: string): Promise<unknown>; put(value: unknown, key: string): Promise<unknown> };
const finished = (s: SessionSummary) => s.status === 'submitted' || s.status === 'auto-submitted';

/** Called inside the same transaction as a summary/detail write. Absent indexes bootstrap once. */
export async function trackSession(meta: Meta, summary: SessionSummary | null, id = summary?.id) {
  const revisions = await meta.get(SESSION_REVISIONS) as Record<string, number> | undefined;
  if (!revisions || !id) return;
  if (summary && finished(summary)) revisions[id] = summary.updatedAt;
  else delete revisions[id];
  await meta.put(revisions, SESSION_REVISIONS);
}

/** Read unchanged sessions only by their small revision index; fetch answer histories only if dirty. */
export async function collectSessionChanges(d: IDBPDatabase<DmcSchema>, versions: Record<string, number>): Promise<SyncRecord[]> {
  const tx = d.transaction(['sessions', 'sessionDetail', 'meta'], 'readwrite');
  let revisions = await tx.objectStore('meta').get(SESSION_REVISIONS) as Record<string, number> | undefined;
  if (!revisions) {
    revisions = Object.fromEntries((await tx.objectStore('sessions').getAll()).filter(finished).map(s => [s.id, s.updatedAt]));
    await tx.objectStore('meta').put(revisions, SESSION_REVISIONS);
  }
  const out: SyncRecord[] = [];
  for (const [id, stamp] of Object.entries(revisions)) {
    if (versions[`sessions|${id}`] === stamp && versions[`sessionDetail|${id}`] === stamp) continue;
    const summary = await tx.objectStore('sessions').get(id);
    const detail = await tx.objectStore('sessionDetail').get(id);
    if (!summary || !detail || !finished(summary)) continue;
    out.push({ store: 'sessions', id, updated_at: summary.updatedAt, data: summary }, { store: 'sessionDetail', id, updated_at: summary.updatedAt, data: detail });
  }
  await tx.done;
  return out;
}
