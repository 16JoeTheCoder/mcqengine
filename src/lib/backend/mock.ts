import { openDB, type IDBPDatabase } from 'idb';
import { validateManifest, type SetManifest } from '../../../shared/manifest';
import { BackendError, SCHOOL_DOMAINS, type Account, type Backend, type LibrarySet, type LibraryStatus, type RegistryPaper, type SyncRecord } from './types';

/**
 * In-browser stand-in for the DMC Worker, used by `npm run dev` without a Worker and by the
 * end-to-end tests. Its "server" is a separate IndexedDB database and it applies the same rules
 * as worker/*.ts (school domain or allowlist, owner-only versions with a base check, files by
 * hash, admin moderation, compare-and-set sync), so the app behaves the same against either.
 * Never selected in a production build.
 */
const ADMINS = ['owner@stjbs.sch.id', 'josef.yang@stjbs.sch.id'];
const ALLOWLIST: string[] = ['teacher.helper@gmail.com'];
const KEY = 'dmc-mock-account';

type Row = Omit<LibrarySet, 'starred' | 'mine'>;
interface State {
  sets: Row[];
  versions: { setId: string; version: number; manifest: SetManifest }[];
  blobs: { hash: string; size: number; type: string; uploader: string }[];
  papers: RegistryPaper[];
  stars: { setId: string; userId: string }[];
  reports: { setId: string; userId: string; reason: string }[];
  sync: (SyncRecord & { userId: string; seq: number })[];
  seq: number;
}

let dbp: Promise<IDBPDatabase> | null = null;
// Tests reset the "server" by deleting its database: close on request so the delete can proceed.
const db = () => (dbp ??= openDB('dmc-mock-server', 2, {
  upgrade: (d) => { for (const s of ['kv', 'files']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); },
  blocking: () => { void dbp?.then((d) => d.close()); dbp = null; },
}).then((d) => { d.addEventListener('close', () => { dbp = null; }); return d; }));
const empty = (): State => ({ sets: [], versions: [], blobs: [], papers: [], stars: [], reports: [], sync: [], seq: 0 });
async function load(): Promise<State> {
  return { ...empty(), ...(((await (await db()).get('kv', 'state')) as State | undefined) ?? {}) };
}
const save = async (s: State) => void (await (await db()).put('kv', s, 'state'));

