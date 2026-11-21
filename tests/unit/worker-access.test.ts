// @vitest-environment node
// Port of tests/unit/rls.test.ts to the Worker: the same access rules, proven through the real
// Worker running in workerd (Miniflare) with real D1 and R2.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfBytes, sha, startWorker, type Harness } from './worker-harness';

let h: Harness;
let seq = 0;
const uid = () => crypto.randomUUID();
const tag = (p: string) => `${p}${++seq}`;
const enc = new TextEncoder();
const KEY = '9702_s24_qp_12';

beforeAll(async () => { h = await startWorker(); }, 60_000);
afterAll(async () => { await h.dispose(); });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (r: Response): Promise<Json> => (await r.json()) as Json;
const school = (p: string) => h.signIn(`${tag(p)}@stjbs.sch.id`);
const personal = (p: string) => h.signIn(`${tag(p)}@gmail.com`);
async function admin(p = 'adm') {
  const email = `${tag(p)}@stjbs.sch.id`;
  await h.sql('INSERT INTO library_admins (email, added_at, added_by) VALUES (?1, 0, ?2)', email, 'test');
  return h.signIn(email);
}
async function allowlisted(p = 'allow') {
  const email = `${tag(p)}@gmail.com`;
  await h.sql('INSERT INTO library_allowlist (email, note, added_at) VALUES (?1, ?2, 0)', email, 'test');
  return h.signIn(email);
}

async function upload(as: string, bytes: Uint8Array, type: string): Promise<string> {
  const hash = sha(bytes);
  const r = await h.fetch(`/api/blobs/${hash}`, { method: 'PUT', as, body: bytes, headers: { 'content-type': type, 'content-length': String(bytes.byteLength) } });
  expect(r.status, `upload ${type}`).toBeLessThan(300);
  return hash;
}

interface PublishOpts { id?: string; base?: number; key?: string; title?: string; label?: string; mutate?: (m: Json) => void }
/** Uploads a pack and a PDF, then posts a version. Returns the response and the hashes. */
async function publish(as: string, o: PublishOpts = {}) {
  const id = o.id ?? uid();
  const key = o.key ?? KEY;
  const label = o.label ?? id;
  const pack = await upload(as, enc.encode(`{"format":"dmc-pack/1","label":"${label}"}`), 'application/json');
  const pdf = await upload(as, pdfBytes(label), 'application/pdf');
  const manifest: Json = {
    format: 'dmc-set/1', pack, files: { [`pdfs/${key}.pdf`]: pdf },
    papers: [{ id: key, key, title: 'P12', questionCount: 40, keyed: 40, qp: pdf }],
    meta: { title: o.title ?? `Set ${label}`, description: '', subject: 'Physics', code: '9702' },
  };
  o.mutate?.(manifest);
  const res = await h.fetch(`/api/sets/${id}/versions`, { method: 'POST', as, body: JSON.stringify({ base: o.base ?? 0, manifest }) });
  return { id, res, pack, pdf, manifest };
}
const published = async (as: string, o: PublishOpts = {}) => {
  const p = await publish(as, o);
  expect(p.res.status, await p.res.clone().text()).toBe(201);
  return p;
};

describe('GET /api/me for each kind of caller', () => {
  it('anonymous: no account, not a member', async () => {
    const r = await h.fetch('/api/me');
    expect(r.status).toBe(200);
    const j = await body(r);
    expect(j.account).toBeNull();
    expect(j.status).toEqual({ member: false, admin: false });
    expect(j.syncDefault).toBeUndefined();
  });

  it('personal account: signed in, not a member, sync off by default', async () => {
    const a = await personal('me-p');
    const j = await body(await h.fetch('/api/me', { as: a.cookie }));
    expect(j.account.emailVerified).toBe(true);
    expect(j.status).toEqual({ member: false, admin: false });
    expect(j.syncDefault).toBe(false);
  });

  it('school account with hd: member, sync on by default', async () => {
    const a = await school('me-s');
    const j = await body(await h.fetch('/api/me', { as: a.cookie }));
    expect(j.status).toEqual({ member: true, admin: false });
    expect(j.syncDefault).toBe(true);
    expect(j.quota.limit).toBe(300 * 1024 * 1024);
  });

  it('school-domain email without the hd claim is not a member', async () => {
    const a = await h.signIn(`${tag('nohd')}@stjbs.sch.id`, { hd: null });
    const j = await body(await h.fetch('/api/me', { as: a.cookie }));
    expect(j.status).toEqual({ member: false, admin: false });
    expect(j.syncDefault).toBe(false);
  });

  it('school-domain email with the wrong hd claim is not a member', async () => {
    const a = await h.signIn(`${tag('wronghd')}@stjbs.sch.id`, { hd: 'evil.example' });
    expect((await body(await h.fetch('/api/me', { as: a.cookie }))).status.member).toBe(false);
  });

  it('a look-alike subdomain is not the school domain', async () => {
    const a = await h.signIn(`${tag('sub')}@evil.stjbs.sch.id`, { hd: 'evil.stjbs.sch.id' });
    expect((await body(await h.fetch('/api/me', { as: a.cookie }))).status.member).toBe(false);
  });

  it('unverified email is not a member, even at the school domain with hd', async () => {
    const a = await h.signIn(`${tag('unv')}@stjbs.sch.id`, { verified: false });
    const j = await body(await h.fetch('/api/me', { as: a.cookie }));
    expect(j.account.emailVerified).toBe(false);
    expect(j.status).toEqual({ member: false, admin: false });
  });

  it('unverified email is not a member even when allowlisted or an admin', async () => {
    const email = `${tag('unv2')}@gmail.com`;
    await h.sql('INSERT INTO library_allowlist (email, note, added_at) VALUES (?1, \'\', 0)', email);
    await h.sql('INSERT INTO library_admins (email, added_at) VALUES (?1, 0)', email);
    const a = await h.signIn(email, { verified: false });
    expect((await body(await h.fetch('/api/me', { as: a.cookie }))).status).toEqual({ member: false, admin: false });
  });

  it('allowlisted personal email: member, staff quota, sync off by default', async () => {
    const a = await allowlisted('me-al');
    const j = await body(await h.fetch('/api/me', { as: a.cookie }));
    expect(j.status).toEqual({ member: true, admin: false });
    expect(j.syncDefault).toBe(false);
    expect(j.quota.limit).toBe(2 * 1024 * 1024 * 1024);
  });

  it('admin: member and admin', async () => {
    const a = await admin('me-adm');
    const j = await body(await h.fetch('/api/me', { as: a.cookie }));
    expect(j.status).toEqual({ member: true, admin: true });
    expect(j.quota.limit).toBe(2 * 1024 * 1024 * 1024);
  });

  it('the seeded owner address is an admin when it signs in with hd', async () => {
    const a = await h.signIn('josef.yang@stjbs.sch.id');
    expect((await body(await h.fetch('/api/me', { as: a.cookie }))).status.admin).toBe(true);
  });

  it('a garbage or expired cookie is anonymous', async () => {
    expect((await body(await h.fetch('/api/me', { as: 'x'.repeat(43) }))).account).toBeNull();
    expect((await body(await h.fetch('/api/me', { as: 'nope' }))).account).toBeNull();
  });
});

