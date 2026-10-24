import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  DEFAULT_SETTINGS,
  type BankEvent,
  type ImageRecord,
  type Pack,
  type Paper,
  type QuestionOverride,
  type QuestionStat,
  type SessionDetail,
  type SessionSummary,
  type Settings,
} from '../types';

export interface DmcSchema extends DBSchema {
  packs: { key: string; value: Pack };
  papers: { key: string; value: Paper; indexes: { packId: string } };
  images: { key: string; value: ImageRecord };
  sessions: { key: string; value: SessionSummary; indexes: { packId: string; status: string } };
  sessionDetail: { key: string; value: SessionDetail; indexes: { packId: string } };
  questionStats: { key: string; value: QuestionStat; indexes: { packId: string } };
  bankEvents: { key: number; value: BankEvent; indexes: { packId: string } };
  overrides: { key: string; value: QuestionOverride; indexes: { packId: string } };
  meta: { key: string; value: unknown };
}

export type StoreName = 'packs' | 'papers' | 'images' | 'sessions' | 'sessionDetail' | 'questionStats' | 'bankEvents' | 'overrides' | 'meta';
export const STORES: StoreName[] = ['packs', 'papers', 'images', 'sessions', 'sessionDetail', 'questionStats', 'bankEvents', 'overrides', 'meta'];

export const DB_VERSION = 1;
let dbName = 'dmc';
let dbp: Promise<IDBPDatabase<DmcSchema>> | null = null;

/** Migrations: each entry upgrades from version (index) to (index + 1). Never edit a shipped step. */
const MIGRATIONS: ((db: IDBPDatabase<DmcSchema>) => void)[] = [
  (db) => {
    db.createObjectStore('packs', { keyPath: 'id' });
    db.createObjectStore('papers', { keyPath: 'key' }).createIndex('packId', 'packId');
    db.createObjectStore('images', { keyPath: 'id' });
    const s = db.createObjectStore('sessions', { keyPath: 'id' });
    s.createIndex('packId', 'packId');
    s.createIndex('status', 'status');
    db.createObjectStore('sessionDetail', { keyPath: 'id' }).createIndex('packId', 'packId');
    db.createObjectStore('questionStats', { keyPath: 'key' }).createIndex('packId', 'packId');
    db.createObjectStore('bankEvents', { keyPath: 'id', autoIncrement: true }).createIndex('packId', 'packId');
    db.createObjectStore('overrides', { keyPath: 'key' }).createIndex('packId', 'packId');
    db.createObjectStore('meta');
  },
];

export function useDbName(name: string) {
  dbName = name;
  dbp = null;
}

export function db(): Promise<IDBPDatabase<DmcSchema>> {
  if (!dbp) {
    dbp = openDB<DmcSchema>(dbName, DB_VERSION, {
      upgrade(d, oldVersion) {
        for (let v = oldVersion; v < DB_VERSION; v++) MIGRATIONS[v]?.(d);
      },
      blocking() {
        // A newer version of the app wants to upgrade the database: close and let it proceed.
        dbp?.then((d) => d.close());
        dbp = null;
        dispatchEvent(new CustomEvent('dmc:db-blocked'));
      },
      terminated() {
        dbp = null;
      },
    });
  }
  return dbp;
}

export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** Runs a write, reporting storage-full errors to the UI before rethrowing. */
export async function write<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isQuotaError(e) || isQuotaError((e as { cause?: unknown })?.cause)) dispatchEvent(new CustomEvent('dmc:quota'));
    throw e;
  }
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

// ---------- settings ----------
export async function getSettings(): Promise<Settings> {
  const s = (await (await db()).get('meta', 'settings')) as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}
export async function putSettings(s: Settings) {
  await write(async () => (await db()).put('meta', s, 'settings'));
}

// ---------- packs & papers ----------
export const getPacks = async () => (await db()).getAll('packs');
export const getPack = async (id: string) => (await db()).get('packs', id);
export const getPaper = async (key: string) => (await db()).get('papers', key);
export const getPapers = async (packId: string) => (await db()).getAllFromIndex('papers', 'packId', packId);
export const getImage = async (id: string) => (await db()).get('images', id);

