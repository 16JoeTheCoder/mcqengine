import { openDB, type IDBPDatabase } from 'idb';
import { BackendError, SCHOOL_DOMAINS, type Account, type Backend, type LibrarySet, type LibraryStatus, type SyncRecord } from './types';

/**
 * In-browser stand-in for Supabase, used in development and end-to-end tests until a project
 * exists. It keeps its "server" in a separate IndexedDB database and applies the same access rules
 * as supabase/schema.sql (school domain or allowlist, owner-only writes, admin moderation), so the
 * app behaves the same against either. Never selected in a production build with Supabase values.
 */
const ADMINS = ['owner@stjbs.sch.id'];
const ALLOWLIST: string[] = [];
const KEY = 'dmc-mock-account';

type Row = Omit<LibrarySet, 'starred' | 'mine'>;
interface State {
  sets: Row[];
  stars: { setId: string; userId: string }[];
  reports: { setId: string; userId: string; reason: string }[];
  sync: (SyncRecord & { userId: string; seq: number })[];
  seq: number;
}

let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB('dmc-mock-server', 1, { upgrade: (d) => (d.createObjectStore('kv'), d.createObjectStore('files')) }));
async function load(): Promise<State> {
  return ((await (await db()).get('kv', 'state')) as State | undefined) ?? { sets: [], stars: [], reports: [], sync: [], seq: 0 };
}
async function save(s: State) {
  await (await db()).put('kv', s, 'state');
}

