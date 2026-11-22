// @vitest-environment node
// Search and the admin dashboard through the real Worker (workerd via Miniflare, real D1 and R2).
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfBytes, sha, startWorker, type Harness } from './worker-harness';

let h: Harness;
let seq = 0;
const uid = () => crypto.randomUUID();
const tag = (p: string) => `${p}${++seq}`;
const enc = new TextEncoder();

beforeAll(async () => { h = await startWorker(); }, 60_000);
afterAll(async () => { await h.dispose(); });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (r: Response): Promise<Json> => (await r.json()) as Json;
interface Who { cookie: string; id: string; handle: string; email: string }
async function user(email: string, name?: string): Promise<Who> {
  const s = await h.signIn(email, { name });
  const me = await body(await h.fetch('/api/me', { as: s.cookie }));
  return { ...s, handle: me.account.handle as string, email };
}
const school = (p: string, name?: string) => user(`${tag(p)}@stjbs.sch.id`, name);
const personal = (p: string) => user(`${tag(p)}@gmail.com`);
async function admin(p = 'sadm') {
  const email = `${tag(p)}@stjbs.sch.id`;
  await h.sql('INSERT INTO library_admins (email, added_at, added_by) VALUES (?1, 0, ?2)', email, 'test');
  return user(email);
}
/** A fresh session for an existing account (h.signIn would reset the user row). */
async function newSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await h.sql('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, absolute_expires_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?3)', createHash('sha256').update(token).digest('hex'), userId, now, now + 86_400_000, now + 2 * 86_400_000);
  return token;
}
const get = (path: string, as?: string) => h.fetch(path, { as });
const act = (as: string | undefined, id: string, b: unknown) => h.fetch(`/api/admin/users/${id}`, { method: 'POST', as, body: JSON.stringify(b) });
const audits = async (as: string) => (await body(await get('/api/admin/audit', as))).entries as Json[];

async function upload(as: string, bytes: Uint8Array, type: string): Promise<string> {
  const hash = sha(bytes);
  const r = await h.fetch(`/api/blobs/${hash}`, { method: 'PUT', as, body: bytes, headers: { 'content-type': type, 'content-length': String(bytes.byteLength) } });
  expect(r.status, `upload ${type}`).toBeLessThan(300);
  return hash;
}
async function publish(as: string, title: string): Promise<string> {
  const id = uid();
  const key = '9702_s24_qp_12';
  const pack = await upload(as, enc.encode(`{"format":"dmc-pack/1","label":"${id}"}`), 'application/json');
  const pdf = await upload(as, pdfBytes(id), 'application/pdf');
  const manifest = {
    format: 'dmc-set/1', pack, files: { [`pdfs/${key}.pdf`]: pdf },
    papers: [{ id: key, key, title: 'P12', questionCount: 40, keyed: 40, qp: pdf }],
    meta: { title, description: '', subject: 'Physics', code: '9702' },
  };
  const res = await h.fetch(`/api/sets/${id}/versions`, { method: 'POST', as, body: JSON.stringify({ base: 0, manifest }) });
  expect(res.status, await res.clone().text()).toBe(201);
  return id;
}
/** A unique, searchable word per test. */
const word = (p: string) => `${p}${++seq}zq`;
const found = async (as: string | undefined, q: string) => body(await get(`/api/search?q=${encodeURIComponent(q)}`, as));