describe('PATCH /api/me', () => {
  const patch = (as: string | undefined, name: unknown) => h.fetch('/api/me', { method: 'PATCH', as, body: JSON.stringify({ name }) });

  it('needs sign-in', async () => { expect((await patch(undefined, 'Ann')).status).toBe(401); });

  it('trims and collapses whitespace, then shows on /api/me', async () => {
    const a = await personal('nm');
    const r = await patch(a.cookie, '  Ann   Lee  ');
    expect(r.status).toBe(200);
    expect((await body(r)).name).toBe('Ann Lee');
    expect((await body(await h.fetch('/api/me', { as: a.cookie }))).account.name).toBe('Ann Lee');
  });

  it('allows 80 characters and rejects 81', async () => {
    const a = await personal('nm');
    expect((await patch(a.cookie, 'a'.repeat(80))).status).toBe(200);
    expect((await patch(a.cookie, 'a'.repeat(81))).status).toBe(400);
  });

  it('rejects empty, blank, non-text, markup and control characters', async () => {
    const a = await personal('nm');
    for (const bad of ['', '   ', 5, null, 'Ann <b>', '<script>', 'a\u0000b']) expect((await patch(a.cookie, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await h.fetch('/api/me', { method: 'PATCH', as: a.cookie, body: JSON.stringify({ name: 'Ok', role: 'admin' }) })).status).toBe(400);
  });
});

describe('Library routes need a signed-in member', () => {
  let owner: { cookie: string; id: string };
  let setId: string;
  let pdf: string;
  beforeAll(async () => {
    owner = await school('gate-owner');
    const p = await published(owner.cookie);
    setId = p.id; pdf = p.pdf;
  });

  const calls = (): [string, string, string, unknown?][] => [
    ['list', 'GET', '/api/sets'],
    ['get', 'GET', `/api/sets/${setId}`],
    ['get version', 'GET', `/api/sets/${setId}/versions/1`],
    ['publish', 'POST', `/api/sets/${uid()}/versions`, { base: 0, manifest: {} }],
    ['star', 'PUT', `/api/sets/${setId}/star`, { on: true }],
    ['report', 'POST', `/api/sets/${setId}/report`, { reason: 'x' }],
    ['patch', 'PATCH', `/api/sets/${setId}`, { title: 'x' }],
    ['delete', 'DELETE', `/api/sets/${setId}`],
    ['papers lookup', 'POST', '/api/papers/lookup', { keys: [KEY] }],
    ['blobs check', 'POST', '/api/blobs/check', { hashes: [pdf] }],
    ['blob put', 'PUT', `/api/blobs/${sha(pdfBytes('gate'))}`],
    ['blob get', 'GET', `/api/blob/${pdf}`],
  ];
  const run = (as: string | undefined, [, method, path, b]: [string, string, string, unknown?]) =>
    h.fetch(path, { method, as, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });

  it('anonymous callers get 401 everywhere', async () => {
    for (const c of calls()) expect((await run(undefined, c)).status, c[0]).toBe(401);
  });

  it.each([
    ['personal gmail account', async () => personal('gate-p')],
    ['school email without hd', async () => h.signIn(`${tag('gate-nohd')}@stjbs.sch.id`, { hd: null })],
    ['unverified school email', async () => h.signIn(`${tag('gate-unv')}@stjbs.sch.id`, { verified: false })],
  ])('%s gets 403 everywhere and the set stays intact', async (_n, make) => {
    const a = await make();
    for (const c of calls()) expect((await run(a.cookie, c)).status, c[0]).toBe(403);
    expect((await h.sql('SELECT latest_version, star_count, report_count, title FROM sets WHERE id = ?1', setId))[0]).toMatchObject({ latest_version: 1, star_count: 0, report_count: 0 });
  });

  it.each([
    ['allowlisted personal email', () => allowlisted('gate-al')],
    ['school member', () => school('gate-m')],
    ['admin', () => admin('gate-a')],
  ])('%s can use every library route', async (_n, make) => {
    const a = await make();
    const c = a.cookie;
    expect((await h.fetch('/api/sets', { as: c })).status).toBe(200);
    expect((await h.fetch(`/api/sets/${setId}`, { as: c })).status).toBe(200);
    expect((await h.fetch(`/api/blob/${pdf}`, { as: c })).status).toBe(200);
    expect((await h.fetch('/api/blobs/check', { method: 'POST', as: c, body: JSON.stringify({ hashes: [pdf] }) })).status).toBe(200);
    const look = await h.fetch('/api/papers/lookup', { method: 'POST', as: c, body: JSON.stringify({ keys: [KEY] }) });
    expect(look.status).toBe(200);
    expect((await h.fetch(`/api/sets/${setId}/star`, { method: 'PUT', as: c, body: JSON.stringify({ on: true }) })).status).toBe(200);
    expect((await h.fetch(`/api/sets/${setId}/report`, { method: 'POST', as: c, body: JSON.stringify({ reason: 'checking' }) })).status).toBe(201);
    const mine = await published(c);
    expect((await h.fetch(`/api/sets/${mine.id}`, { method: 'PATCH', as: c, body: JSON.stringify({ title: 'Renamed' }) })).status).toBe(200);
    expect((await h.fetch(`/api/sets/${mine.id}`, { method: 'DELETE', as: c })).status).toBe(200);
  });

  it('an allowlist entry removed later takes membership away at once', async () => {
    const a = await allowlisted('gate-rm');
    expect((await h.fetch('/api/sets', { as: a.cookie })).status).toBe(200);
    await h.sql('DELETE FROM library_allowlist');
    expect((await h.fetch('/api/sets', { as: a.cookie })).status).toBe(403);
  });
});

describe('visibility', () => {
  it('an approved set is listed and readable by every member; a hidden one only by its owner and admins', async () => {
    const owner = await school('vis-o');
    const other = await school('vis-x');
    const adm = await admin('vis-a');
    const al = await allowlisted('vis-al');
    const p = await published(owner.cookie, { title: 'Visibility probe' });
    const ids = async (as: string) => ((await body(await h.fetch('/api/sets?limit=50&search=visibility%20probe', { as }))).sets as Json[]).map((s) => s.id);

    for (const who of [owner, other, adm, al]) {
      expect(await ids(who.cookie)).toContain(p.id);
      expect((await h.fetch(`/api/sets/${p.id}`, { as: who.cookie })).status).toBe(200);
      expect((await h.fetch(`/api/blob/${p.pdf}`, { as: who.cookie })).status).toBe(200);
    }

    expect((await h.fetch(`/api/sets/${p.id}`, { method: 'PATCH', as: adm.cookie, body: JSON.stringify({ status: 'hidden' }) })).status).toBe(200);
    for (const who of [owner, adm]) {
      expect(await ids(who.cookie)).toContain(p.id);
      expect((await h.fetch(`/api/sets/${p.id}`, { as: who.cookie })).status).toBe(200);
      expect((await h.fetch(`/api/blob/${p.pdf}`, { as: who.cookie })).status).toBe(200);
    }
    for (const who of [other, al]) {
      expect(await ids(who.cookie)).not.toContain(p.id);
      expect((await h.fetch(`/api/sets/${p.id}`, { as: who.cookie })).status).toBe(404);
      expect((await h.fetch(`/api/sets/${p.id}/versions/1`, { as: who.cookie })).status).toBe(404);
      expect((await h.fetch(`/api/blob/${p.pdf}`, { as: who.cookie })).status).toBe(404);
      expect((await h.fetch(`/api/sets/${p.id}/star`, { method: 'PUT', as: who.cookie, body: JSON.stringify({ on: true }) })).status).toBe(404);
      expect((await h.fetch(`/api/sets/${p.id}/report`, { method: 'POST', as: who.cookie, body: JSON.stringify({ reason: 'x' }) })).status).toBe(404);
    }

    expect((await h.fetch(`/api/sets/${p.id}`, { method: 'PATCH', as: adm.cookie, body: JSON.stringify({ status: 'approved' }) })).status).toBe(200);
    expect(await ids(other.cookie)).toContain(p.id);
  });

  it('a set listing never shows a set without a version', async () => {
    const owner = await school('vis-empty');
    const id = uid();
    await h.sql('INSERT INTO sets (id, owner, owner_name, title, created_at, updated_at) VALUES (?1, ?2, \'x\', \'Zero version\', 1, 1)', id, owner.id);
    const list = (await body(await h.fetch('/api/sets?search=zero%20version', { as: owner.cookie }))).sets as Json[];
    expect(list).toEqual([]);
    expect((await h.fetch(`/api/sets/${id}`, { as: owner.cookie })).status).toBe(404);
  });
});

describe('publishing', () => {
  it('versions increment 1, 2, 3 and only the two newest are kept', async () => {
    const owner = await school('pub-o');
    const id = uid();
    const v1 = await publish(owner.cookie, { id, base: 0, label: `${id}-a` });
    expect(v1.res.status).toBe(201);
    expect(await body(v1.res)).toMatchObject({ setId: id, version: 1 });
    const v2 = await publish(owner.cookie, { id, base: 1, label: `${id}-b`, title: 'Second' });
    expect(await body(v2.res)).toMatchObject({ version: 2 });
    const v3 = await publish(owner.cookie, { id, base: 2, label: `${id}-c`, title: 'Third' });
    expect(await body(v3.res)).toMatchObject({ version: 3 });

    expect((await h.fetch(`/api/sets/${id}/versions/1`, { as: owner.cookie })).status).toBe(404);
    for (const v of [2, 3]) {
      const r = await h.fetch(`/api/sets/${id}/versions/${v}`, { as: owner.cookie });
      expect(r.status).toBe(200);
      expect((await body(r)).manifest).toMatchObject({ setId: id, version: v });
    }
    const latest = await body(await h.fetch(`/api/sets/${id}`, { as: owner.cookie }));
    expect(latest.set).toMatchObject({ version: 3, title: 'Third', paperCount: 1, questionCount: 40, keyed: true, mine: true });
    expect(await h.sql('SELECT version FROM set_versions WHERE set_id = ?1 ORDER BY version', id)).toEqual([{ version: 2 }, { version: 3 }]);
    // Files only version 1 used are now unreferenced; those of 2 and 3 are not.
    const orphan = await h.sql<{ orphaned_at: number | null }>('SELECT orphaned_at FROM blobs WHERE hash = ?1', v1.pdf);
    expect(orphan[0]!.orphaned_at).not.toBeNull();
    expect((await h.sql<{ orphaned_at: number | null }>('SELECT orphaned_at FROM blobs WHERE hash = ?1', v3.pdf))[0]!.orphaned_at).toBeNull();
  });

  it('a stale or invented base is refused with 409', async () => {
    const owner = await school('pub-base');
    expect((await publish(owner.cookie, { base: 1 })).res.status).toBe(409);
    const id = uid();
    await published(owner.cookie, { id });
    expect((await publish(owner.cookie, { id, base: 0, label: 'again' })).res.status).toBe(409);
    expect((await publish(owner.cookie, { id, base: 5, label: 'again2' })).res.status).toBe(409);
    expect((await h.sql('SELECT latest_version FROM sets WHERE id = ?1', id))[0]!.latest_version).toBe(1);
  });

  it('another member cannot post a version of someone else\'s set', async () => {
    const owner = await school('pub-own');
    const thief = await school('pub-thief');
    const p = await published(owner.cookie);
    const r = await publish(thief.cookie, { id: p.id, base: 1, label: 'thief', title: 'Mine now' });
    expect(r.res.status).toBe(403);
    expect((await h.sql('SELECT owner, title, latest_version FROM sets WHERE id = ?1', p.id))[0]).toMatchObject({ owner: owner.id, latest_version: 1 });
    // Not even an admin posts into someone else's set.
    const adm = await admin('pub-adm');
    expect((await publish(adm.cookie, { id: p.id, base: 1, label: 'adm' })).res.status).toBe(403);
  });

  it('records the paper registry and serves it through /api/papers/lookup', async () => {
    const owner = await school('pub-reg');
    const key = '9701_w23_qp_11';
    const first = await published(owner.cookie, { key });
    const row = (await h.sql<{ qp_hash: string; question_count: number; first_set_id: string }>('SELECT qp_hash, question_count, first_set_id FROM papers WHERE paper_key = ?1', key))[0]!;
    expect(row).toMatchObject({ qp_hash: first.pdf, question_count: 40, first_set_id: first.id });
    // A later set with the same key does not replace the registered file.
    await published(owner.cookie, { key });
    expect((await h.sql<{ qp_hash: string }>('SELECT qp_hash FROM papers WHERE paper_key = ?1', key))[0]!.qp_hash).toBe(first.pdf);

    const other = await school('pub-reg2');
    const r = await h.fetch('/api/papers/lookup', { method: 'POST', as: other.cookie, body: JSON.stringify({ keys: [key, '9999_m20_qp_21'] }) });
    expect(r.status).toBe(200);
    expect((await body(r)).papers).toEqual([{ key, msKey: '9701_w23_ms_11', qp: first.pdf, ms: null, questionCount: 40 }]);
    for (const bad of [['nope'], [5], 'x', Array.from({ length: 201 }, () => KEY)]) {
      expect((await h.fetch('/api/papers/lookup', { method: 'POST', as: other.cookie, body: JSON.stringify({ keys: bad }) })).status, JSON.stringify(bad).slice(0, 30)).toBe(400);
    }
  });

  it('refuses a manifest naming a file that was never uploaded (409), changing nothing', async () => {
    const owner = await school('pub-miss');
    const ghost = sha('never uploaded');
    const p = await publish(owner.cookie, { mutate: (m) => { m.files['pdfs/ghost.pdf'] = ghost; } });
    expect(p.res.status).toBe(409);
    expect((await body(p.res)).error).toMatch(/not uploaded/);
    expect(await h.sql('SELECT id FROM sets WHERE id = ?1', p.id)).toEqual([]);
  });

  it('refuses a paper whose qp is not in the files list (400)', async () => {
    const owner = await school('pub-qp');
    const stray = await upload(owner.cookie, pdfBytes('stray'), 'application/pdf');
    const p = await publish(owner.cookie, { mutate: (m) => { m.papers[0].qp = stray; } });
    expect(p.res.status).toBe(400);
    expect((await body(p.res)).error).toMatch(/does not list/);
    expect(await h.sql('SELECT id FROM sets WHERE id = ?1', p.id)).toEqual([]);
  });

  it('refuses malformed manifests and a pack that is not JSON', async () => {
    const owner = await school('pub-bad');
    expect((await publish(owner.cookie, { mutate: (m) => { m.format = 'dmc-set/2'; } })).res.status).toBe(400);
    expect((await publish(owner.cookie, { mutate: (m) => { m.extra = 1; } })).res.status).toBe(400);
    expect((await publish(owner.cookie, { mutate: (m) => { m.files['../evil.pdf'] = m.pack; } })).res.status).toBe(400);
    expect((await publish(owner.cookie, { mutate: (m) => { m.papers = []; } })).res.status).toBe(400);
    expect((await publish(owner.cookie, { mutate: (m) => { m.papers[0].keyed = 41; } })).res.status).toBe(400);
    const pdf = await upload(owner.cookie, pdfBytes('as-pack'), 'application/pdf');
    expect((await publish(owner.cookie, { mutate: (m) => { m.pack = pdf; } })).res.status).toBe(400);
    expect((await publish(owner.cookie, { id: 'NOT-A-UUID' })).res.status).toBe(400);
    expect((await publish(owner.cookie, { id: uid().toUpperCase() })).res.status).toBe(400);
  });

  it('limits a person to 40 sets', async () => {
    const owner = await school('pub-limit');
    for (let i = 0; i < 40; i++) {
      await h.sql('INSERT INTO sets (id, owner, owner_name, title, created_at, updated_at) VALUES (?1, ?2, \'x\', ?3, 1, 1)', uid(), owner.id, `filler ${i}`);
    }
    const p = await publish(owner.cookie);
    expect(p.res.status).toBe(403);
    expect((await body(p.res)).error).toMatch(/40 sets/);
    expect(await h.sql('SELECT id FROM sets WHERE id = ?1', p.id)).toEqual([]);
    // Existing sets can still get new versions, and someone else is unaffected.
    expect((await publish((await school('pub-limit2')).cookie)).res.status).toBe(201);
  });
});

describe('PATCH /api/sets/<id>', () => {
  const patch = (as: string, id: string, b: unknown) => h.fetch(`/api/sets/${id}`, { method: 'PATCH', as, body: JSON.stringify(b) });

  it('the owner changes title and description', async () => {
    const owner = await school('pat-o');
    const p = await published(owner.cookie);
    expect((await patch(owner.cookie, p.id, { title: '  New title ', description: ' About ' })).status).toBe(200);
    expect((await h.sql('SELECT title, description FROM sets WHERE id = ?1', p.id))[0]).toEqual({ title: 'New title', description: 'About' });
    expect((await patch(owner.cookie, p.id, { title: '' })).status).toBe(400);
    expect((await patch(owner.cookie, p.id, { title: 'x'.repeat(121) })).status).toBe(400);
    expect((await patch(owner.cookie, p.id, { star_count: 50 })).status).toBe(400);
    expect((await h.sql('SELECT star_count FROM sets WHERE id = ?1', p.id))[0]!.star_count).toBe(0);
  });

  it('another member may not, and nothing changes', async () => {
    const owner = await school('pat-o2');
    const other = await school('pat-x');
    const p = await published(owner.cookie, { title: 'Original' });
    expect((await patch(other.cookie, p.id, { title: 'Hijacked' })).status).toBe(403);
    expect((await patch(other.cookie, p.id, { status: 'hidden' })).status).toBe(403);
    expect((await h.sql('SELECT title, status FROM sets WHERE id = ?1', p.id))[0]).toEqual({ title: 'Original', status: 'approved' });
  });

  it('the owner cannot set the status, not even to approved', async () => {
    const owner = await school('pat-st');
    const p = await published(owner.cookie);
    expect((await patch(owner.cookie, p.id, { status: 'hidden' })).status).toBe(403);
    expect((await patch(owner.cookie, p.id, { status: 'approved' })).status).toBe(403);
    expect((await h.sql('SELECT status FROM sets WHERE id = ?1', p.id))[0]!.status).toBe('approved');
  });

  it('an admin sets hidden and approved, and rejects other values', async () => {
    const owner = await school('pat-ao');
    const adm = await admin('pat-adm');
    const p = await published(owner.cookie);
    expect((await patch(adm.cookie, p.id, { status: 'hidden' })).status).toBe(200);
    expect((await h.sql('SELECT status FROM sets WHERE id = ?1', p.id))[0]!.status).toBe('hidden');
    expect((await patch(adm.cookie, p.id, { status: 'deleted' })).status).toBe(400);
    expect((await patch(adm.cookie, p.id, { status: 'approved' })).status).toBe(200);
    expect((await h.sql('SELECT status FROM sets WHERE id = ?1', p.id))[0]!.status).toBe('approved');
  });

  it('restoring a hidden set clears its report count and reports', async () => {
    const owner = await school('pat-rs');
    const adm = await admin('pat-rs-adm');
    const p = await published(owner.cookie);
    for (const who of ['a', 'b', 'c']) {
      const u = await school(`pat-rs-${who}`);
      expect((await h.fetch(`/api/sets/${p.id}/report`, { method: 'POST', as: u.cookie, body: JSON.stringify({ reason: 'bad' }) })).status).toBe(201);
    }
    expect((await h.sql('SELECT status, report_count FROM sets WHERE id = ?1', p.id))[0]).toEqual({ status: 'hidden', report_count: 3 });
    expect((await patch(adm.cookie, p.id, { status: 'approved' })).status).toBe(200);
    expect((await h.sql('SELECT status, report_count FROM sets WHERE id = ?1', p.id))[0]).toEqual({ status: 'approved', report_count: 0 });
    expect(await h.sql('SELECT id FROM reports WHERE set_id = ?1', p.id)).toEqual([]);
    // The same people can report again, and it takes three new reports to hide it.
    const again = await school('pat-rs-d');
    await h.fetch(`/api/sets/${p.id}/report`, { method: 'POST', as: again.cookie, body: JSON.stringify({ reason: 'bad' }) });
    expect((await h.sql('SELECT status, report_count FROM sets WHERE id = ?1', p.id))[0]).toEqual({ status: 'approved', report_count: 1 });
  });

  it('an unknown set is 403 or 404, never a success', async () => {
    const m = await school('pat-none');
    expect([403, 404]).toContain((await patch(m.cookie, uid(), { title: 'x' })).status);
    expect((await patch(m.cookie, 'not-a-uuid', { title: 'x' })).status).toBe(400);
  });
});

describe('stars', () => {
  const star = (as: string, id: string, on: boolean) => h.fetch(`/api/sets/${id}/star`, { method: 'PUT', as, body: JSON.stringify({ on }) });
  const count = async (id: string) => (await h.sql<{ star_count: number }>('SELECT star_count FROM sets WHERE id = ?1', id))[0]!.star_count;

  it('toggling on twice counts once; off decrements; the count never goes negative', async () => {
    const owner = await school('star-o');
    const a = await school('star-a');
    const b = await school('star-b');
    const p = await published(owner.cookie);
    expect((await star(a.cookie, p.id, true)).status).toBe(200);
    expect((await star(a.cookie, p.id, true)).status).toBe(200);
    expect(await count(p.id)).toBe(1);
    expect((await star(b.cookie, p.id, true)).status).toBe(200);
    expect(await count(p.id)).toBe(2);
    const view = await body(await h.fetch(`/api/sets/${p.id}`, { as: a.cookie }));
    expect(view.set).toMatchObject({ stars: 2, starred: true });
    expect((await star(a.cookie, p.id, false)).status).toBe(200);
    expect(await count(p.id)).toBe(1);
    expect((await star(a.cookie, p.id, false)).status).toBe(200);
    expect(await count(p.id)).toBe(1);
    expect((await star(b.cookie, p.id, false)).status).toBe(200);
    expect((await star(b.cookie, p.id, false)).status).toBe(200);
    expect(await count(p.id)).toBe(0);
    expect(await h.sql('SELECT user_id FROM stars WHERE set_id = ?1', p.id)).toEqual([]);
  });

  it('rejects a non-boolean and an unknown set', async () => {
    const m = await school('star-bad');
    const p = await published(m.cookie);
    expect((await h.fetch(`/api/sets/${p.id}/star`, { method: 'PUT', as: m.cookie, body: JSON.stringify({ on: 'yes' }) })).status).toBe(400);
    expect((await star(m.cookie, uid(), true)).status).toBe(404);
  });
});

describe('reports', () => {
  const report = (as: string, id: string, reason = 'not a past paper') => h.fetch(`/api/sets/${id}/report`, { method: 'POST', as, body: JSON.stringify({ reason }) });

  it('one report per person (second is 409) and the count stays', async () => {
    const owner = await school('rep-o');
    const a = await school('rep-a');
    const p = await published(owner.cookie);
    expect((await report(a.cookie, p.id)).status).toBe(201);
    expect((await report(a.cookie, p.id, 'again')).status).toBe(409);
    expect((await h.sql('SELECT report_count, status FROM sets WHERE id = ?1', p.id))[0]).toEqual({ report_count: 1, status: 'approved' });
  });

  it('three distinct reports hide the set; the owner and admins still see it', async () => {
    const owner = await school('rep-o2');
    const adm = await admin('rep-adm');
    const p = await published(owner.cookie);
    const people = [await school('rep-1'), await school('rep-2'), await school('rep-3')];
    for (const [i, u] of people.entries()) {
      expect((await report(u.cookie, p.id)).status).toBe(201);
      expect((await h.sql('SELECT status FROM sets WHERE id = ?1', p.id))[0]!.status).toBe(i < 2 ? 'approved' : 'hidden');
    }
    expect((await h.fetch(`/api/sets/${p.id}`, { as: people[0]!.cookie })).status).toBe(404);
    expect((await h.fetch(`/api/sets/${p.id}`, { as: owner.cookie })).status).toBe(200);
    expect((await h.fetch(`/api/sets/${p.id}`, { as: adm.cookie })).status).toBe(200);
    const mod = await body(await h.fetch('/api/admin/moderation', { as: adm.cookie }));
    const row = (mod.sets as Json[]).find((s) => s.id === p.id)!;
    expect(row).toMatchObject({ status: 'hidden', reports: 3 });
    expect(row.reasons).toHaveLength(3);
  });

  it('needs a reason of 1 to 500 characters', async () => {
    const m = await school('rep-bad');
    const p = await published((await school('rep-bad-o')).cookie);
    expect((await report(m.cookie, p.id, '')).status).toBe(400);
    expect((await report(m.cookie, p.id, '   ')).status).toBe(400);
    expect((await report(m.cookie, p.id, 'x'.repeat(501))).status).toBe(400);
    expect((await report(m.cookie, p.id, 'x'.repeat(500))).status).toBe(201);
  });
});

describe('DELETE /api/sets/<id>', () => {
  const del = (as: string, id: string) => h.fetch(`/api/sets/${id}`, { method: 'DELETE', as });

  it('the owner deletes; the set, its versions and stars go, and its files become orphans', async () => {
    const owner = await school('del-o');
    const p = await published(owner.cookie);
    const fan = await school('del-fan');
    await h.fetch(`/api/sets/${p.id}/star`, { method: 'PUT', as: fan.cookie, body: JSON.stringify({ on: true }) });
    const before = await h.sql<{ hash: string; orphaned_at: number | null }>('SELECT hash, orphaned_at FROM blobs WHERE hash IN (?1, ?2)', p.pack, p.pdf);
    expect(before.map((r) => r.orphaned_at)).toEqual([null, null]);
    const t0 = Date.now();
    expect((await del(owner.cookie, p.id)).status).toBe(200);
    expect(await h.sql('SELECT id FROM sets WHERE id = ?1', p.id)).toEqual([]);
    expect(await h.sql('SELECT version FROM set_versions WHERE set_id = ?1', p.id)).toEqual([]);
    expect(await h.sql('SELECT hash FROM blob_refs WHERE set_id = ?1', p.id)).toEqual([]);
    expect(await h.sql('SELECT user_id FROM stars WHERE set_id = ?1', p.id)).toEqual([]);
    const after = await h.sql<{ orphaned_at: number | null }>('SELECT orphaned_at FROM blobs WHERE hash IN (?1, ?2)', p.pack, p.pdf);
    expect(after).toHaveLength(2);
    for (const r of after) expect(r.orphaned_at).toBeGreaterThanOrEqual(t0);
    expect((await h.fetch(`/api/sets/${p.id}`, { as: owner.cookie })).status).toBe(404);
    expect((await del(owner.cookie, p.id)).status).toBe(404);
  });

  it('another member may not delete', async () => {
    const owner = await school('del-o2');
    const other = await school('del-x');
    const p = await published(owner.cookie);
    expect((await del(other.cookie, p.id)).status).toBe(403);
    expect(await h.sql('SELECT id FROM sets WHERE id = ?1', p.id)).toHaveLength(1);
    expect((await h.sql<{ orphaned_at: number | null }>('SELECT orphaned_at FROM blobs WHERE hash = ?1', p.pdf))[0]!.orphaned_at).toBeNull();
  });

  it('an admin may delete anyone\'s set', async () => {
    const owner = await school('del-o3');
    const adm = await admin('del-adm');
    const p = await published(owner.cookie);
    expect((await del(adm.cookie, p.id)).status).toBe(200);
    expect(await h.sql('SELECT id FROM sets WHERE id = ?1', p.id)).toEqual([]);
  });

  it('a file shared with another set is not orphaned', async () => {
    const owner = await school('del-sh');
    const a = await published(owner.cookie, { label: 'shared-file' });
    const b = await published(owner.cookie, { label: 'shared-file' });
    expect(b.pdf).toBe(a.pdf);
    expect((await del(owner.cookie, a.id)).status).toBe(200);
    expect((await h.sql<{ orphaned_at: number | null }>('SELECT orphaned_at FROM blobs WHERE hash = ?1', a.pdf))[0]!.orphaned_at).toBeNull();
  });
});

describe('admin routes', () => {
  const gets = ['/api/admin/storage', '/api/admin/downloads', '/api/admin/moderation', '/api/admin/backups', '/api/admin/allowlist', '/api/admin/admins', '/api/admin/domains'];
  const lists = ['allowlist', 'admins', 'domains'];

  it('are 401 anonymous, 403 for non-admins (even members), 200 for admins', async () => {
    const adm = await admin('adm-r');
    const member = await school('adm-m');
    const al = await allowlisted('adm-al');
    const p = await personal('adm-p');
    for (const path of gets) {
      expect((await h.fetch(path)).status, path).toBe(401);
      for (const who of [member, al, p]) expect((await h.fetch(path, { as: who.cookie })).status, path).toBe(403);
      expect((await h.fetch(path, { as: adm.cookie })).status, path).toBe(200);
    }
    for (const l of lists) {
      for (const method of ['POST', 'DELETE']) {
        const b = JSON.stringify(l === 'domains' ? { domain: 'x.example' } : { email: 'x@example.com' });
        expect((await h.fetch(`/api/admin/${l}`, { method, body: b })).status, `${method} ${l}`).toBe(401);
        expect((await h.fetch(`/api/admin/${l}`, { method, as: member.cookie, body: b })).status, `${method} ${l}`).toBe(403);
      }
    }
    expect((await h.fetch('/api/admin/backups', { method: 'POST', as: member.cookie })).status).toBe(403);
    expect((await h.fetch('/api/admin/backups', { method: 'POST' })).status).toBe(401);
  });

  it('a non-admin cannot grant themselves anything', async () => {
    const p = await personal('adm-self');
    const email = (await body(await h.fetch('/api/me', { as: p.cookie }))).account.email as string;
    expect((await h.fetch('/api/admin/allowlist', { method: 'POST', as: p.cookie, body: JSON.stringify({ email }) })).status).toBe(403);
    expect((await h.fetch('/api/admin/admins', { method: 'POST', as: p.cookie, body: JSON.stringify({ email }) })).status).toBe(403);
    expect(await h.sql('SELECT email FROM library_allowlist WHERE email = ?1', email)).toEqual([]);
    expect(await h.sql('SELECT email FROM library_admins WHERE email = ?1', email)).toEqual([]);
  });

  it('adding an allowlist email makes that personal account a member on its next request; removing undoes it', async () => {
    const adm = await admin('adm-al');
    const teacher = await personal('teacher');
    const email = (await body(await h.fetch('/api/me', { as: teacher.cookie }))).account.email as string;
    expect((await body(await h.fetch('/api/me', { as: teacher.cookie }))).status.member).toBe(false);
    expect((await h.fetch('/api/sets', { as: teacher.cookie })).status).toBe(403);
    expect((await h.fetch('/api/admin/allowlist', { method: 'POST', as: adm.cookie, body: JSON.stringify({ email: email.toUpperCase(), note: 'visiting teacher' }) })).status).toBe(201);
    expect((await body(await h.fetch('/api/me', { as: teacher.cookie }))).status).toEqual({ member: true, admin: false });
    expect((await h.fetch('/api/sets', { as: teacher.cookie })).status).toBe(200);
    const items = (await body(await h.fetch('/api/admin/allowlist', { as: adm.cookie }))).items as Json[];
    expect(items.find((i) => i.email === email)).toMatchObject({ note: 'visiting teacher' });
    expect((await h.fetch('/api/admin/allowlist', { method: 'DELETE', as: adm.cookie, body: JSON.stringify({ email }) })).status).toBe(200);
    expect((await body(await h.fetch('/api/me', { as: teacher.cookie }))).status.member).toBe(false);
  });

  it('validates what it is given', async () => {
    const adm = await admin('adm-val');
    const post = (l: string, b: unknown) => h.fetch(`/api/admin/${l}`, { method: 'POST', as: adm.cookie, body: JSON.stringify(b) });
    expect((await post('allowlist', { email: 'not an email' })).status).toBe(400);
    expect((await post('allowlist', { email: 'a@b.example', note: 'x'.repeat(201) })).status).toBe(400);
    expect((await post('allowlist', { email: 'a@b.example', extra: 1 })).status).toBe(400);
    expect((await post('domains', { domain: 'localhost' })).status).toBe(400);
    expect((await post('domains', { domain: 'a b.example' })).status).toBe(400);
  });

  it('admins cannot remove themselves (409) but can remove another admin', async () => {
    const a1 = await admin('adm-1');
    const a2 = await admin('adm-2');
    const e1 = (await body(await h.fetch('/api/me', { as: a1.cookie }))).account.email as string;
    const e2 = (await body(await h.fetch('/api/me', { as: a2.cookie }))).account.email as string;
    const del = (as: string, email: string) => h.fetch('/api/admin/admins', { method: 'DELETE', as, body: JSON.stringify({ email }) });
    expect((await del(a1.cookie, e1)).status).toBe(409);
    expect(await h.sql('SELECT email FROM library_admins WHERE email = ?1', e1)).toHaveLength(1);
    expect((await del(a1.cookie, e2)).status).toBe(200);
    expect((await body(await h.fetch('/api/me', { as: a2.cookie }))).status.admin).toBe(false);
    expect((await h.fetch('/api/admin/storage', { as: a2.cookie })).status).toBe(403);
    // Adding an admin through the API works too.
    const add = await h.fetch('/api/admin/admins', { method: 'POST', as: a1.cookie, body: JSON.stringify({ email: e2 }) });
    expect(add.status).toBe(201);
    expect((await body(await h.fetch('/api/me', { as: a2.cookie }))).status.admin).toBe(true);
  });

  it('domains: adding a domain admits its Workspace accounts, and still needs the hd claim', async () => {
    const adm = await admin('adm-dom');
    const domain = `college${++seq}.example`;
    const teacher = await h.signIn(`t@${domain}`, { hd: domain });
    const noHd = await h.signIn(`u@${domain}`, { hd: null });
    expect((await body(await h.fetch('/api/me', { as: teacher.cookie }))).status.member).toBe(false);
    expect((await h.fetch('/api/admin/domains', { method: 'POST', as: adm.cookie, body: JSON.stringify({ domain: `@${domain.toUpperCase()}` }) })).status).toBe(201);
    expect((await body(await h.fetch('/api/me', { as: teacher.cookie }))).status.member).toBe(true);
    expect((await body(await h.fetch('/api/me', { as: noHd.cookie }))).status.member).toBe(false);
    expect(((await body(await h.fetch('/api/admin/domains', { as: adm.cookie }))).items as Json[]).map((i) => i.domain)).toContain(domain);
    expect((await h.fetch('/api/admin/domains', { method: 'DELETE', as: adm.cookie, body: JSON.stringify({ domain }) })).status).toBe(200);
    expect((await body(await h.fetch('/api/me', { as: teacher.cookie }))).status.member).toBe(false);
  });

  it('storage and downloads report real figures', async () => {
    const adm = await admin('adm-fig');
    const m = await school('adm-fig-m');
    const p = await published(m.cookie);
    await h.fetch(`/api/blob/${p.pdf}`, { as: adm.cookie });
    const s = await body(await h.fetch('/api/admin/storage', { as: adm.cookie }));
    expect(s.files).toBeGreaterThanOrEqual(2);
    expect((s.perAccount as Json[]).find((a) => a.user_id === m.id)).toMatchObject({ files: 2 });
    const d = await body(await h.fetch('/api/admin/downloads?days=1', { as: adm.cookie }));
    expect(Array.isArray(d.rows)).toBe(true);
  });
});

describe('sync', () => {
  interface Rec { store: string; id: string; updated_at: number; base_updated_at: number; deleted?: boolean; data?: unknown }
  const pushAs = (as: string | undefined, records: Rec[]) => h.fetch('/api/sync/push', { method: 'POST', as, body: JSON.stringify({ records }) });
  const pull = (as: string | undefined, q = '') => h.fetch(`/api/sync/pull${q}`, { as });
  const pack = (id: string, at: number, base = 0, extra: Json = {}): Rec => ({ store: 'packs', id, updated_at: at, base_updated_at: base, data: { id, title: id, ...extra } });
  const session = (id: string, packId: string, at: number, base = 0, extra: Json = {}): Rec => ({
    store: 'sessions', id, updated_at: at, base_updated_at: base,
    data: { id, packId, status: 'submitted', type: 'paper', mode: 'exam', total: 10, answered: 5, correct: 3, ...extra },
  });
  const records = async (as: string, q = '') => (await body(await pull(as, q))).records as Json[];

  it('needs sign-in but not membership', async () => {
    expect((await pushAs(undefined, [pack('p', 1)])).status).toBe(401);
    expect((await pull(undefined)).status).toBe(401);
    const p = await personal('sync-p');
    const nohd = await h.signIn(`${tag('sync-nohd')}@stjbs.sch.id`, { hd: null });
    const unv = await h.signIn(`${tag('sync-unv')}@stjbs.sch.id`, { verified: false });
    for (const who of [p, nohd, unv]) {
      expect((await pushAs(who.cookie, [pack('p1', 1)])).status).toBe(200);
      expect((await records(who.cookie)).map((r) => r.id)).toEqual(['p1']);
    }
  });

  it('a user never sees another user\'s records', async () => {
    const a = await personal('sync-a');
    const b = await personal('sync-b');
    expect(await (await pushAs(a.cookie, [pack('pa', 10), session('sa', 'pa', 10)])).json()).toEqual({ accepted: 2 });
    expect(await records(b.cookie)).toEqual([]);
    expect((await body(await pull(b.cookie))).cursor).toBeNull();
    expect((await pushAs(b.cookie, [pack('pb', 10)])).status).toBe(200);
    expect((await records(b.cookie)).map((r) => r.id)).toEqual(['pb']);
    expect((await records(a.cookie)).map((r) => r.id).sort()).toEqual(['pa', 'sa']);
    // The same record id in two accounts is two records.
    expect((await pushAs(b.cookie, [pack('pa', 5)])).status).toBe(200);
    expect(((await records(a.cookie)).find((r) => r.id === 'pa') as Json).updated_at).toBe(10);
  });

  it('is compare-and-set: a stale base is 409 and writes nothing', async () => {
    const a = await personal('sync-cas');
    expect((await pushAs(a.cookie, [pack('p', 100)])).status).toBe(200);
    expect((await pushAs(a.cookie, [pack('p', 200, 0, { v: 2 })])).status).toBe(409);
    expect((await pushAs(a.cookie, [pack('p', 200, 50, { v: 2 })])).status).toBe(409);
    expect((await pushAs(a.cookie, [pack('new', 200, 7)])).status).toBe(409);
    expect((await pushAs(a.cookie, [pack('p', 200, 100, { v: 2 })])).status).toBe(200);
    const rows = await records(a.cookie);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'p', updated_at: 200, data: { v: 2 } });
    // Same version number with a different payload needs a new version.
    expect((await pushAs(a.cookie, [pack('p', 200, 200, { v: 3 })])).status).toBe(409);
  });

  it('a conflicting record rolls back the whole push', async () => {
    const a = await personal('sync-roll');
    await pushAs(a.cookie, [pack('p', 100)]);
    expect((await pushAs(a.cookie, [pack('fresh', 1), pack('p', 300, 99)])).status).toBe(409);
    expect((await records(a.cookie)).map((r) => r.id)).toEqual(['p']);
  });

  it('accepts an identical retry (a lost response) even with its old base', async () => {
    const a = await personal('sync-retry');
    const r1 = [pack('p', 100), session('s', 'p', 100)];
    expect((await pushAs(a.cookie, r1)).status).toBe(200);
    const again = await pushAs(a.cookie, r1);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ accepted: 2 });
    const upd = pack('p', 200, 100, { v: 2 });
    expect((await pushAs(a.cookie, [upd])).status).toBe(200);
    expect((await pushAs(a.cookie, [upd])).status).toBe(200);
    expect(await records(a.cookie)).toHaveLength(2);
    // A retry does not produce a second revision.
    const revs = (await records(a.cookie)).map((r) => r.server_revision);
    expect(new Set(revs).size).toBe(2);
  });

  it('deleting a pack tombstones its dependent records, and stale devices cannot revive them', async () => {
    const a = await personal('sync-del');
    await pushAs(a.cookie, [pack('p1', 10), session('s1', 'p1', 10), pack('keep', 10), session('s2', 'keep', 10)]);
    await pushAs(a.cookie, [{ store: 'questionStats', id: 'q1', updated_at: 10, base_updated_at: 0, data: { key: 'q1', packId: 'p1', n: 1 } }]);
    const cursor = (await body(await pull(a.cookie))).cursor as string;
    expect((await pushAs(a.cookie, [{ store: 'packs', id: 'p1', updated_at: 20, base_updated_at: 10, deleted: true }])).status).toBe(200);
    const changed = await records(a.cookie, `?after=${cursor}`);
    expect(changed.map((r) => `${r.store}/${r.id}`).sort()).toEqual(['packs/p1', 'questionStats/q1', 'sessions/s1']);
    for (const r of changed) expect(r).toMatchObject({ deleted: true, data: null });
    const all = await records(a.cookie);
    expect(all.find((r) => r.id === 's2')).toMatchObject({ deleted: false });
    expect(all.find((r) => r.id === 'keep')).toMatchObject({ deleted: false });
    // A stale device pushing a dependent of the deleted pack is refused.
    expect((await pushAs(a.cookie, [session('s9', 'p1', 30)])).status).toBe(409);
  });

  it('deleting a session also tombstones its detail', async () => {
    const a = await personal('sync-sd');
    const detail: Rec = { store: 'sessionDetail', id: 's1', updated_at: 10, base_updated_at: 0, data: { id: 's1', packId: 'p', questionIds: ['q1'], answers: [null] } };
    await pushAs(a.cookie, [pack('p', 10), session('s1', 'p', 10), detail]);
    expect((await pushAs(a.cookie, [{ store: 'sessions', id: 's1', updated_at: 20, base_updated_at: 10, deleted: true }])).status).toBe(200);
    const rows = await records(a.cookie);
    expect(rows.find((r) => r.store === 'sessionDetail')).toMatchObject({ deleted: true });
  });

  it('settings must have the id "settings"', async () => {
    const a = await personal('sync-set');
    const s = (id: string, extra: Partial<Rec> = {}): Rec => ({ store: 'settings', id, updated_at: 1, base_updated_at: 0, data: { theme: 'dark' }, ...extra });
    expect((await pushAs(a.cookie, [s('other')])).status).toBe(400);
    expect((await pushAs(a.cookie, [s('other', { deleted: true, data: undefined })])).status).toBe(400);
    expect((await pushAs(a.cookie, [s('settings')])).status).toBe(200);
    expect((await records(a.cookie)).map((r) => r.id)).toEqual(['settings']);
  });

  it('only finished sessions with a sane summary sync', async () => {
    const a = await personal('sync-fin');
    for (const [label, extra] of [
      ['in progress', { status: 'in-progress' }], ['no status', { status: undefined }], ['answered > total', { answered: 11 }],
      ['correct > answered', { correct: 6 }], ['total 0', { total: 0 }], ['bad type', { type: 'weird' }], ['bad mode', { mode: 'cheat' }],
    ] as [string, Json][]) {
      expect((await pushAs(a.cookie, [session('s', 'p', 10, 0, extra)])).status, label).toBe(400);
    }
    expect((await pushAs(a.cookie, [session('s', 'p', 10, 0, { status: 'auto-submitted' })])).status).toBe(200);
  });

  it('rejects malformed records without writing anything', async () => {
    const a = await personal('sync-bad');
    const bad: unknown[] = [
      { ...pack('p', 1), store: 'nope' }, { ...pack('p', 1), extra: 1 }, { ...pack('p', 1), id: '' }, { ...pack('p', 1), id: 'x'.repeat(301) },
      { ...pack('p', 0) }, { ...pack('p', 1), base_updated_at: -1 }, { ...pack('p', 1), updated_at: 1.5 }, { store: 'packs', id: 'p', updated_at: 1, base_updated_at: 0 },
      pack('p', 1, 0, {}), { ...pack('p', 1), data: { id: 'different' } }, session('s', '', 1), 'text', null,
      { store: 'overrides', id: 'k', updated_at: 1, base_updated_at: 0, data: { key: 'other', packId: 'p' } },
      { store: 'sessionDetail', id: 'd', updated_at: 1, base_updated_at: 0, data: { id: 'd', packId: 'p', questionIds: ['a'], answers: [] } },
    ];
    for (const [i, rec] of bad.entries()) {
      if (i === 8) continue; // a plain valid pack; kept to keep indexes readable
      expect((await h.fetch('/api/sync/push', { method: 'POST', as: a.cookie, body: JSON.stringify({ records: [rec] }) })).status, JSON.stringify(rec)).toBe(400);
    }
    expect((await pushAs(a.cookie, [pack('d', 1), pack('d', 2)])).status).toBe(400);
    expect((await h.fetch('/api/sync/push', { method: 'POST', as: a.cookie, body: JSON.stringify({ records: Array.from({ length: 501 }, (_, i) => pack(`p${i}`, 1)) }) })).status).toBe(400);
    expect((await h.fetch('/api/sync/push', { method: 'POST', as: a.cookie, body: JSON.stringify({ nope: [] }) })).status).toBe(400);
    expect(await records(a.cookie)).toEqual([]);
  });

  it('pages with a cursor of increasing server revisions, without loss or repeats', async () => {
    const a = await personal('sync-page');
    const ids = Array.from({ length: 7 }, (_, i) => `p${i}`);
    expect((await pushAs(a.cookie, ids.map((id) => pack(id, 1)))).status).toBe(200);
    const seen: string[] = [];
    const revs: number[] = [];
    let cursor = '';
    for (let guard = 0; guard < 10; guard++) {
      const page = await body(await pull(a.cookie, `?limit=3${cursor ? `&after=${cursor}` : ''}`));
      const recs = page.records as Json[];
      if (!recs.length) { expect(page.cursor).toBe(cursor || null); break; }
      expect(recs.length).toBeLessThanOrEqual(3);
      for (const r of recs) { seen.push(r.id); revs.push(Number(r.server_revision)); expect(typeof r.server_revision).toBe('string'); }
      expect(page.cursor).toBe(recs[recs.length - 1]!.server_revision);
      cursor = page.cursor;
    }
    expect(seen.sort()).toEqual(ids);
    expect(revs).toEqual([...revs].sort((x, y) => x - y));
    expect(new Set(revs).size).toBe(revs.length);
    // A later change appears after the cursor, with a higher revision.
    await pushAs(a.cookie, [pack('p0', 2, 1, { v: 2 })]);
    const next = await records(a.cookie, `?after=${cursor}`);
    expect(next.map((r) => r.id)).toEqual(['p0']);
    expect(Number(next[0]!.server_revision)).toBeGreaterThan(Number(cursor));
  });

  it('stops when X-DMC-Account names a different account (409), on push and pull', async () => {
    const a = await personal('sync-acct');
    const b = await personal('sync-acct2');
    const hdr = { 'x-dmc-account': b.id };
    const r = await h.fetch('/api/sync/push', { method: 'POST', as: a.cookie, headers: hdr, body: JSON.stringify({ records: [pack('p', 1)] }) });
    expect(r.status).toBe(409);
    expect((await h.fetch('/api/sync/pull', { as: a.cookie, headers: hdr })).status).toBe(409);
    expect(await records(a.cookie)).toEqual([]);
    const ok = { 'x-dmc-account': a.id };
    expect((await h.fetch('/api/sync/push', { method: 'POST', as: a.cookie, headers: ok, body: JSON.stringify({ records: [pack('p', 1)] }) })).status).toBe(200);
    expect((await h.fetch('/api/sync/pull', { as: a.cookie, headers: ok })).status).toBe(200);
    expect((await h.fetch('/api/sync/pull', { headers: ok })).status).toBe(401);
  });

  it('validates the cursor and page size', async () => {
    const a = await personal('sync-cur');
    for (const q of ['?after=abc', '?after=-1', '?after=1.5', '?limit=0', '?limit=501', '?limit=x']) expect((await pull(a.cookie, q)).status, q).toBe(400);
    expect((await pull(a.cookie, '?after=&limit=500')).status).toBe(200);
  });
});

