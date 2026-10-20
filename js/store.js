// Persistence. localStorage key "mcq:v1": settings, sessions, mistakes, nickname, clientId, active session.
// IndexedDB "mcq-packs": uploaded packs as pack.json text plus asset Blobs.
// Every access is guarded; when storage fails the app keeps running in memory and says so.

const KEY = 'mcq:v1';
export const VERSION = 1;
const MAX_SESSIONS = 500;
export const CAUSES = ['concept', 'misread', 'careless'];

const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const fresh = () => ({
  v: VERSION, settings: { mode: 'exam', shuffle: false }, sessions: [], mistakes: {}, nickname: '', clientId: uid(), active: null,
});

// MIGRATIONS[n] turns version n-1 data into version n. Data without "v" is version 0.
export const MIGRATIONS = {
  1: (d) => ({ ...fresh(), ...d, settings: { ...fresh().settings, ...d.settings }, v: 1 }),
};

export function migrate(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not an mcq data object');
  let v = Number.isInteger(d.v) ? d.v : 0;
  if (v > VERSION) throw new Error(`data is from a newer version (${v}) of this app`);
  while (v < VERSION) d = MIGRATIONS[++v](d);
  if (!Array.isArray(d.sessions) || typeof d.mistakes !== 'object' || !d.mistakes) throw new Error('data is damaged');
  return d;
}

export const mistakeKey = (packId, qid) => `${packId}/${qid}`;

export function createStore(storage) {
  let data = fresh(), persistent = true, notice = '';
  const fail = (msg) => { persistent = false; notice = msg; };
  let raw = null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    fail('Browser storage is unavailable; progress will not be kept after you close this page.');
  }
  if (raw) {
    try {
      data = migrate(JSON.parse(raw));
    } catch (e) {
      notice = `Saved progress could not be read (${e.message}); a copy was kept as "${KEY}:backup" and a fresh record started.`;
      try { storage.setItem(`${KEY}:backup`, raw); } catch { fail(notice); }
    }
  }

  function save() {
    if (!persistent) return;
    try {
      storage.setItem(KEY, JSON.stringify(data));
    } catch {
      fail('Browser storage is full or blocked; progress will not be kept after you close this page.');
    }
  }

  return {
    get data() { return data; },
    get notice() { return notice; },
    update(fn) { fn(data); save(); },

    recordResult(result) {
      const { items, ...summary } = result;
      data.sessions = [...data.sessions, { ...summary, endedAt: Date.now() }].slice(-MAX_SESSIONS);
      for (const item of items.filter((i) => !i.correct)) {
        const key = mistakeKey(result.packId, item.id);
        const old = data.mistakes[key];
        data.mistakes[key] = {
          packId: result.packId, qid: item.id, selected: item.selected, answer: item.answer, rev: item.rev,
          at: Date.now(), timesWrong: (old?.timesWrong || 0) + 1, cause: old?.cause || '',
        };
      }
      data.active = null;
      save();
    },

    setCause(packId, qid, cause) {
      const m = data.mistakes[mistakeKey(packId, qid)];
      if (m) { m.cause = CAUSES.includes(cause) && m.cause !== cause ? cause : ''; save(); }
    },

    mistakesFor(packId) {
      return Object.values(data.mistakes).filter((m) => m.packId === packId)
        .sort((a, b) => b.timesWrong - a.timesWrong || b.at - a.at);
    },

    exportJSON: () => JSON.stringify(data, null, 1),

    importJSON(text) {
      data = migrate(JSON.parse(text)); // throws with a readable message on bad input
      save();
    },
  };
}

// ---- uploaded packs (IndexedDB, memory fallback)

const memoryPacks = new Map();

function request(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('mcq-packs', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('packs', { keyPath: 'id' });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('packs', mode);
      const req = fn(tx.objectStore('packs'));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

// record: {id, title, version, json, assets: {path: Blob}}. Resolves false when only kept in memory.
export async function putPack(record) {
  memoryPacks.set(record.id, record);
  try { await request('readwrite', (s) => s.put(record)); return true; } catch { return false; }
}

export async function listPacks() {
  try {
    const stored = await request('readonly', (s) => s.getAll());
    return [...new Map([...stored, ...memoryPacks.values()].map((r) => [r.id, r])).values()];
  } catch {
    return [...memoryPacks.values()];
  }
}

export async function deletePack(id) {
  memoryPacks.delete(id);
  try { await request('readwrite', (s) => s.delete(id)); } catch { /* memory copy already gone */ }
}
