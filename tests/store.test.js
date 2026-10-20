import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, migrate, MIGRATIONS, VERSION, listPacks, putPack, deletePack } from '../js/store.js';

function fakeStorage(initial = {}, { quota = Infinity, broken = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(k) { if (broken) throw new Error('SecurityError'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (broken || v.length > quota) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      map.set(k, String(v));
    },
  };
}

const result = (items, extra = {}) => ({
  packId: 'p', packVersion: '1', mode: 'exam', reason: 'manual', full: true, correct: 0, total: items.length, durationMs: 1, items, ...extra,
});

test('fresh store has defaults and persists updates', () => {
  const storage = fakeStorage();
  const store = createStore(storage);
  assert.equal(store.data.v, VERSION);
  assert.equal(store.notice, '');
  store.update((d) => { d.nickname = 'Ada'; });
  assert.equal(JSON.parse(storage.map.get('mcq:v1')).nickname, 'Ada');
  assert.equal(createStore(storage).data.nickname, 'Ada');
});

test('migration map upgrades unversioned data and keeps fields', () => {
  assert.ok(MIGRATIONS[1]);
  const d = migrate({ sessions: [{ x: 1 }], mistakes: {}, settings: { shuffle: true } });
  assert.equal(d.v, 1);
  assert.deepEqual(d.sessions, [{ x: 1 }]);
  assert.deepEqual(d.settings, { mode: 'exam', shuffle: true });
  assert.ok(d.clientId);
  assert.throws(() => migrate({ v: 99 }), /newer version/);
  assert.throws(() => migrate([]), /not an mcq data object/);
});

test('unreadable saved data is backed up, not destroyed', () => {
  const storage = fakeStorage({ 'mcq:v1': '{broken' });
  const store = createStore(storage);
  assert.match(store.notice, /could not be read/);
  assert.equal(storage.map.get('mcq:v1:backup'), '{broken');
});

test('quota failure falls back to memory with a notice', () => {
  const store = createStore(fakeStorage({}, { quota: 10 }));
  store.update((d) => { d.nickname = 'Bob'; });
  assert.match(store.notice, /full or blocked/);
  assert.equal(store.data.nickname, 'Bob'); // still works in memory
});

test('blocked storage runs in memory', () => {
  const store = createStore(fakeStorage({}, { broken: true }));
  assert.match(store.notice, /unavailable/);
  store.recordResult(result([{ id: 'q1', rev: 1, selected: null, answer: 'A', correct: false }]));
  assert.equal(store.mistakesFor('p').length, 1);
});

test('mistakes: unanswered stored with selected null, timesWrong grows, cause kept, sorted', () => {
  const store = createStore(fakeStorage());
  store.update((d) => { d.active = { some: 'session' }; });
  store.recordResult(result([
    { id: 'q1', rev: 1, selected: null, answer: 'A', correct: false },
    { id: 'q2', rev: 1, selected: 'B', answer: 'B', correct: true },
  ]));
  assert.equal(store.data.active, null);
  assert.equal(store.data.sessions.length, 1);
  assert.equal(store.data.sessions[0].items, undefined);
  store.setCause('p', 'q1', 'misread');
  store.recordResult(result([
    { id: 'q1', rev: 2, selected: 'C', answer: 'A', correct: false },
    { id: 'q3', rev: 1, selected: 'D', answer: 'A', correct: false },
  ]));
  const [first, second] = store.mistakesFor('p');
  assert.deepEqual([first.qid, first.timesWrong, first.selected, first.rev, first.cause], ['q1', 2, 'C', 2, 'misread']);
  assert.equal(second.qid, 'q3');
  store.setCause('p', 'q1', 'misread'); // same tag again clears it
  assert.equal(store.mistakesFor('p')[0].cause, '');
  store.setCause('p', 'q1', 'nonsense');
  assert.equal(store.mistakesFor('p')[0].cause, '');
});

test('export/import round trip', () => {
  const a = createStore(fakeStorage());
  a.update((d) => { d.nickname = 'Cy'; d.settings.mode = 'practice'; });
  a.recordResult(result([{ id: 'q1', rev: 1, selected: 'B', answer: 'A', correct: false }]));
  const text = a.exportJSON();
  const storage = fakeStorage();
  const b = createStore(storage);
  b.importJSON(text);
  assert.deepEqual(b.data, a.data);
  assert.deepEqual(JSON.parse(storage.map.get('mcq:v1')), a.data);
  assert.throws(() => b.importJSON('{"v": 1, "sessions": 3, "mistakes": {}}'), /damaged/);
  assert.throws(() => b.importJSON('nope'), SyntaxError);
  assert.equal(b.data.nickname, 'Cy'); // failed import leaves data alone
});

test('uploaded packs fall back to memory without IndexedDB', async () => {
  assert.equal(await putPack({ id: 'x', title: 'X', json: '{}', assets: {} }), false);
  assert.deepEqual((await listPacks()).map((r) => r.id), ['x']);
  await deletePack('x');
  assert.deepEqual(await listPacks(), []);
});