describe('GET /api/search', () => {
  it('anonymous and non-members get empty results with status 200', async () => {
    const m = await school('s-own');
    const w = word('quokka');
    await publish(m.cookie, `${w} mechanics`);
    const g = await personal('s-g');
    for (const as of [undefined, g.cookie]) {
      const r = await get(`/api/search?q=${w}`, as);
      expect(r.status).toBe(200);
      expect(await body(r)).toEqual({ sets: [], people: [] });
    }
  });

  it('a member finds an approved set by title prefix; deleted sets never appear', async () => {
    const o = await school('s-o');
    const x = await school('s-x');
    const w = word('wombat');
    const id = await publish(o.cookie, `${w} kinematics`);
    const res = await found(x.cookie, w.slice(0, 6));
    expect((res.sets as Json[]).map((s) => s.id)).toContain(id);
    expect(res.sets.find((s: Json) => s.id === id)).toMatchObject({ title: `${w} kinematics`, subject: 'Physics' });
    expect((await found(x.cookie, `${w} kine`)).sets.map((s: Json) => s.id)).toContain(id);
    expect((await h.fetch(`/api/sets/${id}`, { method: 'DELETE', as: o.cookie })).status).toBeLessThan(300);
    expect((await found(x.cookie, w)).sets).toEqual([]);
    expect((await found(o.cookie, w)).sets).toEqual([]);
  });

  it('a hidden set is not found by another member, but is by its owner and an admin', async () => {
    const o = await school('s-ho');
    const x = await school('s-hx');
    const adm = await admin();
    const w = word('lemur');
    const id = await publish(o.cookie, `${w} optics`);
    expect((await h.fetch(`/api/sets/${id}`, { method: 'PATCH', as: adm.cookie, body: JSON.stringify({ status: 'hidden' }) })).status).toBe(200);
    expect((await found(x.cookie, w)).sets).toEqual([]);
    expect((await found(o.cookie, w)).sets.map((s: Json) => s.id)).toEqual([id]);
    expect((await found(adm.cookie, w)).sets.map((s: Json) => s.id)).toEqual([id]);
  });

  it('a renamed set is found by its new title only', async () => {
    const o = await school('s-rn');
    const x = await school('s-rx');
    const a = word('oldname');
    const b = word('newname');
    const id = await publish(o.cookie, a);
    expect((await h.fetch(`/api/sets/${id}`, { method: 'PATCH', as: o.cookie, body: JSON.stringify({ title: b }) })).status).toBe(200);
    expect((await found(x.cookie, a)).sets).toEqual([]);
    expect((await found(x.cookie, b)).sets.map((s: Json) => s.id)).toEqual([id]);
  });

  it('people: finds school profiles by name prefix, never private ones (except own and admin)', async () => {
    const w = word('Zephyra');
    const pub = await school('pp-a', `${w} Public`);
    const priv = await school('pp-b', `${w} Hidden`);
    const viewer = await school('pp-v');
    const adm = await admin();
    await h.fetch('/api/me/profile', { method: 'PATCH', as: priv.cookie, body: JSON.stringify({ visibility: 'private' }) });
    const handles = async (as: string) => ((await found(as, w.slice(0, 5))).people as Json[]).map((p) => p.handle);
    expect(await handles(viewer.cookie)).toEqual([pub.handle]);
    expect((await found(viewer.cookie, w)).people[0]).toMatchObject({ handle: pub.handle, name: `${w} Public` });
    expect((await handles(priv.cookie)).sort()).toEqual([pub.handle, priv.handle].sort());
    expect((await handles(adm.cookie)).sort()).toEqual([pub.handle, priv.handle].sort());
  });

  it('personal (non-member) accounts do not appear in people search', async () => {
    const w = word('Gizmo');
    const g = await user(`${tag('pp-g')}@gmail.com`, w);
    const v = await school('pp-gv');
    expect(g.handle).toBeTruthy();
    expect((await found(v.cookie, w)).people).toEqual([]);
  });

  it('suspended users never appear, not even to admins', async () => {
    const w = word('Suspendo');
    const s = await school('pp-s', w);
    const v = await school('pp-sv');
    const adm = await admin();
    expect((await found(v.cookie, w)).people).toHaveLength(1);
    expect((await act(adm.cookie, s.id, { action: 'suspend' })).status).toBe(200);
    expect((await found(v.cookie, w)).people).toEqual([]);
    expect((await found(adm.cookie, w)).people).toEqual([]);
  });

  it('q over 200 characters is 400; empty or punctuation-only is empty', async () => {
    const m = await school('s-len');
    expect((await get(`/api/search?q=${'a'.repeat(201)}`, m.cookie)).status).toBe(400);
    expect((await get(`/api/search?q=${'a'.repeat(200)}`, m.cookie)).status).toBe(200);
    expect(await found(m.cookie, '')).toEqual({ sets: [], people: [] });
    expect(await found(m.cookie, '"*()')).toEqual({ sets: [], people: [] });
  });
});

