import { collectSessionChanges, SESSION_REVISIONS } from './change-tracking';
import * as store from '../data/db';
import { cleanSettings, validRow } from '../data/backup';
import { rebuildStats } from '../engine/regrade';
import { DEFAULT_SETTINGS, type SessionSummary, type Settings } from '../types';
import type { Backend, SyncRecord } from '../backend/types';
import { createStore } from '../app-state';

/**
 * Local-first sync. IndexedDB stays the source of truth; the server keeps one small record per
 * (store, id) per account. Compare-and-set writes prevent silent lost updates. Synced:
 * pack outlines, finished session details and content snapshots, snips, fixes and settings.
 * Full paper files and PDF/image assets stay local; statistics are derived. Open sessions stay on their device.
 * Pushes and pulls are idempotent and resume from saved cursors, so an interrupted sync loses
 * nothing and repeats nothing harmful.
 */
export interface SyncMeta {
  account: string;
  /** Version (updated_at) of each record the server is known to have, by `store|id`. */
  versions: Record<string, number>;
  /** Server cursor already pulled and applied. */
  pulled: string | null;
  at?: number;
}

const vkey = (r: Pick<SyncRecord, 'store' | 'id'>) => `${r.store}|${r.id}`;

const DEVICE_ONLY: (keyof Settings)[] = ['lastBackupAtCount', 'lastBackupAt'];
const finished = (s: SessionSummary) => s.status === 'submitted' || s.status === 'auto-submitted';
const BATCH = 200;

export async function getSyncMeta(account: string): Promise<SyncMeta> {
  const m = (await (await store.db()).get('meta', 'sync')) as SyncMeta | undefined;
  return m && m.account === account && m.versions ? m : { account, versions: {}, pulled: null };
}
const putSyncMeta = async (m: SyncMeta) => void (await (await store.db()).put('meta', m, 'sync'));

/**
 * Local records the server does not have in this version. Tracking versions per record (rather
 * than a time cursor) also catches records with older timestamps, such as a restored backup.
 */
export async function collectLocal(versions: Record<string, number> = {}): Promise<SyncRecord[]> {
  const all = await allLocal(versions);
  return all.filter((r) => versions[vkey(r)] !== r.updated_at);
}

async function allLocal(versions: Record<string, number>): Promise<SyncRecord[]> {
  const d = await store.db();
  const out: SyncRecord[] = [];
  for (const p of await d.getAll('packs')) out.push({ store: 'packs', id: p.id, updated_at: p.updatedAt, data: p });
  out.push(...await collectSessionChanges(d, versions));
  // Statistics are derived from complete attempt revisions and never pushed independently.
  for (const sn of await d.getAll('snips')) out.push({ store: 'snips', id: sn.key, updated_at: sn.updatedAt, data: sn });
  for (const o of await d.getAll('overrides')) out.push({ store: 'overrides', id: o.key, updated_at: o.updatedAt, data: o });
  const st = (await d.get('meta', 'settings')) as Settings | undefined;
  if (st?.updatedAt) {
    const shared: Partial<Settings> = { ...st };
    for (const k of DEVICE_ONLY) delete shared[k];
    out.push({ store: 'settings', id: 'settings', updated_at: st.updatedAt, data: shared });
  }
  const tomb = ((await d.get('meta', 'tombstones')) as Record<string, number> | undefined) ?? {};
  for (const [k, at] of Object.entries(tomb)) {
    const [storeName, id] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
    if (['packs', 'sessions', 'sessionDetail', 'questionStats', 'snips', 'overrides'].includes(storeName)) out.push({ store: storeName as SyncRecord['store'], id, updated_at: at, deleted: true, data: null });
  }
  return out;
}

const stampOf = (r: Record<string, unknown> | undefined, storeName: SyncRecord['store']): number =>
  !r ? -1 : storeName === 'questionStats' ? Number(r.lastAnsweredAt ?? 0) : Number(r.updatedAt ?? 0);

/**
 * Applies server revisions in order; invalid pages roll back as a unit; a local open session is never overwritten; packs merge their paper lists. Stats of
 * every pack whose sessions changed are rebuilt by replay, so they always agree with sessions.
 * Returns how many records changed this device.
 */
