import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../src/lib/data/db';
import { backend as mockBackend } from '../../src/lib/backend';
import { createCloudflareBackend } from '../../src/lib/backend/cloudflare';
import { startWorker, type Harness } from './worker-harness';
import type { Backend } from '../../src/lib/backend/types';
import { collectLocal, getSyncMeta, syncNow, syncStore, syncLabel } from '../../src/lib/sync/sync';
import { createSession, submitSession } from '../../src/lib/engine/session';
import { doc, syntheticPaper } from '../fixtures/make';
import { answerAll, importPack, synthKey } from './helpers';
import { DEFAULT_SETTINGS } from '../../src/lib/types';

let n = 0;
let me = '';
const device = (name: 'A' | 'B') => store.useDbName(`sync-${n}-${name}`);

/**
 * The same sync scenarios run against the in-browser mock and against the real Worker (D1 in
 * workerd via Miniflare), through the Cloudflare client the app uses in production.
 */
let backend: Backend | null = mockBackend;
let harness: Harness | null = null;
let cookie = '';
const workerBackend = () => createCloudflareBackend({
  base: 'http://localhost',
  fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => harness!.fetch(String(url).replace('http://localhost', ''), { ...(init as object), as: cookie } as never)) as typeof fetch,
});
const TARGET = process.env.DMC_SYNC_TARGET;
const targets = TARGET ? [TARGET] : ['mock', 'worker'];

async function practiceOnA(wrongFirst = true) {
  device('A');
  const id = await importPack(doc(syntheticPaper('p1', 4)));
  const pack = (await store.getPack(id))!;
  const { summary } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
  await answerAll(summary.id, (i, q) => (wrongFirst && i === 0 ? (synthKey(q) + 1) % 4 : synthKey(q)));
  await submitSession(summary.id, false);
  return { id, sessionId: summary.id };
}

for (const target of targets) describe(`sync between two devices (${target})`, () => {
  beforeAll(async () => { if (target === 'worker') { harness = await startWorker(); backend = workerBackend(); } else backend = mockBackend; }, 60_000);
  afterAll(async () => { await harness?.dispose(); harness = null; });
  beforeEach(async () => {
    n++;
    if (target === 'worker') {
      const s = await harness!.signIn(`student${n}@gmail.com`);
      cookie = s.cookie;
      me = s.id;
    } else {
      // A fresh mock server per test: wipe its database.
      indexedDB.deleteDatabase('dmc-mock-server');
      await backend!.signInDev!(`student${n}@gmail.com`);
      me = (await backend!.account())!.id;
    }
  });

  it('a personal account syncs: B receives the outline, the session and rebuilt stats, never the questions or PDFs', async () => {
    const { id, sessionId } = await practiceOnA();
    await syncNow(backend, me);
    expect(syncStore.get().state).toBe('idle');
    device('B');
    await syncNow(backend, me);
    expect((await store.getPack(id))!.papers.map((p) => p.id)).toEqual(['p1']);
    expect(await store.getPapers(id)).toEqual([]);
    expect((await store.getSession(sessionId))!.correct).toBe(3);
    expect((await store.getDetail(sessionId))!.answers).toHaveLength(4);
    const stats = await store.getStats(id);
    expect(stats.filter((s) => s.inBank).map((s) => s.qid)).toEqual(['p1#1']);
    expect(await store.getBankEvents(id)).toHaveLength(1);
  });

  it('newest write wins per record, both ways, and a snip deletion travels', async () => {
    const { id } = await practiceOnA();
    await store.putOverride({ key: `${id}::p1#2`, packId: id, qid: 'p1#2', note: 'from A', reported: true, updatedAt: 1000 });
    await store.putSnip({ key: `${id}::p1#3`, packId: id, qid: 'p1#3', pdfId: 'a'.repeat(64), page: 1, x: 0, y: 0, w: 1, h: 0.5, updatedAt: 1000 });
    await syncNow(backend, me);
    device('B');
    await syncNow(backend, me);
    expect((await store.getOverrides(id))[0]!.note).toBe('from A');
    expect(await store.getSnips(id)).toHaveLength(1);
    await store.putOverride({ key: `${id}::p1#2`, packId: id, qid: 'p1#2', note: 'from B, newer', reported: true, updatedAt: 3000 });
    await syncNow(backend, me);
    device('A');
    await store.putOverride({ key: `${id}::p1#2`, packId: id, qid: 'p1#2', note: 'from A, older edit', reported: true, updatedAt: 2000 });
    await store.deleteSnip(`${id}::p1#3`, 4000);
    await syncNow(backend, me);
    expect((await store.getOverrides(id))[0]!.note).toBe('from B, newer');
    device('B');
    await syncNow(backend, me);
    expect((await store.getOverrides(id))[0]!.note).toBe('from B, newer');
    expect(await store.getSnips(id)).toHaveLength(0);
  });

  it('settings sync, except device-only backup counters', async () => {
    device('A');
    await store.putSettings({ ...DEFAULT_SETTINGS, theme: 'dark', lastBackupAtCount: 7, updatedAt: 5000 });
    await syncNow(backend, me);
    device('B');
    await store.putSettings({ ...DEFAULT_SETTINGS, lastBackupAtCount: 2, updatedAt: 100 });
    await syncNow(backend, me);
    const s = await store.getSettings();
    expect(s.theme).toBe('dark');
    expect(s.lastBackupAtCount).toBe(2);
  });

  it('open sessions stay on their device', async () => {
    device('A');
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    await createSession({ pack: (await store.getPack(id))!, type: 'paper', mode: 'exam', paperId: 'p1' });
    expect((await collectLocal({})).filter((r) => r.store === 'sessions')).toEqual([]);
  });

  it('an interrupted push or pull loses nothing and resumes', async () => {
    const { id, sessionId } = await practiceOnA();
    for (let q = 0; q < 1100; q++) await store.putOverride({ key: `${id}::x${q}`, packId: id, qid: `x${q}`, note: `n${q}`, updatedAt: 1000 + q });
    let pushes = 0;
    const flaky: Backend = { ...backend!, syncPush: async (r) => (++pushes === 2 ? Promise.reject(new Error('network down')) : backend!.syncPush(r)) };
    await syncNow(flaky, me);
    expect(syncStore.get().state).toBe('error');
    expect(syncLabel(syncStore.get())).toBe('Sync failed, will retry');
    expect(Object.keys((await getSyncMeta(me)).versions).length).toBe(200);
    await syncNow(backend, me);
    expect(syncStore.get().state).toBe('idle');

    device('B');
    let pulls = 0;
    const flakyPull: Backend = { ...backend!, syncPull: async (c, l) => (++pulls === 2 ? Promise.reject(new Error('network down')) : backend!.syncPull(c, l)) };
    await syncNow(flakyPull, me);
    expect(syncStore.get().state).toBe('error');
    const half = await store.getOverrides(id);
    expect(half.length).toBeGreaterThan(0);
    expect(half.length).toBeLessThan(1100);
    await syncNow(backend, me);
    expect(await store.getOverrides(id)).toHaveLength(1100);
    expect((await store.getSession(sessionId))!.correct).toBe(3);
  });

  it('labels the state quietly', () => {
    const now = 10 * 60_000;
    expect(syncLabel({ state: 'idle', at: now - 2 * 60_000 }, now)).toBe('Synced 2 min ago');
    expect(syncLabel({ state: 'offline' })).toBe('Offline, will sync later');
  });
});