const idFor = (email: string) => `mock-${email.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
const listeners = new Set<(a: Account | null) => void>();
const current = (): Account | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Account | null;
  } catch {
    return null;
  }
};
const statusOf = (a: Account | null): LibraryStatus => {
  const e = a?.email.toLowerCase() ?? '';
  const member = !!a && a.emailVerified && (SCHOOL_DOMAINS.includes(e.split('@')[1] ?? '') || ALLOWLIST.includes(e));
  return { member, admin: member && ADMINS.includes(e) };
};
const need = (cond: boolean, msg = 'Not allowed') => {
  if (!cond) throw new BackendError(msg);
};

export function createMockBackend(): Backend {
  const me = () => {
    const a = current();
    need(!!a, 'Sign in first');
    return a!;
  };
  const member = () => {
    const a = me();
    need(statusOf(a).member, 'The Library is for school accounts');
    return a;
  };
  return {
    kind: 'mock',
    account: async () => current(),
    onAuthChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async signInGoogle() {
      throw new BackendError('Development mode: sign in with an email address');
    },
    async signInEmail(email: string) {
      const e = email.trim().toLowerCase();
      need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e), 'Enter an email address');
      const a: Account = { id: idFor(e), email: e, emailVerified: true, name: e.split('@')[0] ?? e };
      localStorage.setItem(KEY, JSON.stringify(a));
      listeners.forEach((f) => f(a));
    },
    async signOut() {
      localStorage.removeItem(KEY);
      listeners.forEach((f) => f(null));
    },
    status: async () => statusOf(current()),

    async listSets({ search, limit, offset }) {
      const a = member();
      const { admin } = statusOf(a);
      const s = await load();
      const t = search.trim().toLowerCase();
      return s.sets
        .filter((x) => x.status === 'approved' || x.owner === a.id || admin)
        .filter((x) => !t || `${x.title} ${x.description} ${x.subject} ${x.code}`.toLowerCase().includes(t))
        .sort((x, y) => y.stars - x.stars || y.createdAt.localeCompare(x.createdAt))
        .slice(offset, offset + limit)
        .map((x) => ({ ...x, starred: s.stars.some((st) => st.setId === x.id && st.userId === a.id), mine: x.owner === a.id }));
    },
    async createSet(id, m) {
      const a = member();
      const s = await load();
      need(s.sets.filter((x) => x.owner === a.id).length < 40, 'Library limit reached: 40 sets per person');
      const filePath = `${a.id}/${id}/pack.zip`;
      const coverPath = m.hasCover ? `${a.id}/${id}/cover.${m.coverExt}` : null;
      need(!!(await (await db()).get('files', `sets/${filePath}`)), 'Upload the pack file before creating the set');
      s.sets.push({ id, owner: a.id, ownerName: m.ownerName.slice(0, 80), title: m.title.slice(0, 120), description: m.description.slice(0, 1000), subject: m.subject, code: m.code, paperCount: m.paperCount, questionCount: m.questionCount, keyed: m.keyed, stars: 0, status: 'approved', reports: 0, createdAt: new Date().toISOString(), filePath, fileSize: m.fileSize, coverPath });
      await save(s);
      return { filePath, coverPath };
    },
    async upload(bucket, u, onProgress, signal, upsert = false) {
      const a = me();
      need(u.path.split('/')[0] === a.id, 'Upload into your own folder only');
      if (bucket === 'sets') {
        member();
        need(u.path.split('/').length === 3, 'Files go in <you>/<set>/');
      }
      const files = await db();
      if (!upsert) need(!(await files.get('files', `${bucket}/${u.path}`)), 'The file already exists');
      // Report progress in steps so the UI path is exercised; honour cancel between steps.
      for (let sent = 0; sent < u.blob.size; sent += Math.max(1, Math.ceil(u.blob.size / 4))) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        onProgress(sent);
        await new Promise((r) => setTimeout(r, 30));
      }
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      await files.put('files', u.blob, `${bucket}/${u.path}`);
      onProgress(u.blob.size);
    },
    async deleteSet(set) {
      const a = member();
      const s = await load();
      const row = s.sets.find((x) => x.id === set.id);
      need(!!row && (row.owner === a.id || statusOf(a).admin));
      const files = await db();
      for (const p of [row!.filePath, row!.coverPath]) if (p) await files.delete('files', `sets/${p}`);
      s.sets = s.sets.filter((x) => x.id !== set.id);
      s.stars = s.stars.filter((x) => x.setId !== set.id);
      s.reports = s.reports.filter((x) => x.setId !== set.id);
      await save(s);
    },
    async updateSet(id, patch) {
      const a = member();
      const s = await load();
      const row = s.sets.find((x) => x.id === id);
      need(!!row && (row.owner === a.id || statusOf(a).admin));
      if (patch.status !== undefined) need(statusOf(a).admin, 'Only an admin can change a set\'s status');
      Object.assign(row!, patch);
      await save(s);
    },
    async signedUrl(bucket, path) {
      const blob = await this.download(bucket, path);
      return blob ? URL.createObjectURL(blob) : null;
    },
    async download(bucket, path) {
      const a = me();
      if (bucket === 'sets') {
        member();
        const s = await load();
        const row = s.sets.find((x) => x.id === path.split('/')[1]);
        if (!row || !(row.status === 'approved' || row.owner === a.id || statusOf(a).admin)) return null;
      } else need(path.split('/')[0] === a.id);
      return ((await (await db()).get('files', `${bucket}/${path}`)) as Blob | undefined) ?? null;
    },
    async star(setId, on) {
      const a = member();
      const s = await load();
      const row = s.sets.find((x) => x.id === setId && (x.status === 'approved' || x.owner === a.id));
      need(!!row, 'No such set');
      const has = s.stars.some((x) => x.setId === setId && x.userId === a.id);
      if (on && !has) {
        s.stars.push({ setId, userId: a.id });
        row!.stars++;
      } else if (!on && has) {
        s.stars = s.stars.filter((x) => !(x.setId === setId && x.userId === a.id));
        row!.stars = Math.max(0, row!.stars - 1);
      }
      await save(s);
    },
    async report(setId, reason) {
      const a = member();
      const s = await load();
      const row = s.sets.find((x) => x.id === setId);
      need(!!row, 'No such set');
      need(!s.reports.some((x) => x.setId === setId && x.userId === a.id), 'You already reported this set');
      s.reports.push({ setId, userId: a.id, reason: reason.slice(0, 500) });
      row!.reports++;
      if (row!.reports >= 3) row!.status = 'hidden';
      await save(s);
    },
    async syncPush(records) {
      const a = me();
      need(records.length <= 500, 'At most 500 records per push');
      const s = await load();
      let n = 0;
      for (const r of records) {
        const i = s.sync.findIndex((x) => x.userId === a.id && x.store === r.store && x.id === r.id);
        if (i >= 0 && s.sync[i]!.updated_at >= r.updated_at) continue;
        const row = { ...r, userId: a.id, seq: ++s.seq };
        if (i >= 0) s.sync[i] = row;
        else s.sync.push(row);
        n++;
      }
      await save(s);
      return n;
    },
    async syncPull(cursor, limit) {
      const a = me();
      const after = Number(cursor ?? 0);
      const rows = (await load()).sync.filter((x) => x.userId === a.id && x.seq > after).sort((x, y) => x.seq - y.seq).slice(0, limit);
      return { records: rows.map(({ userId: _u, seq: _s, ...r }) => r), cursor: rows.length ? String(rows[rows.length - 1]!.seq) : cursor };
    },
  };
}