describe('request hygiene', () => {
  it('rejects a state-changing request without the X-DMC header (403)', async () => {
    const a = await school('csrf-1');
    const r = await h.fetch('/api/me', { method: 'PATCH', as: a.cookie, headers: { 'x-dmc': '0' }, body: JSON.stringify({ name: 'Hacker' }) });
    expect(r.status).toBe(403);
    const r2 = await h.fetch('/api/sync/push', { method: 'POST', as: a.cookie, headers: { 'x-dmc': '' }, body: JSON.stringify({ records: [] }) });
    expect(r2.status).toBe(403);
    expect((await body(await h.fetch('/api/me', { as: a.cookie }))).account.name).not.toBe('Hacker');
  });

  it('rejects a cross-origin request (403) even with the header', async () => {
    const a = await school('csrf-2');
    const mk = (headers: Record<string, string>) => h.fetch('/api/me', { method: 'PATCH', as: a.cookie, headers, body: JSON.stringify({ name: 'Hacker' }) });
    expect((await mk({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await mk({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await body(await h.fetch('/api/me', { as: a.cookie }))).account.name).not.toBe('Hacker');
    expect((await mk({ origin: 'http://localhost' })).status).toBe(200);
  });

  it('applies to deletes and uploads too, and never blocks reads', async () => {
    const a = await school('csrf-3');
    const p = await published(a.cookie);
    expect((await h.fetch(`/api/sets/${p.id}`, { method: 'DELETE', as: a.cookie, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const bytes = pdfBytes('csrf');
    expect((await h.fetch(`/api/blobs/${sha(bytes)}`, { method: 'PUT', as: a.cookie, body: bytes, headers: { origin: 'https://evil.example', 'content-type': 'application/pdf', 'content-length': String(bytes.length) } })).status).toBe(403);
    expect(await h.sql('SELECT id FROM sets WHERE id = ?1', p.id)).toHaveLength(1);
    expect((await h.fetch(`/api/sets/${p.id}`, { as: a.cookie, headers: { origin: 'https://evil.example' } })).status).toBe(200);
  });

  it('answers an unknown route with 404 JSON and a wrong method with 405 and Allow', async () => {
    const a = await school('route');
    const nf = await h.fetch('/api/nope', { as: a.cookie });
    expect(nf.status).toBe(404);
    expect(nf.headers.get('content-type')).toContain('application/json');
    expect(await nf.json()).toEqual({ error: 'Not found' });
    expect((await h.fetch('/api/admin/nope', { method: 'POST', as: a.cookie })).status).toBe(404);
    const wm = await h.fetch('/api/me', { method: 'DELETE', as: a.cookie });
    expect(wm.status).toBe(405);
    expect(wm.headers.get('content-type')).toContain('application/json');
    const allow = (wm.headers.get('allow') ?? '').split(/,\s*/).sort();
    expect(allow).toEqual(['GET', 'PATCH']);
    expect((await h.fetch('/api/sets', { method: 'POST', as: a.cookie })).status).toBe(405);
    expect((await h.fetch('/api/health', { method: 'POST' })).status).toBe(405);
  });

  it('health needs no sign-in and leaks no personal data', async () => {
    const r = await h.fetch('/api/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, d1: true, r2: true });
  });

  it('API responses are never cacheable and carry the security headers', async () => {
    const a = await school('hdr');
    const r = await h.fetch('/api/me', { as: a.cookie });
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-robots-tag')).toMatch(/noindex/);
  });

  it('logout ends the session', async () => {
    const a = await school('logout');
    expect((await h.fetch('/api/auth/logout', { method: 'POST', as: a.cookie })).status).toBe(200);
    expect((await body(await h.fetch('/api/me', { as: a.cookie }))).account).toBeNull();
  });
});