export async function applyRemote(records: SyncRecord[], versions: Record<string, number> = {}): Promise<number> {
  const d = await store.db();
  let changed = 0;
  const nextVersions = { ...versions };
  let sessionChanges = false;
  const touched = new Set<string>();
  // Persist half revisions across pull pages/restarts. No summary is visible until its detail arrives.
  const tx = d.transaction(['packs', 'papers', 'sessions', 'sessionDetail', 'questionStats', 'bankEvents', 'snips', 'overrides', 'meta'], 'readwrite');
  const meta = tx.objectStore('meta');
  const pending = ((await meta.get('syncPending')) as Record<string, SyncRecord> | undefined) ?? {};
  const tomb = ((await meta.get('tombstones')) as Record<string, number> | undefined) ?? {};
  const conflicts = ((await meta.get('syncConflicts')) as { key: string; local: unknown; remote: unknown }[] | undefined) ?? [];
  const ready: SyncRecord[] = [];
  try {
  for (const r of records) {
    if (!['packs', 'sessions', 'sessionDetail', 'questionStats', 'snips', 'overrides', 'settings'].includes(r.store) || !Number.isFinite(r.updated_at)) continue;
    if ((r.store === 'sessions' || r.store === 'sessionDetail') && !r.deleted) {
      pending[vkey(r)] = r;
    } else ready.push(r);
  }
  for (const [key, row] of Object.entries(pending)) {
    if (row.store !== 'sessions') continue;
    const detail = pending[`sessionDetail|${row.id}`];
    if (!detail || detail.updated_at !== row.updated_at) continue;
    if (!validRow('sessions', row.data as Record<string, unknown>) || !validRow('sessionDetail', detail.data as Record<string, unknown>)) throw new Error('Invalid remote session revision');
    ready.push(row, detail);
    delete pending[key]; delete pending[`sessionDetail|${row.id}`];
  }
  const accepted = new Set<string>();
  for (const r of ready) {
    const key = vkey(r);
    if (r.store === 'questionStats') {
      const row = r.data as {packId?: string} | null;
      if (row?.packId) touched.add(row.packId);
      nextVersions[key] = r.updated_at;
      continue;
    }
    const os = r.store === 'settings' ? null : tx.objectStore(r.store);
    const local = (os ? await os.get(r.id) : await meta.get('settings')) as Record<string, unknown> | undefined;
    const localStamp = stampOf(local, r.store);
    const known = nextVersions[key];
    // Already observed remote version: keep any subsequent local edit for the next push.
    if (known === r.updated_at) continue;
    if (r.store === 'sessions' && local && ['active', 'saved'].includes(local.status as string)) continue;
    if (r.store === 'sessionDetail' && !r.deleted && !accepted.has(r.id)) continue;
    if (local && known !== undefined && localStamp !== known && r.store !== 'sessionDetail') conflicts.push({ key, local, remote: r.data });
    if (r.deleted) {
      if (os) await os.delete(r.id);
      tomb[key] = r.updated_at;
      if (r.store === 'packs') {
        for (const name of ['papers', 'sessions', 'sessionDetail', 'questionStats', 'bankEvents', 'snips', 'overrides'] as const) {
          for (let c = await tx.objectStore(name).index('packId').openCursor(IDBKeyRange.only(r.id)); c; c = await c.continue()) await c.delete();
        }
      }
      if (r.store === 'sessions') { await tx.objectStore('sessionDetail').delete(r.id); if (typeof local?.packId === 'string') touched.add(local.packId); }
      delete pending[`sessions|${r.id}`]; delete pending[`sessionDetail|${r.id}`];
    } else {
      const data = r.data as Record<string, unknown>;
      if (!data || (r.store !== 'settings' && !validRow(r.store, data))) throw new Error(`Invalid remote ${r.store} record`);
      if (r.store === 'sessions') { if (!finished(data as unknown as SessionSummary)) continue; accepted.add(r.id); touched.add(data.packId as string); }
      if (r.store === 'settings') {
        const keep: Partial<Settings> = {};
        for (const k of DEVICE_ONLY) if (local?.[k] !== undefined) (keep as Record<string, unknown>)[k] = local[k];
        await meta.put({ ...cleanSettings({ ...DEFAULT_SETTINGS, ...data }), ...keep, updatedAt: r.updated_at }, 'settings');
      } else {
        if (r.store === 'packs' && local) {
          const incoming = data as unknown as import('../types').Pack;
          const metas = new Map(incoming.papers.map(p => [p.id, p]));
          for (const paper of (local as unknown as import('../types').Pack).papers) if (!metas.has(paper.id)) metas.set(paper.id, paper);
          if (metas.size > incoming.papers.length) { data.papers = [...metas.values()]; data.updatedAt = Math.max(r.updated_at + 1, localStamp + 1); }
        }
        await os!.put(data as never);
      }
      delete tomb[key];
    }
    nextVersions[key] = r.updated_at;
    if (r.store === 'sessions' || r.store === 'sessionDetail' || r.store === 'packs' && r.deleted) sessionChanges = true;
    changed++;
  }
  if (sessionChanges) await meta.delete(SESSION_REVISIONS);
  await meta.put(pending, 'syncPending');
  await meta.put(tomb, 'tombstones');
  await meta.put(conflicts.slice(-100), 'syncConflicts');
  await tx.done;
  Object.assign(versions, nextVersions);
  } catch (error) {
    try { tx.abort(); } catch { /* Already aborted or completed. */ }
    await tx.done.catch(() => {});
    throw error;
  }
  for (const packId of touched) await rebuildStats(packId);
  return changed;
}

