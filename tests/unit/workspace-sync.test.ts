import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../../src/lib/data/db';
import { sha256Hex } from '../../src/lib/data/files';
import { adoptGuest, adoptLegacy, selectWorkspace, workspaceName } from '../../src/lib/data/workspace';
import { createMockBackend } from '../../src/lib/backend/mock';
import type { Backend, SyncRecord } from '../../src/lib/backend/types';
import { applyRemote, collectLocal, getSyncMeta, invalidateSync, syncNow, syncStore } from '../../src/lib/sync/sync';
import { createSession, submitSession } from '../../src/lib/engine/session';
import { DEFAULT_SETTINGS, type Pack } from '../../src/lib/types';
import { doc, syntheticPaper } from '../fixtures/make';
import { answerAll, importPack, synthKey } from './helpers';

let n = 0;
let account: string;
let server: Backend;
const device = (name: string) => { invalidateSync(); store.useDbName(`workspace-sync-${n}-${name}`); };
beforeEach(async () => {
  n++;
  invalidateSync();
  server = createMockBackend();
  await server.signInEmail(`workspace-${n}@example.com`);
  account = (await server.account())!.id;
  selectWorkspace(null);
  await store.wipeAll();
});
afterEach(() => invalidateSync());

async function submitted(name = 'A') {
  device(name);
  const packId = await importPack(doc(syntheticPaper('p', 2)));
  const pack = (await store.getPack(packId))!;
  const { summary } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p' });
  await answerAll(summary.id, (_i, qid) => synthKey(qid));
  await submitSession(summary.id, false, 100);
  return { packId, sessionId: summary.id };
}

const outline = (id: string, title = id): Pack => ({ id, title, subject: '', papers: [], createdAt: 1, updatedAt: 1 });

describe('separate guest and account workspaces', () => {
  it('A → signed out guest → B never exposes private packs, progress, or settings', async () => {
    selectWorkspace(`A-${n}`);
    const packId = await importPack(doc(syntheticPaper('a', 2)));
    const { summary } = await createSession({ pack: (await store.getPack(packId))!, type: 'paper', mode: 'exam', paperId: 'a' });
    await store.putSettings({ ...DEFAULT_SETTINGS, theme: 'dark' });
    selectWorkspace(null);
    expect(await store.getPacks()).toEqual([]);
    expect(await store.getAllSessions()).toEqual([]);
    await store.putPack(outline('guest'));
    selectWorkspace(`B-${n}`);
    expect(await store.getPacks()).toEqual([]);
    expect(await store.getSession(summary.id)).toBeUndefined();
    expect((await store.getSettings()).theme).toBe('system');
    await store.putPack(outline('private-b'));
    selectWorkspace(`A-${n}`);
    expect((await store.getPacks()).map((p) => p.id)).toEqual([packId]);
    expect((await store.getSettings()).theme).toBe('dark');
    expect(await store.getSession(summary.id)).toBeDefined();
    selectWorkspace(null);
    expect((await store.getPacks()).map((p) => p.id)).toEqual(['guest']);
    expect(workspaceName('a/b')).not.toBe(workspaceName('a%2Fb'));
  });

  it('imports guest records only explicitly, preserving account records and private metadata', async () => {
    const guestId = await importPack(doc(syntheticPaper('guest-paper', 2)));
    const guestPack = (await store.getPack(guestId))!;
    const imageBlob = new Blob(['guest-image'], { type: 'image/png' });
    const imageId = await sha256Hex(await imageBlob.arrayBuffer());
    const pdfBlob = new Blob(['%PDF-guest'], { type: 'application/pdf' });
    const pdfId = await sha256Hex(await pdfBlob.arrayBuffer());
    const guestDb = await store.db();
    await guestDb.put('images', { id: imageId, blob: imageBlob, type: imageBlob.type });
    await guestDb.put('pdfs', { id: pdfId, blob: pdfBlob, name: 'guest.pdf', size: pdfBlob.size, addedAt: 1 });
    const paper = (await store.getPapers(guestId))[0]!;
    paper.questions[0]!.image = imageId;
    paper.pdf = { qp: pdfId };
    await guestDb.put('papers', paper);
    const { summary } = await createSession({ pack: guestPack, type: 'paper', mode: 'exam', paperId: 'guest-paper' });
    await answerAll(summary.id, (_i, qid) => synthKey(qid));
    await submitSession(summary.id, false, 100);
    await (await store.db()).put('meta', { account: 'guest-metadata' }, 'sync');
    await expect(adoptGuest()).rejects.toThrow('Sign in');
    selectWorkspace(`adopt-A-${n}`);
    await store.putPack(outline('private-a'));
    await store.putPack({ ...guestPack, title: 'Account title wins' });
    await (await store.db()).put('meta', { account: 'account-metadata' }, 'sync');
    expect(await store.getSession(summary.id)).toBeUndefined();
    expect(await adoptGuest()).toBeGreaterThan(0);
    expect((await store.getPack(guestId))!.title).toBe('Account title wins');
    expect(await store.getPack('private-a')).toBeDefined();
    expect(await store.getSession(summary.id)).toBeDefined();
    expect(await store.getImage(imageId)).toBeDefined();
    expect(await store.getPdf(pdfId)).toBeDefined();
    expect(await store.getStats(guestId)).toHaveLength(2);
    expect(await (await store.db()).get('meta', 'sync')).toEqual({ account: 'account-metadata' });
    expect(await adoptGuest()).toBe(0);
    selectWorkspace(`adopt-B-${n}`);
    expect(await store.getPacks()).toEqual([]);
    selectWorkspace(null);
    expect(await store.getSession(summary.id)).toBeDefined(); // copy, never a move
  });

  it('invalidates a delayed pull before it can write into the next account', async () => {
    selectWorkspace(`flight-A-${n}`);
    let release!: (page: { records: SyncRecord[]; cursor: string | null }) => void;
    let entered!: () => void;
    const called = new Promise<void>((resolve) => { entered = resolve; });
    const pull = new Promise<{ records: SyncRecord[]; cursor: string | null }>((resolve) => { release = resolve; });
    const push = vi.fn(async () => 0);
    const delayed: Backend = { ...server, syncPull: async () => { entered(); return pull; }, syncPush: push };
    const running = syncNow(delayed, account);
    await called;
    invalidateSync();
    selectWorkspace(`flight-B-${n}`);
    release({ records: [{ store: 'packs', id: 'private-a', updated_at: 1, data: outline('private-a') }], cursor: '1' });
    await running;
    expect(await store.getPacks()).toEqual([]);
    expect(await (await store.db()).get('meta', 'sync')).toBeUndefined();
    expect(push).not.toHaveBeenCalled();
    expect(syncStore.get().state).toBe('off');
  });
});

