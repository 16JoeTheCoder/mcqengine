import { openDB, type IDBPDatabase } from 'idb';
import { validateManifest, type SetManifest } from '../../../shared/manifest';
import { FP_SAME, similarity } from '../../../shared/fingerprint';
import { BackendError, SCHOOL_DOMAINS, type Account, type Backend, type LibrarySet, type LibraryStatus, type ProfileStats, type RegistryPaper, type SyncRecord } from './types';

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
  /** Paper identity (D1 paper_prints): question paper hash, fingerprint, code. */
  prints?: { qp: string; ms: string | null; fp: string | null; label: string | null; questionCount: number }[];
  stars: { setId: string; userId: string }[];
  reports: { setId: string; userId: string; reason: string }[];
  sync: (SyncRecord & { userId: string; seq: number })[];
  seq: number;
  /** Profiles (D1 users columns), by account id. */
  profiles?: Record<string, MockProfile>;
}
interface MockProfile { id: string; email: string; name: string; handle: string; headline: string; bio: string; subjects: string[]; visibility: 'school' | 'private'; showStats: boolean; stats: ProfileStats; avatar: string | null; createdAt: number; reports: string[] }

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
  const visible = (p: MockProfile, a: Account) => p.id === a.id || statusOf(a).admin || (p.visibility === 'school' && statusOf({ ...a, email: p.email, emailVerified: true }).member);
  /** The account's profile, made from its email the first time (like the Worker's ensureHandle). */
  const profileOf = async (a: Account): Promise<MockProfile> => {
    const s = await load();
    const had = s.profiles?.[a.id];
    if (had) return { ...had, name: a.name };
    const base = (a.email.split('@')[0] ?? 'user').toLowerCase().replace(/[^a-z0-9._-]+/g, '').slice(0, 24).padEnd(3, '0');
    const taken = new Set(Object.values(s.profiles ?? {}).map((x) => x.handle));
    let handle = base;
    for (let n = 2; taken.has(handle); n++) handle = `${base}${n}`;
    const p: MockProfile = { id: a.id, email: a.email.toLowerCase(), name: a.name, handle, headline: '', bio: '', subjects: [], visibility: 'school', showStats: false, stats: {}, avatar: null, createdAt: Date.now(), reports: [] };
    s.profiles = { ...(s.profiles ?? {}), [a.id]: p };
    await save(s);
    return p;
  };
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
      const handle = a ? (await profileOf(a)).handle : undefined;
      return { account: a ? { ...a, ...(handle ? { handle } : {}) } : null, status: { member: st.member, admin: st.admin }, syncDefault: st.school };
    },
    async search(q) {
      const a = current();
      if (!a || !statusOf(a).member || !q.trim()) return { sets: [], people: [] };
      const s = await load();
      const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      const hit = (text: string) => words.every((w) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((t) => t.startsWith(w)));
      const sets = s.sets.filter((x) => readable(x, a) && x.version > 0 && hit(`${x.title} ${x.description} ${x.subject} ${x.ownerName}`)).slice(0, 20)
        .map((x) => ({ id: x.id, title: x.title, subject: x.subject, ownerName: x.ownerName, paperCount: x.paperCount, version: x.version }));
      const people = Object.values(s.profiles ?? {}).filter((p) => visible(p, a) && hit(`${p.name} ${p.handle} ${p.headline} ${p.subjects.join(' ')}`)).slice(0, 10)
        .map((p) => ({ handle: p.handle, name: p.name, headline: p.headline }));
      return { sets, people };
    },
    async profile(handle) {
      const a = member();
      await profileOf(a);
      const s = await load();
      const p = Object.values(s.profiles ?? {}).find((x) => x.handle === handle && visible(x, a));
      need(!!p, 'No such profile', 404);
      const mine = p!.id === a.id;
      const sets = s.sets.filter((x) => x.owner === p!.id && (x.status === 'approved' || mine || statusOf(a).admin) && x.version > 0);
      return {
        handle: p!.handle, name: p!.name, headline: p!.headline, bio: p!.bio, subjects: p!.subjects, avatar: p!.avatar, joined: p!.createdAt, mine,
        ...(mine || statusOf(a).admin ? { visibility: p!.visibility } : {}), showStats: p!.showStats, stats: p!.showStats || mine ? p!.stats : null,
        starsReceived: sets.filter((x) => x.status === 'approved').reduce((t, x) => t + x.stars, 0),
        sets: sets.map((x) => ({ id: x.id, title: x.title, subject: x.subject, paperCount: x.paperCount, questionCount: x.questionCount, stars: x.stars, version: x.version, updatedAt: x.updatedAt })),
      };
    },
    async updateProfile(patch) {
      const a = me();
      const p = await profileOf(a);
      const s = await load();
      if (patch.handle !== undefined) {
        const h = patch.handle.trim().toLowerCase();
        need(/^[a-z0-9][a-z0-9._-]{2,29}$/.test(h), 'Profile names use 3 to 30 letters, digits, dots, dashes or underscores', 400);
        need(!Object.values(s.profiles ?? {}).some((x) => x.handle === h && x.id !== a.id), 'That profile name is taken', 409);
        p.handle = h;
      }
      if (patch.headline !== undefined) { need(patch.headline.length <= 80, 'Headline is at most 80 characters', 400); p.headline = patch.headline.trim(); }
      if (patch.bio !== undefined) { need(patch.bio.length <= 160, 'Bio is at most 160 characters', 400); p.bio = patch.bio.trim(); }
      if (patch.subjects !== undefined) { need(patch.subjects.length <= 8, 'List at most 8 subjects', 400); p.subjects = [...new Set(patch.subjects.map((x) => x.trim()).filter(Boolean))]; }
      if (patch.visibility !== undefined) p.visibility = patch.visibility;
      if (patch.showStats !== undefined) p.showStats = patch.showStats;
      if (patch.stats !== undefined) p.stats = patch.stats;
      s.profiles = { ...(s.profiles ?? {}), [a.id]: p };
      await save(s);
      return { handle: p.handle };
    },
    async setAvatar(photo) {
      const a = me();
      const p = await profileOf(a);
      need(!photo || photo.size <= 512 * 1024, 'Photos are limited to 512 KB', 413);
      p.avatar = photo ? await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(photo); }) : null;
      const s = await load();
      s.profiles = { ...(s.profiles ?? {}), [a.id]: p };
      await save(s);
    },
    async reportProfile(handle, reason) {
      const a = member();
      const s = await load();
      const p = Object.values(s.profiles ?? {}).find((x) => x.handle === handle && visible(x, a));
      need(!!p, 'No such profile', 404);
      need(p!.id !== a.id, 'You cannot report your own profile', 400);
      p!.reports = [...new Set([...p!.reports, `${a.id}:${reason.slice(0, 500)}`])];
      await save(s);
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
    async matchPapers(asks) {
      member();
      const prints = (await load()).prints ?? [];
      return asks.map((a) => {
        const exact = a.qp ? prints.find((p) => p.qp === a.qp) : undefined;
        if (exact) return { qp: exact.qp, ms: exact.ms, questionCount: exact.questionCount, label: exact.label, how: 'file' as const, similarity: 1 };
        const best = a.fp ? prints.map((p) => [p.fp ? similarity(a.fp!, p.fp) : 0, p] as const).filter(([x]) => x >= FP_SAME).sort((x, y) => y[0] - x[0])[0] : undefined;
        if (best) return { qp: best[1].qp, ms: best[1].ms, questionCount: best[1].questionCount, label: best[1].label, how: 'text' as const, similarity: Math.round(best[0] * 100) / 100 };
        const code = a.key ? prints.find((p) => p.label === a.key && (!a.fp || !p.fp)) : undefined;
        return code ? { qp: code.qp, ms: code.ms, questionCount: code.questionCount, label: code.label, how: 'code' as const, similarity: 0 } : null;
      });
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
      s.prints ??= [];
      for (const p of manifest.papers) {
        if (!p.qp) continue;
        const had = s.prints.find((x) => x.qp === p.qp);
        if (had) { had.ms ??= p.ms ?? null; had.fp ??= p.fp ?? null; had.label ??= p.key; }
        else s.prints.push({ qp: p.qp, ms: p.ms ?? null, fp: p.fp ?? null, label: p.key, questionCount: p.questionCount });
      }
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