describe('admin routes are admin-only', () => {
  const routes: [string, string][] = [
    ['GET', '/api/admin/overview'], ['GET', '/api/admin/users'], ['GET', '/api/admin/audit'], ['GET', '/api/admin/duplicates'], ['GET', '/api/admin/gc'],
    ['POST', `/api/admin/users/${uid()}`],
  ];
  it('403 to a member, 403 to a personal account, 401 anonymous', async () => {
    const m = await school('au-m');
    const g = await personal('au-g');
    for (const [method, path] of routes) {
      const init = method === 'POST' ? { method, body: JSON.stringify({ action: 'signout' }) } : { method };
      expect((await h.fetch(path, { ...init, as: m.cookie })).status, `member ${method} ${path}`).toBe(403);
      expect((await h.fetch(path, { ...init, as: g.cookie })).status, `personal ${method} ${path}`).toBe(403);
      expect((await h.fetch(path, init)).status, `anon ${method} ${path}`).toBe(401);
    }
  });

  it('an admin gets 200 from the read routes', async () => {
    const adm = await admin();
    for (const p of ['overview', 'users', 'audit', 'duplicates', 'gc']) expect((await get(`/api/admin/${p}`, adm.cookie)).status, p).toBe(200);
  });
});

describe('overview and users', () => {
  it('overview: user totals, the 10 GB limit, 14 days of usage', async () => {
    const adm = await admin();
    await school('ov-m');
    const o = await body(await get('/api/admin/overview', adm.cookie));
    expect(o.users.total).toBeGreaterThanOrEqual(2);
    expect(o.users.members).toBeGreaterThanOrEqual(2);
    expect(o.storage.limit).toBe(10e9);
    expect(o.usage).toHaveLength(14);
    expect(o.usage[13].day).toBe(new Date().toISOString().slice(0, 10));
    expect(o.usage[0]).toEqual({ day: expect.any(String), downloads: 0, downloadBytes: 0, uploads: 0, uploadBytes: 0 });
    expect(o.sets).toMatchObject({ total: expect.any(Number) });
    expect(typeof o.openReports).toBe('number');
  });

  it('users?q= filters by email substring and returns member/admin flags', async () => {
    const adm = await admin();
    const w = word('findme');
    const m = await user(`${w}@stjbs.sch.id`);
    const g = await user(`${w}x@gmail.com`);
    const res = (await body(await get(`/api/admin/users?q=${w.toUpperCase()}`, adm.cookie))).users as Json[];
    expect(res.map((u) => u.email).sort()).toEqual([`${w}@stjbs.sch.id`, `${w}x@gmail.com`].sort());
    expect(res.find((u) => u.id === m.id)).toMatchObject({ member: 1, admin: 0, suspendedAt: null });
    expect(res.find((u) => u.id === g.id)).toMatchObject({ member: 0, admin: 0 });
    const a = (await body(await get(`/api/admin/users?q=${adm.email}`, adm.cookie))).users as Json[];
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ member: 1, admin: 1 });
    expect((await body(await get('/api/admin/users?q=no-such-person-zzz', adm.cookie))).users).toEqual([]);
    // LIKE wildcards are literal
    expect((await body(await get('/api/admin/users?q=%25', adm.cookie))).users).toEqual([]);
  });
});