describe('complete attempt revisions and deletion propagation', () => {
  it('stages summary/detail across calls and replaces both only when a matching revision is complete', async () => {
    const { packId, sessionId } = await submitted('source');
    const rows = await collectLocal();
    const first = rows.find((r) => r.store === 'sessions')!;
    const detail = rows.find((r) => r.store === 'sessionDetail')!;
    device('receiver');
    const versions: Record<string, number> = {};
    await applyRemote([first], versions);
    expect(await store.getSession(sessionId)).toBeUndefined();
    expect(await store.getDetail(sessionId)).toBeUndefined();
    expect(await store.getStats(packId)).toEqual([]);
    await applyRemote([detail], versions);
    expect((await store.getSession(sessionId))!.correct).toBe(2);
    expect((await store.getDetail(sessionId))!.key).toEqual([1, 2]);
    const nextSummary = { ...first, updated_at: 200, data: { ...(first.data as object), updatedAt: 200, correct: 1 } };
    const nextDetail = { ...detail, updated_at: 200, data: { ...(detail.data as object), key: [0, 2] } };
    await applyRemote([nextSummary], versions);
    expect((await store.getSession(sessionId))!.correct).toBe(2);
    expect((await store.getDetail(sessionId))!.key).toEqual([1, 2]);
    expect((await store.getStats(packId)).filter((s) => s.inBank)).toHaveLength(0);
    await applyRemote([nextDetail], versions);
    expect((await store.getSession(sessionId))!.correct).toBe(1);
    expect((await store.getDetail(sessionId))!.key).toEqual([0, 2]);
    expect((await store.getStats(packId)).filter((s) => s.inBank).map((s) => s.qid)).toEqual(['p#1']);
  });

  it('propagates session and override deletion to existing and new devices', async () => {
    const { packId, sessionId } = await submitted();
    const key = `${packId}::p#1`;
    await store.putOverride({ key, packId, qid: 'p#1', note: 'delete me', updatedAt: 100 });
    await syncNow(server, account);
    device('B');
    await syncNow(server, account);
    expect(await store.getSession(sessionId)).toBeDefined();
    device('A');
    await store.deleteSession(sessionId);
    await store.deleteOverride(key);
    await syncNow(server, account);
    for (const target of ['B', 'new-device']) {
      device(target);
      await syncNow(server, account);
      expect(syncStore.get().state).toBe('idle');
      expect(await store.getSession(sessionId)).toBeUndefined();
      expect(await store.getDetail(sessionId)).toBeUndefined();
      expect(await store.getOverrides(packId)).toEqual([]);
      expect(await store.getStats(packId)).toEqual([]);
    }
  });

  it('deletes pack dependents everywhere and keeps the local-only removal option distinct', async () => {
    const { packId, sessionId } = await submitted();
    await store.putOverride({ key: `${packId}::p#1`, packId, qid: 'p#1', updatedAt: 100 });
    await syncNow(server, account);
    device('B');
    await syncNow(server, account);
    device('A');
    await store.deletePack(packId);
    await syncNow(server, account);
    for (const target of ['B', 'new-device']) {
      device(target);
      await syncNow(server, account);
      expect(await store.getPack(packId)).toBeUndefined();
      expect(await store.getSession(sessionId)).toBeUndefined();
      expect(await store.getDetail(sessionId)).toBeUndefined();
      expect(await store.getOverrides(packId)).toEqual([]);
      expect(await store.getStats(packId)).toEqual([]);
    }
    device('local-only');
    const local = await importPack(doc(syntheticPaper('local', 2)));
    await store.deletePack(local, false);
    expect((await collectLocal()).some((r) => r.deleted)).toBe(false);
  });

  it('does not acknowledge a rejected write as synced', async () => {
    device('rejected');
    await store.putPack(outline('pending'));
    const rejected: Backend = { ...server, syncPull: async (cursor) => ({ records: [], cursor }), syncPush: async () => 0 };
    await syncNow(rejected, account);
    expect(syncStore.get().state).toBe('error');
    expect((await getSyncMeta(account)).versions).toEqual({});
    expect(await collectLocal()).toHaveLength(1);
  });
});


