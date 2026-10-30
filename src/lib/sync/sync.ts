import * as store from '../data/db';
import { cleanSettings, validRow } from '../data/backup';
import { rebuildStats } from '../engine/regrade';
import { DEFAULT_SETTINGS, type Pack, type SessionDetail, type SessionSummary, type Settings } from '../types';
import type { Backend, SyncRecord } from '../backend/types';
import { createStore } from '../app-state';

/**
 * Local-first sync. IndexedDB stays the source of truth; the server keeps one small record per
 * (store, id) per account, and the newest write wins per record, as in backup restores. Synced:
 * pack outlines (titles and paper lists, never questions or PDFs), finished sessions with their
 * details, question stats, snips, fixes and settings. Open sessions stay on their device.
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
  const all = await allLocal();
  return all.filter((r) => versions[vkey(r)] !== r.updated_at);
}

async function allLocal(): Promise<SyncRecord[]> {
  const d = await store.db();
  const out: SyncRecord[] = [];
  for (const p of await d.getAll('packs')) out.push({ store: 'packs', id: p.id, updated_at: p.updatedAt, data: p });
  for (const s of await d.getAll('sessions')) {
    if (!finished(s)) continue;
    out.push({ store: 'sessions', id: s.id, updated_at: s.updatedAt, data: s });
    const det = await d.get('sessionDetail', s.id);
    if (det) out.push({ store: 'sessionDetail', id: s.id, updated_at: s.updatedAt, data: det });
  }
  for (const q of await d.getAll('questionStats')) if (q.lastAnsweredAt) out.push({ store: 'questionStats', id: q.key, updated_at: q.lastAnsweredAt!, data: q });
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
    if (storeName === 'snips') out.push({ store: 'snips', id, updated_at: at, deleted: true, data: null });
  }
  return out;
}

const stampOf = (r: Record<string, unknown> | undefined, storeName: SyncRecord['store']): number =>
  !r ? -1 : storeName === 'questionStats' ? Number(r.lastAnsweredAt ?? 0) : Number(r.updatedAt ?? 0);

/**
 * Applies pulled records. Newest wins per record; rows that fail the backup shape checks are
 * skipped; a local open session is never overwritten; packs merge their paper lists. Stats of
 * every pack whose sessions changed are rebuilt by replay, so they always agree with sessions.
 * Returns how many records changed this device.
 */