export async function savePackAndPapers(pack: Pack, papers: Paper[], images: ImageRecord[] = []) {
  await write(async () => {
    const tx = (await db()).transaction(['packs', 'papers', 'images'], 'readwrite');
    await Promise.all([
      tx.objectStore('packs').put(pack),
      ...papers.map((p) => tx.objectStore('papers').put(p)),
      ...images.map((i) => tx.objectStore('images').put(i)),
      tx.done,
    ]);
  });
}

export async function putPack(pack: Pack) {
  await write(async () => (await db()).put('packs', pack));
}

/** Deletes a pack and everything that belongs to it. Images may be shared, so they are swept separately. */
export async function deletePack(packId: string) {
  const d = await db();
  const stores = ['papers', 'sessions', 'sessionDetail', 'questionStats', 'bankEvents', 'overrides'] as const;
  const tx = d.transaction(['packs', ...stores], 'readwrite');
  await tx.objectStore('packs').delete(packId);
  for (const name of stores) {
    const idx = tx.objectStore(name).index('packId');
    for (let c = await idx.openCursor(IDBKeyRange.only(packId)); c; c = await c.continue()) await c.delete();
  }
  await tx.done;
  await sweepImages();
}

/** Removes images no paper or override references. */
export async function sweepImages() {
  const d = await db();
  const used = new Set<string>();
  const collect = (f?: { kind: string; imageId?: string }) => f?.kind === 'image' && f.imageId && used.add(f.imageId);
  for (const p of await d.getAll('papers'))
    for (const q of p.questions) {
      if (q.image) used.add(q.image);
      collect(q.figure as never);
      q.options?.forEach((o) => collect(o.figure as never));
    }
  for (const o of await d.getAll('overrides')) collect(o.figure as never);
  const tx = d.transaction('images', 'readwrite');
  for (let c = await tx.store.openCursor(); c; c = await c.continue()) if (!used.has(c.key)) await c.delete();
  await tx.done;
}

// ---------- sessions ----------
export const getSessions = async (packId: string) => (await db()).getAllFromIndex('sessions', 'packId', packId);
export const getAllSessions = async () => (await db()).getAll('sessions');
export const getSession = async (id: string) => (await db()).get('sessions', id);
export const getDetail = async (id: string) => (await db()).get('sessionDetail', id);

export async function getOpenSessions(): Promise<SessionSummary[]> {
  const d = await db();
  const [a, s] = await Promise.all([d.getAllFromIndex('sessions', 'status', 'active'), d.getAllFromIndex('sessions', 'status', 'saved')]);
  return [...a, ...s];
}

export async function saveSessionState(summary: SessionSummary, detail: SessionDetail) {
  await write(async () => {
    const tx = (await db()).transaction(['sessions', 'sessionDetail'], 'readwrite');
    await Promise.all([tx.objectStore('sessions').put(summary), tx.objectStore('sessionDetail').put(detail), tx.done]);
  });
}

export async function deleteSession(id: string) {
  const tx = (await db()).transaction(['sessions', 'sessionDetail'], 'readwrite');
  await Promise.all([tx.objectStore('sessions').delete(id), tx.objectStore('sessionDetail').delete(id), tx.done]);
}

// ---------- stats ----------
export const getStats = async (packId: string) => (await db()).getAllFromIndex('questionStats', 'packId', packId);
export const getBankEvents = async (packId: string) => (await db()).getAllFromIndex('bankEvents', 'packId', packId);
export const getOverrides = async (packId: string) => (await db()).getAllFromIndex('overrides', 'packId', packId);

export async function putOverride(o: QuestionOverride) {
  await write(async () => (await db()).put('overrides', o));
}
export async function deleteOverride(key: string) {
  await (await db()).delete('overrides', key);
}

export async function wipeAll() {
  const d = await db();
  const tx = d.transaction(STORES, 'readwrite');
  await Promise.all([...STORES.map((s) => tx.objectStore(s).clear()), tx.done]);
}