export type SyncState = { state: 'off' | 'idle' | 'syncing' | 'offline' | 'error'; at?: number; message?: string };
export const syncStore = createStore<SyncState>({ state: 'off' });

let running: Promise<void> | null = null;
let generation = 0;
export function invalidateSync() { generation++; running = null; syncStore.set({ state: 'off' }); }


/** Push local changes, then pull and apply remote ones. Never throws; reports through syncStore. */
export function syncNow(be: Backend | null, account: string | null): Promise<void> {
  if (!be || !account) {
    syncStore.set({ state: 'off' });
    return Promise.resolve();
  }
  const token = generation;
  const workspace = store.currentDbName();
  const guard = () => { if (token !== generation || workspace !== store.currentDbName()) throw new Error('Workspace changed'); };
  running ??= (async () => {
    syncStore.set({ ...syncStore.get(), state: 'syncing' });
    try {
      const meta = await getSyncMeta(account);
      // Pull first, so a newer copy elsewhere is applied before this device pushes its own.
      let applied = 0;
      for (;;) {
        const page = await be.syncPull(meta.pulled, 500, account);
        guard();
        if (!page.records.length) break;
        applied += await applyRemote(page.records, meta.versions);
        meta.pulled = page.cursor;
        await putSyncMeta(meta);
        if (page.records.length < 500) break;
      }
      guard();
      const local = await collectLocal(meta.versions);
      for (let i = 0; i < local.length; i += BATCH) {
        const batch = local.slice(i, i + BATCH);
        guard();
        const count = await be.syncPush(batch.map((r) => ({ ...r, base_updated_at: meta.versions[vkey(r)] ?? 0 })), account);
        guard();
        if (count !== batch.length) throw new Error('Some writes were rejected. Pull and resolve conflicts before retrying.');
        for (const r of batch) meta.versions[vkey(r)] = r.updated_at;
        await putSyncMeta(meta);
      }
      // Our own pushes come back on the next pull; they are already marked, so they are no-ops.
      for (;;) {
        const page = await be.syncPull(meta.pulled, 500, account);
        guard();
        if (!page.records.length) break;
        applied += await applyRemote(page.records, meta.versions);
        meta.pulled = page.cursor;
        await putSyncMeta(meta);
        if (page.records.length < 500) break;
      }
      meta.at = Date.now();
      await putSyncMeta(meta);
      syncStore.set({ state: 'idle', at: meta.at });
      if (applied) dispatchEvent(new CustomEvent('dmc:synced', { detail: applied }));
    } catch (e) {
      if (token !== generation || workspace !== store.currentDbName()) return;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      syncStore.set({ ...syncStore.get(), state: offline ? 'offline' : 'error', message: (e as Error).message });
    } finally {
      if (token === generation) running = null;
    }
  })();
  return running;
}

/** "Synced 2 min ago", "Offline, will sync later", … */
export function syncLabel(s: SyncState, now = Date.now()): string {
  if (s.state === 'off') return 'Saved locally · sync is off';
  if (s.state === 'syncing') return 'Syncing…';
  if (s.state === 'offline') return 'Offline, will sync later';
  if (s.state === 'error') return 'Sync failed, will retry';
  if (!s.at) return 'Not synced yet';
  const min = Math.floor((now - s.at) / 60_000);
  return min < 1 ? 'Synced just now' : min < 60 ? `Synced ${min} min ago` : `Synced ${Math.floor(min / 60)} h ago`;
}