export async function applyRemote(records: SyncRecord[], versions: Record<string, number> = {}): Promise<number> {
  const d = await store.db();
  let changed = 0;
  const touched = new Set<string>();
  const appliedSessions = new Set<string>();
  const order: SyncRecord['store'][] = ['packs', 'sessions', 'sessionDetail', 'questionStats', 'snips', 'overrides', 'settings'];
  const sorted = records.slice().sort((a, b) => order.indexOf(a.store) - order.indexOf(b.store));
  const tomb = ((await d.get('meta', 'tombstones')) as Record<string, number> | undefined) ?? {};
  await store.write(async () => {
    const tx = d.transaction(['packs', 'papers', 'sessions', 'sessionDetail', 'questionStats', 'snips', 'overrides', 'meta'], 'readwrite');
    for (const r of sorted) {
      const data = r.data as Record<string, unknown> | null;
      // The server has this version now; if this device's copy is newer it stays unmarked and is pushed.
      const seen = (localStamp: number) => {
        if (localStamp <= r.updated_at) versions[vkey(r)] = r.updated_at;
      };
      if (r.store === 'settings') {
        if (!data) continue;
        const local = (await tx.objectStore('meta').get('settings')) as Settings | undefined;
        seen(local?.updatedAt ?? 0);
        if ((local?.updatedAt ?? 0) >= r.updated_at) continue;
        const keep: Partial<Settings> = {};
        for (const k of DEVICE_ONLY) if (local?.[k] !== undefined) (keep as Record<string, unknown>)[k] = local[k];
        await tx.objectStore('meta').put({ ...cleanSettings({ ...DEFAULT_SETTINGS, ...data } as Record<string, unknown>), ...keep, updatedAt: r.updated_at }, 'settings');
        changed++;
        continue;
      }
      if (r.store === 'snips' && r.deleted) {
        const local = await tx.objectStore('snips').get(r.id);
        seen(local?.updatedAt ?? 0);
        if (local && local.updatedAt <= r.updated_at) {
          await tx.objectStore('snips').delete(r.id);
          changed++;
        }
        continue;
      }
      if (!data || !validRow(r.store as store.StoreName, data)) continue;
      const os = tx.objectStore(r.store as 'packs');
      const local = (await os.get(r.id)) as unknown as Record<string, unknown> | undefined;
      seen(r.store === 'sessionDetail' ? 0 : stampOf(local, r.store));
      if (r.store === 'sessionDetail') {
        if (!appliedSessions.has(r.id) && local) continue;
        await tx.objectStore('sessionDetail').put(data as unknown as SessionDetail);
        changed++;
        continue;
      }
      if (r.store === 'sessions') {
        const s = data as unknown as SessionSummary;
        if (!finished(s)) continue;
        if (local && (local.status === 'active' || local.status === 'saved')) continue;
        if (stampOf(local, 'sessions') >= r.updated_at) continue;
        await tx.objectStore('sessions').put(s);
        appliedSessions.add(s.id);
        touched.add(s.packId);
        changed++;
        continue;
      }
      if (r.store === 'snips' && (tomb[`snips|${r.id}`] ?? 0) >= r.updated_at) continue;
      if (stampOf(local, r.store) >= r.updated_at) continue;
      if (r.store === 'packs' && local) {
        // Same pack on two devices: keep every paper either outline knows about.
        const inc = data as unknown as Pack;
        const metas = new Map((local as unknown as Pack).papers.map((m) => [m.id, m] as const));
        for (const m of inc.papers) metas.set(m.id, { ...metas.get(m.id), ...m });
        await tx.objectStore('packs').put({ ...inc, papers: [...metas.values()] });
      } else await os.put(data as never);
      changed++;
    }
    await tx.done;
  });
  for (const packId of touched) await rebuildStats(packId);
  return changed;
}

export type SyncState = { state: 'off' | 'idle' | 'syncing' | 'offline' | 'error'; at?: number; message?: string };
export const syncStore = createStore<SyncState>({ state: 'off' });

let running: Promise<void> | null = null;

/** Push local changes, then pull and apply remote ones. Never throws; reports through syncStore. */
export function syncNow(be: Backend | null, account: string | null): Promise<void> {
  if (!be || !account) {
    syncStore.set({ state: 'off' });
    return Promise.resolve();
  }
  running ??= (async () => {
    syncStore.set({ ...syncStore.get(), state: 'syncing' });
    try {
      const meta = await getSyncMeta(account);
      // Pull first, so a newer copy elsewhere is applied before this device pushes its own.
      let applied = 0;
      for (;;) {
        const page = await be.syncPull(meta.pulled, 500);
        if (!page.records.length) break;
        applied += await applyRemote(page.records, meta.versions);
        meta.pulled = page.cursor;
        await putSyncMeta(meta);
        if (page.records.length < 500) break;
      }
      const local = await collectLocal(meta.versions);
      for (let i = 0; i < local.length; i += BATCH) {
        const batch = local.slice(i, i + BATCH);
        await be.syncPush(batch);
        for (const r of batch) meta.versions[vkey(r)] = r.updated_at;
        await putSyncMeta(meta);
      }
      // Our own pushes come back on the next pull; they are already marked, so they are no-ops.
      for (;;) {
        const page = await be.syncPull(meta.pulled, 500);
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
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      syncStore.set({ ...syncStore.get(), state: offline ? 'offline' : 'error', message: (e as Error).message });
    } finally {
      running = null;
    }
  })();
  return running;
}

/** "Synced 2 min ago", "Offline, will sync later", … */
export function syncLabel(s: SyncState, now = Date.now()): string {
  if (s.state === 'off') return 'Sync is off';
  if (s.state === 'syncing') return 'Syncing…';
  if (s.state === 'offline') return 'Offline, will sync later';
  if (s.state === 'error') return 'Sync failed, will retry';
  if (!s.at) return 'Not synced yet';
  const min = Math.floor((now - s.at) / 60_000);
  return min < 1 ? 'Synced just now' : min < 60 ? `Synced ${min} min ago` : `Synced ${Math.floor(min / 60)} h ago`;
}