const idFor = (email: string) => `mock-${email.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
const nameFor = (email: string) => (email.split('@')[0] ?? email).split(/[._-]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') || email;
const listeners = new Set<(a: Account | null) => void>();
const current = (): Account | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Account | null;
  } catch {
    return null;
  }
};
const statusOf = (a: Account | null): LibraryStatus & { school: boolean } => {
  const e = a?.email.toLowerCase() ?? '';
  const school = !!a && a.emailVerified && SCHOOL_DOMAINS.includes(e.split('@')[1] ?? '');
  const admin = !!a && a.emailVerified && ADMINS.includes(e);
  return { member: school || admin || (!!a && ALLOWLIST.includes(e)), admin, school };
};
const need = (cond: boolean, msg = 'Not allowed', status = 403) => {
  if (!cond) throw new BackendError(msg, status);
};

export function createMockBackend(): Backend {
  const me = () => {
    const a = current();
    need(!!a, 'Sign in first', 401);
    return a!;
  };
  const member = () => {
    const a = me();
    need(statusOf(a).member, 'The Library is for school accounts');
    return a;
  };
  const readable = (r: Row, a: Account) => r.status === 'approved' || r.owner === a.id || statusOf(a).admin;
  const signIn = (email: string) => {
    const e = email.trim().toLowerCase();
    need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e), 'Enter an email address', 400);
    const prior = current();
    const a: Account = { id: idFor(e), email: e, emailVerified: true, name: prior?.email === e ? prior.name : nameFor(e) };
    localStorage.setItem(KEY, JSON.stringify(a));
    listeners.forEach((f) => f(a));
  };
  const view = (r: Row, a: Account, s: State): LibrarySet => ({ ...r, starred: s.stars.some((x) => x.setId === r.id && x.userId === a.id), mine: r.owner === a.id });

  const backend: Backend = {
    kind: 'mock',
    async me() {
      const a = current();
      const st = statusOf(a);
      return { account: a, status: { member: st.member, admin: st.admin }, syncDefault: st.school };
    },
    account: async () => current(),
    onAuthChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async signInGoogle() {
      throw new BackendError('Development mode: sign in with an email address', 400);
    },
    async signInDev(email) { signIn(email); },
    async signOut() {
      localStorage.removeItem(KEY);
      listeners.forEach((f) => f(null));
    },
    status: async () => { const s = statusOf(current()); return { member: s.member, admin: s.admin }; },
    async updateName(name) {
      const a = me();
      const n = name.trim().replace(/\s+/g, ' ');
      need(n.length >= 1 && n.length <= 80 && !/[<>]/.test(n), 'Name must be 1 to 80 characters of plain text', 400);
      localStorage.setItem(KEY, JSON.stringify({ ...a, name: n }));
      listeners.forEach((f) => f({ ...a, name: n }));
      return n;
    },

    async listSets({ search, limit, offset }) {
      const a = member();
      const s = await load();
      const t = search.trim().toLowerCase();
      return s.sets
        .filter((x) => readable(x, a) && x.version > 0)
        .filter((x) => !t || `${x.title} ${x.description} ${x.subject} ${x.code}`.toLowerCase().includes(t))
        .sort((x, y) => y.stars - x.stars || y.createdAt.localeCompare(x.createdAt))
        .slice(offset, offset + limit)
        .map((x) => view(x, a, s));
    },
    async getSet(id, version) {
      const a = member();
      const s = await load();
      const r = s.sets.find((x) => x.id === id);
      need(!!r && readable(r, a), 'This set is no longer available', 404);
      const v = s.versions.find((x) => x.setId === id && x.version === (version ?? r!.version));
      need(!!v, 'That version is no longer kept; download the latest', 404);
      return { set: view(r!, a, s), manifest: { ...v!.manifest, setId: id, version: v!.version } };
    },
    async lookupPapers(keys) {
      member();
      const s = await load();
      return s.papers.filter((p) => keys.includes(p.key));
    },
    async checkBlobs(hashes) {
      member();
      const s = await load();
      return [...new Set(hashes)].filter((h) => !s.blobs.some((b) => b.hash === h));
    },
    async uploadBlob(hash, blob, type, onProgress, signal) {
      const a = member();
      need(blob.size <= 25 * 1024 * 1024, 'Files are limited to 25 MB each', 413);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      need(digest === hash, 'The file did not match its hash. It may have changed while uploading; try again.', 400);
      if (type === 'application/pdf') need(new TextDecoder().decode(bytes.subarray(0, 4)) === '%PDF', 'The file is not a real PDF', 415);
      // Progress in steps so the UI path is exercised; honour cancel between steps.
      for (let sent = 0; sent < blob.size; sent += Math.max(1, Math.ceil(blob.size / 4))) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        onProgress(sent);
        await new Promise((r) => setTimeout(r, 20));
      }
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const s = await load();
      if (!s.blobs.some((b) => b.hash === hash)) {
        await (await db()).put('files', new Blob([bytes], { type }), `blobs/${hash}`);
        s.blobs.push({ hash, size: blob.size, type, uploader: a.id });
        await save(s);
      }
      onProgress(blob.size);
    },
    async getBlob(hash) {
      const a = member();
      const s = await load();
      const b = s.blobs.find((x) => x.hash === hash);
      if (!b) return null;
      const ok = statusOf(a).admin || b.uploader === a.id || s.versions.some((v) => {
        const r = s.sets.find((x) => x.id === v.setId);
        return r && readable(r, a) && validateManifest(v.manifest).hashes.has(hash);
      });
      if (!ok) return null;
      return ((await (await db()).get('files', `blobs/${hash}`)) as Blob | undefined) ?? null;
    },
    async blobUrl(hash) {
      const b = await backend.getBlob(hash);
      return b ? URL.createObjectURL(b) : null;
    },
    async publishVersion(setId, base, manifest) {
      const a = member();
      const { hashes } = validateManifest(manifest);
      const s = await load();
      need([...hashes].every((h) => s.blobs.some((b) => b.hash === h)), 'Some files are not uploaded yet. Resume the post.', 409);
      const row = s.sets.find((x) => x.id === setId);
      need(!row || row.owner === a.id, 'This set belongs to someone else. Post your own copy as a new set.');
      need((row?.version ?? 0) === base, row ? `Version ${row.version} was posted since you last downloaded. Update first, then post again.` : 'This set does not exist yet; post it as version 1', 409);
      if (!row) need(s.sets.filter((x) => x.owner === a.id).length < 40, 'Library limit reached: 40 sets per person');
      const version = base + 1;
      const now = new Date().toISOString();
      const bytes = [...hashes].reduce((t, h) => t + (s.blobs.find((b) => b.hash === h)?.size ?? 0), 0);
      const meta = { title: manifest.meta.title, description: manifest.meta.description, subject: manifest.meta.subject, code: manifest.meta.code || (manifest.papers.find((p) => p.key)?.key?.slice(0, 4) ?? ''), paperCount: manifest.papers.length, questionCount: manifest.papers.reduce((t, p) => t + p.questionCount, 0), keyed: manifest.papers.every((p) => p.keyed >= p.questionCount), version, bytes, coverHash: manifest.cover ?? null, updatedAt: now };
      if (row) Object.assign(row, meta);
      else s.sets.push({ id: setId, owner: a.id, ownerName: a.name, stars: 0, status: 'approved', reports: 0, createdAt: now, ...meta });
      s.versions.push({ setId, version, manifest });
      s.versions = s.versions.filter((v) => v.setId !== setId || v.version > version - 2);
      for (const p of manifest.papers) if (p.key && p.qp && !s.papers.some((x) => x.key === p.key)) s.papers.push({ key: p.key, msKey: p.key.replace('_qp_', '_ms_'), qp: p.qp, ms: p.ms ?? null, questionCount: p.questionCount });
      await save(s);
      return { version };
    },
    async deleteSet(id) {
      const a = member();
      const s = await load();
      const row = s.sets.find((x) => x.id === id);
      need(!!row && (row.owner === a.id || statusOf(a).admin));
      s.sets = s.sets.filter((x) => x.id !== id);
      s.versions = s.versions.filter((x) => x.setId !== id);
      s.stars = s.stars.filter((x) => x.setId !== id);
      s.reports = s.reports.filter((x) => x.setId !== id);
      await save(s);
    },
    async updateSet(id, patch) {
      const a = member();
      const s = await load();
      const row = s.sets.find((x) => x.id === id);
      need(!!row && (row.owner === a.id || statusOf(a).admin));
      if (patch.status !== undefined) need(statusOf(a).admin, "Only an admin can change a set's status");
      if (patch.status === 'approved' && row!.status === 'hidden') { row!.reports = 0; s.reports = s.reports.filter((x) => x.setId !== id); }
      Object.assign(row!, patch);
      await save(s);
    },
    async star(setId, on) {
      const a = member();
      const s = await load();
      const row = s.sets.find((x) => x.id === setId && readable(x, a));
      need(!!row, 'No such set', 404);
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
      need(!!row, 'No such set', 404);
      need(!s.reports.some((x) => x.setId === setId && x.userId === a.id), 'You already reported this set', 409);
      s.reports.push({ setId, userId: a.id, reason: reason.slice(0, 500) });
      row!.reports++;
      if (row!.reports >= 3) row!.status = 'hidden';
      await save(s);
    },

    async syncPush(records, expected) {
      const a = me();
      need(!expected || expected === a.id, 'Account changed. Sync stopped.', 409);
      need(records.length <= 500, 'At most 500 records per push', 400);
      const s = await load();
      let n = 0;
      for (const r of records) {
        const i = s.sync.findIndex((x) => x.userId === a.id && x.store === r.store && x.id === r.id);
        const existing = i >= 0 ? s.sync[i]! : undefined;
        if (existing && existing.updated_at === r.updated_at && !!existing.deleted === !!r.deleted && JSON.stringify(existing.data) === JSON.stringify(r.data)) { n++; continue; }
        need((existing?.updated_at ?? 0) === (r.base_updated_at ?? 0), 'Sync conflict: pull the latest records before retrying', 409);
        const row = { ...r, userId: a.id, seq: ++s.seq };
        delete row.base_updated_at;
        if (i >= 0) s.sync[i] = row;
        else s.sync.push(row);
        n++;
      }
      await save(s);
      return n;
    },
    async syncPull(cursor, limit, expected) {
      const a = me();
      need(!expected || expected === a.id, 'Account changed. Sync stopped.', 409);
      const after = Number(cursor ?? 0);
      const rows = (await load()).sync.filter((x) => x.userId === a.id && x.seq > after).sort((x, y) => x.seq - y.seq).slice(0, limit);
      return { records: rows.map(({ userId: _u, seq, ...r }) => ({ ...r, server_revision: String(seq) })), cursor: rows.length ? String(rows[rows.length - 1]!.seq) : cursor };
    },

    async putBackup(blob, onProgress) {
      const a = me();
      await (await db()).put('files', blob, `backups/${a.id}`);
      onProgress(blob.size);
    },
    async getBackup() {
      const a = me();
      return ((await (await db()).get('files', `backups/${a.id}`)) as Blob | undefined) ?? null;
    },

    async admin<T>(path0: string): Promise<T> {
      const path = path0.split('?')[0]!;
      const a = me();
      need(statusOf(a).admin, 'Admins only');
      const s = await load();
      if (path === 'storage') {
        const total = s.blobs.reduce((t, b) => t + b.size, 0);
        return { freeTierBytes: 10e9, totalBytes: total, libraryBytes: total, files: s.blobs.length, databaseBackupBytes: 0, personalBackupBytes: 0, perAccount: [] } as T;
      }
      if (path === 'moderation') return { sets: s.sets.filter((x) => x.status === 'hidden' || x.reports > 0).map((x) => ({ id: x.id, title: x.title, ownerName: x.ownerName, status: x.status, reports: x.reports, reasons: s.reports.filter((r) => r.setId === x.id).map((r) => ({ reason: r.reason })) })) } as T;
      if (path === 'backups') return { daily: [], weekly: [] } as T;
      if (path === 'downloads') return { since: new Date().toISOString().slice(0, 10), rows: [] } as T;
      if (['allowlist', 'admins', 'domains'].includes(path)) return { items: path === 'domains' ? SCHOOL_DOMAINS.map((domain) => ({ domain })) : (path === 'admins' ? ADMINS : ALLOWLIST).map((email) => ({ email })) } as T;
      throw new BackendError('Not available in development mode', 404);
    },
  };
  return backend;
}