describe('POST /api/admin/users/<id>', () => {
  it('suspend ends the target\'s session at once; restore lets a fresh session work', async () => {
    const adm = await admin();
    const t = await school('us-t');
    expect((await get('/api/sets', t.cookie)).status).toBe(200);
    expect((await act(adm.cookie, t.id, { action: 'suspend' })).status).toBe(200);
    expect((await get('/api/sets', t.cookie)).status).toBe(401);
    expect((await body(await get('/api/me', t.cookie))).account).toBeNull();
    // a fresh session for a suspended account is refused too
    expect((await body(await get('/api/me', await newSession(t.id)))).account).toBeNull();
    expect((await act(adm.cookie, t.id, { action: 'restore' })).status).toBe(200);
    expect((await h.sql<{ s: number | null }>('SELECT suspended_at AS s FROM users WHERE id = ?1', t.id))[0]!.s).toBeNull();
    const fresh = await newSession(t.id);
    const me = await body(await get('/api/me', fresh));
    expect(me.account.id).toBe(t.id);
    expect(me.status.member).toBe(true);
    expect((await get('/api/sets', fresh)).status).toBe(200);
  });

  it('an admin cannot suspend themselves (409) and stays signed in', async () => {
    const adm = await admin();
    expect((await act(adm.cookie, adm.id, { action: 'suspend' })).status).toBe(409);
    expect((await get('/api/admin/overview', adm.cookie)).status).toBe(200);
  });

  it('signout ends every session but does not suspend', async () => {
    const adm = await admin();
    const t = await school('us-so');
    const second = await newSession(t.id);
    expect((await get('/api/me', second)).status).toBe(200);
    expect((await act(adm.cookie, t.id, { action: 'signout' })).status).toBe(200);
    expect((await body(await get('/api/me', t.cookie))).account).toBeNull();
    expect((await body(await get('/api/me', second))).account).toBeNull();
    expect((await body(await get('/api/me', await newSession(t.id)))).account.id).toBe(t.id);
  });

  it('quota sets quota_bytes and /api/me reflects it; null resets it', async () => {
    const adm = await admin();
    const t = await school('us-q');
    expect((await body(await get('/api/me', t.cookie))).quota.limit).toBe(300 * 1024 * 1024);
    expect((await act(adm.cookie, t.id, { action: 'quota', quotaBytes: 12345678 })).status).toBe(200);
    expect((await body(await get('/api/me', t.cookie))).quota.limit).toBe(12345678);
    expect((await h.sql<{ q: number }>('SELECT quota_bytes AS q FROM users WHERE id = ?1', t.id))[0]!.q).toBe(12345678);
    expect((await act(adm.cookie, t.id, { action: 'quota', quotaBytes: -1 })).status).toBe(400);
    expect((await act(adm.cookie, t.id, { action: 'quota', quotaBytes: 11 * 1024 ** 3 })).status).toBe(400);
    expect((await act(adm.cookie, t.id, { action: 'quota', quotaBytes: null })).status).toBe(200);
    expect((await body(await get('/api/me', t.cookie))).quota.limit).toBe(300 * 1024 * 1024);
  });

  it('hide-profile makes a school profile private', async () => {
    const adm = await admin();
    const t = await school('us-hp');
    const v = await school('us-hv');
    expect((await get(`/api/profiles/${t.handle}`, v.cookie)).status).toBe(200);
    expect((await act(adm.cookie, t.id, { action: 'hide-profile' })).status).toBe(200);
    expect((await get(`/api/profiles/${t.handle}`, v.cookie)).status).toBe(404);
  });

  it('unknown action 400, bad id 400, unknown id 404, missing action 400', async () => {
    const adm = await admin();
    const t = await school('us-bad');
    expect((await act(adm.cookie, t.id, { action: 'explode' })).status).toBe(400);
    expect((await act(adm.cookie, t.id, {})).status).toBe(400);
    expect((await act(adm.cookie, 'not-a-uuid', { action: 'signout' })).status).toBe(400);
    expect((await act(adm.cookie, uid(), { action: 'signout' })).status).toBe(404);
    expect((await act(adm.cookie, t.id, { action: 'signout', extra: 1 })).status).toBe(400);
  });

  it('a suspended account stays refused for any new session', async () => {
    const adm = await admin();
    const t = await school('us-keep');
    await act(adm.cookie, t.id, { action: 'suspend' });
    for (let i = 0; i < 2; i++) expect((await get('/api/sets', await newSession(t.id))).status).toBe(401);
  });
});