it('uses transactional revision tracking after the first collection and tracks a later cause edit', async () => {
  const { sessionId } = await submitted();
  const rows = await collectLocal();
  const versions = Object.fromEntries(rows.map(r => [`${r.store}|${r.id}`, r.updated_at]));
  const d = await store.db();
  expect(await d.get('meta', 'sessionRevisions')).toEqual({ [sessionId]: (await store.getSession(sessionId))!.updatedAt });
  const reads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  expect(await collectLocal(versions)).toEqual([]);
  expect((reads.mock.contexts as unknown as IDBObjectStore[]).some(os => os.name === 'sessions')).toBe(false);
  reads.mockRestore();
  await store.setCause(sessionId, 'p#1', 'misread', 101);
  expect((await collectLocal(versions)).filter(r => r.id === sessionId).map(r => r.store)).toEqual(['sessions', 'sessionDetail']);
});

it('allows intentional recreation after synced override deletion without emitting a duplicate tombstone', async () => {
  const { packId } = await submitted();
  const key = `${packId}::p#1`;
  await store.putOverride({ key, packId, qid:'p#1', note:'first', updatedAt:1 });
  await syncNow(server, account);
  await store.deleteOverride(key);
  await syncNow(server, account);
  await store.putOverride({ key, packId, qid:'p#1', note:'recreated', updatedAt:1 });
  const rows = (await collectLocal()).filter(r => r.store === 'overrides' && r.id === key);
  expect(rows).toHaveLength(1); expect(rows[0]!.deleted).toBeUndefined();
  await syncNow(server, account);
  expect(syncStore.get().state).toBe('idle');
  device('fresh-recreated'); await syncNow(server, account);
  expect((await store.getOverrides(packId))[0]?.note).toBe('recreated');
});

it('keeps a marked legacy cache away from guests and other accounts until its owner recovers it', async () => {
  store.useDbName('dmc'); await store.wipeAll();
  await store.putPack(outline('legacy-private'));
  await (await store.db()).put('meta', { account:'legacy-owner' }, 'sync');
  selectWorkspace(null);
  expect(await store.getPack('legacy-private')).toBeUndefined();
  await expect(adoptLegacy(null)).rejects.toThrow('another account');
  selectWorkspace(`wrong-${n}`);
  await expect(adoptLegacy(`wrong-${n}`)).rejects.toThrow('another account');
  selectWorkspace('legacy-owner'); await store.wipeAll();
  expect(await adoptLegacy('legacy-owner')).toBeGreaterThan(0);
  expect(await store.getPack('legacy-private')).toBeDefined();
});

it('acknowledges a session-detail tombstone and rolls back an invalid remote page', async () => {
  const { sessionId } = await submitted();
  const versions: Record<string,number> = {};
  await applyRemote([{store:'sessionDetail',id:sessionId,updated_at:999,deleted:true,data:null}], versions);
  expect(versions[`sessionDetail|${sessionId}`]).toBe(999);
  await expect(applyRemote([
    {store:'packs',id:'valid-before-error',updated_at:1,data:outline('valid-before-error')},
    {store:'overrides',id:'invalid',updated_at:1,data:{bad:true}},
  ], versions)).rejects.toThrow('Invalid remote');
  expect(await store.getPack('valid-before-error')).toBeUndefined();
});