describe('audit log', () => {
  it('every admin action writes a row visible in GET /api/admin/audit', async () => {
    const adm = await admin();
    const t = await school('aud-t');
    const owner = await school('aud-o');
    const email = `${tag('aud-allow')}@gmail.com`;
    const other = `${tag('aud-adm2')}@stjbs.sch.id`;
    expect((await act(adm.cookie, t.id, { action: 'suspend' })).status).toBe(200);
    expect((await act(adm.cookie, t.id, { action: 'restore' })).status).toBe(200);
    expect((await act(adm.cookie, t.id, { action: 'quota', quotaBytes: 5000 })).status).toBe(200);
    expect((await h.fetch('/api/admin/allowlist', { method: 'POST', as: adm.cookie, body: JSON.stringify({ email, note: 'guest' }) })).status).toBe(201);
    expect((await h.fetch('/api/admin/allowlist', { method: 'DELETE', as: adm.cookie, body: JSON.stringify({ email }) })).status).toBe(200);
    expect((await h.fetch('/api/admin/admins', { method: 'POST', as: adm.cookie, body: JSON.stringify({ email: other }) })).status).toBe(201);
    expect((await h.fetch('/api/admin/admins', { method: 'DELETE', as: adm.cookie, body: JSON.stringify({ email: other }) })).status).toBe(200);
    const backup = await h.fetch('/api/admin/backups', { method: 'POST', as: adm.cookie });
    expect(backup.status, await backup.clone().text()).toBe(201);
    const id = await publish(owner.cookie, word('audset'));
    expect((await h.fetch(`/api/sets/${id}`, { method: 'PATCH', as: adm.cookie, body: JSON.stringify({ status: 'hidden' }) })).status).toBe(200);

    const rows = await audits(adm.cookie);
    const has = (action: string, target: string) => rows.find((r) => r.action === action && r.target === target && r.actor === adm.email);
    expect(has('user.suspend', t.email)).toBeTruthy();
    expect(has('user.restore', t.email)).toBeTruthy();
    expect(has('user.quota', t.email)?.detail).toEqual({ quotaBytes: 5000 });
    expect(has('allowlist.add', email)).toBeTruthy();
    expect(has('allowlist.remove', email)).toBeTruthy();
    expect(has('admins.add', other)).toBeTruthy();
    expect(has('admins.remove', other)).toBeTruthy();
    expect(rows.find((r) => r.action === 'backup.run' && r.actor === adm.email)).toBeTruthy();
    expect(has('set.hidden', id)).toBeTruthy();
    expect(rows[0]!.id).toBeGreaterThan(rows[rows.length - 1]!.id);
    expect(rows.every((r) => typeof r.at === 'number')).toBe(true);
  });

  it('an owner editing their own set writes no audit row; an admin editing does', async () => {
    const adm = await admin();
    const owner = await school('aud-eo');
    const id = await publish(owner.cookie, word('editme'));
    const before = (await audits(adm.cookie)).filter((r) => r.target === id).length;
    expect((await h.fetch(`/api/sets/${id}`, { method: 'PATCH', as: owner.cookie, body: JSON.stringify({ title: word('renamed') }) })).status).toBe(200);
    expect((await audits(adm.cookie)).filter((r) => r.target === id)).toHaveLength(before);
    expect((await h.fetch(`/api/sets/${id}`, { method: 'PATCH', as: adm.cookie, body: JSON.stringify({ title: word('adminrename') }) })).status).toBe(200);
    const after = (await audits(adm.cookie)).filter((r) => r.target === id);
    expect(after).toHaveLength(before + 1);
    expect(after[0]).toMatchObject({ action: 'set.edit', actor: adm.email });
  });

  it('a failed admin action (self-suspend) writes no row', async () => {
    const adm = await admin();
    await act(adm.cookie, adm.id, { action: 'suspend' });
    expect((await audits(adm.cookie)).filter((r) => r.action === 'user.suspend' && r.target === adm.email)).toEqual([]);
  });
});

describe('POST /api/client-error', () => {
  it('increments error_daily, shown as overview.errors24h', async () => {
    const adm = await admin();
    const before = (await body(await get('/api/admin/overview', adm.cookie))).errors24h as number;
    const r = await h.fetch('/api/client-error', { method: 'POST', body: JSON.stringify({ message: 'boom for a@b.example', route: '/x?token=1', kind: 'error' }) });
    expect(r.status).toBe(202);
    let after = before;
    for (let i = 0; i < 20 && after === before; i++) {
      await new Promise((res) => setTimeout(res, 50));
      after = (await body(await get('/api/admin/overview', adm.cookie))).errors24h as number;
    }
    expect(after).toBe(before + 1);
  });

  it('rejects unknown fields', async () => {
    expect((await h.fetch('/api/client-error', { method: 'POST', body: JSON.stringify({ nope: 1 }) })).status).toBe(400);
  });
});
