// @vitest-environment node
// Profiles through the real Worker (workerd via Miniflare, real D1 and R2): handles, visibility, edits,
// profile sets, avatars and reports.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfBytes, pngBytes, sha, startWorker, type Harness } from './worker-harness';

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
/** Signs in and reads /api/me so the account has its handle. */
async function user(email: string, opts?: { hd?: string | null; name?: string }): Promise<Who> {
  const s = await h.signIn(email, opts);
  const me = await body(await h.fetch('/api/me', { as: s.cookie }));
  return { ...s, handle: me.account.handle as string, email };
}
const school = (p: string) => user(`${tag(p)}@stjbs.sch.id`);
const personal = (p: string) => user(`${tag(p)}@gmail.com`);
async function admin(p = 'padm') {
  const email = `${tag(p)}@stjbs.sch.id`;
  await h.sql('INSERT INTO library_admins (email, added_at, added_by) VALUES (?1, 0, ?2)', email, 'test');
  return user(email);
}
const profile = (as: string | undefined, handle: string) => h.fetch(`/api/profiles/${handle}`, { as });
const patch = (as: string, b: unknown) => h.fetch('/api/me/profile', { method: 'PATCH', as, body: JSON.stringify(b) });

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

describe('handles', () => {
  it('derive from the email local part, and stay unique across domains', async () => {
    const base = `josef.yang${++seq}`;
    const a = await user(`${base}@stjbs.sch.id`);
    const b = await user(`${base}@gmail.com`);
    expect(a.handle).toBe(base);
    expect(b.handle).not.toBe(base);
    expect(b.handle.startsWith(base)).toBe(true);
    const again = await body(await h.fetch('/api/me', { as: b.cookie }));
    expect(again.account.handle).toBe(b.handle);
  });
});

describe('GET /api/profiles/<handle> visibility', () => {
  it('anonymous 401; signed-in non-member 403', async () => {
    const m = await school('v-m');
    expect((await profile(undefined, m.handle)).status).toBe(401);
    const g = await personal('v-g');
    expect((await profile(g.cookie, m.handle)).status).toBe(403);
  });

  it('a member sees another member\'s school profile; the owner sees mine and visibility', async () => {
    const a = await school('v-a');
    const b = await school('v-b');
    expect((await patch(a.cookie, { headline: 'Physics nerd', bio: 'Hello', subjects: ['Physics', 'Physics', 'Maths'] })).status).toBe(200);
    const seen = (await body(await profile(b.cookie, a.handle))).profile;
    expect(seen).toMatchObject({ handle: a.handle, headline: 'Physics nerd', bio: 'Hello', subjects: ['Physics', 'Maths'], mine: false });
    expect(seen.visibility).toBeUndefined();
    const own = (await body(await profile(a.cookie, a.handle))).profile;
    expect(own.mine).toBe(true);
    expect(own.visibility).toBe('school');
  });

  it('private: 404 to members, visible to the owner and to admins', async () => {
    const a = await school('p-a');
    const b = await school('p-b');
    const adm = await admin();
    expect((await patch(a.cookie, { visibility: 'private' })).status).toBe(200);
    expect((await profile(b.cookie, a.handle)).status).toBe(404);
    const own = await body(await profile(a.cookie, a.handle));
    expect(own.profile).toMatchObject({ mine: true, visibility: 'private' });
    const seenByAdmin = await body(await profile(adm.cookie, a.handle));
    expect(seenByAdmin.profile).toMatchObject({ mine: false, visibility: 'private' });
  });

  it('a personal (non-member) account\'s profile is 404 to members', async () => {
    const g = await personal('np-g');
    const m = await school('np-m');
    expect((await profile(m.cookie, g.handle)).status).toBe(404);
  });

  it('a suspended user\'s profile is 404, even to admins', async () => {
    const a = await school('sus-a');
    const b = await school('sus-b');
    const adm = await admin();
    expect((await profile(b.cookie, a.handle)).status).toBe(200);
    await h.sql('UPDATE users SET suspended_at = ?2 WHERE id = ?1', a.id, Date.now());
    expect((await profile(b.cookie, a.handle)).status).toBe(404);
    expect((await profile(adm.cookie, a.handle)).status).toBe(404);
  });

  it('unknown or malformed handle is 404', async () => {
    const m = await school('nf');
    expect((await profile(m.cookie, 'nobody-here-xyz')).status).toBe(404);
    expect((await profile(m.cookie, 'A!')).status).toBe(404);
  });
});

describe('stats', () => {
  it('are hidden (null) from others unless showStats; the owner always sees them', async () => {
    const a = await school('st-a');
    const b = await school('st-b');
    expect((await patch(a.cookie, { stats: { sessions: 12, accuracy: 71.6, streak: 3 } })).status).toBe(200);
    expect((await body(await profile(b.cookie, a.handle))).profile.stats).toBeNull();
    expect((await body(await profile(a.cookie, a.handle))).profile.stats).toEqual({ sessions: 12, accuracy: 72, streak: 3 });
    expect((await patch(a.cookie, { showStats: true })).status).toBe(200);
    const shown = (await body(await profile(b.cookie, a.handle))).profile;
    expect(shown.showStats).toBe(true);
    expect(shown.stats).toEqual({ sessions: 12, accuracy: 72, streak: 3 });
    expect((await patch(a.cookie, { showStats: false })).status).toBe(200);
    expect((await body(await profile(b.cookie, a.handle))).profile.stats).toBeNull();
  });
});

describe('PATCH /api/me/profile', () => {
  it('handle rules: too short and bad characters are 400, taken is 409, success moves the route', async () => {
    const a = await school('h-a');
    const b = await school('h-b');
    expect((await patch(a.cookie, { handle: 'ab' })).status).toBe(400);
    expect((await patch(a.cookie, { handle: 'bad handle!' })).status).toBe(400);
    expect((await patch(a.cookie, { handle: '-lead-dash' })).status).toBe(400);
    expect((await patch(a.cookie, { handle: 'x'.repeat(31) })).status).toBe(400);
    expect((await patch(a.cookie, { handle: b.handle })).status).toBe(409);
    const fresh = `new.name-${seq}`;
    const ok = await patch(a.cookie, { handle: fresh.toUpperCase() });
    expect(ok.status).toBe(200);
    expect((await body(ok)).handle).toBe(fresh);
    expect((await profile(b.cookie, fresh)).status).toBe(200);
    expect((await profile(b.cookie, a.handle)).status).toBe(404);
    expect((await body(await h.fetch('/api/me', { as: a.cookie }))).account.handle).toBe(fresh);
  });

  it('length, plain-text, count and enum limits', async () => {
    const a = await school('lim');
    expect((await patch(a.cookie, { headline: 'h'.repeat(80) })).status).toBe(200);
    expect((await patch(a.cookie, { headline: 'h'.repeat(81) })).status).toBe(400);
    expect((await patch(a.cookie, { bio: 'b'.repeat(160) })).status).toBe(200);
    expect((await patch(a.cookie, { bio: 'b'.repeat(161) })).status).toBe(400);
    expect((await patch(a.cookie, { bio: 'hi <script>' })).status).toBe(400);
    expect((await patch(a.cookie, { headline: 'a > b' })).status).toBe(400);
    expect((await patch(a.cookie, { subjects: Array.from({ length: 8 }, (_, i) => `S${i}`) })).status).toBe(200);
    expect((await patch(a.cookie, { subjects: Array.from({ length: 9 }, (_, i) => `S${i}`) })).status).toBe(400);
    expect((await patch(a.cookie, { subjects: 'Physics' })).status).toBe(400);
    expect((await patch(a.cookie, { visibility: 'public' })).status).toBe(400);
    expect((await patch(a.cookie, { visibility: 'private' })).status).toBe(200);
    expect((await patch(a.cookie, { visibility: 'school' })).status).toBe(200);
    expect((await patch(a.cookie, { stats: { sessions: -1 } })).status).toBe(400);
    expect((await patch(a.cookie, { stats: { sessions: 'many' } })).status).toBe(400);
    expect((await patch(a.cookie, { stats: { hacks: 1 } })).status).toBe(400);
    expect((await patch(a.cookie, {})).status).toBe(400);
  });

  it('needs a session', async () => {
    const r = await h.fetch('/api/me/profile', { method: 'PATCH', body: JSON.stringify({ bio: 'x' }) });
    expect(r.status).toBe(401);
  });
});

describe('profile sets', () => {
  it('others see only approved sets; hiding one removes it for members but not the owner', async () => {
    const owner = await school('ps-o');
    const other = await school('ps-x');
    const adm = await admin();
    const id = await publish(owner.cookie, `Profile set ${seq}`);
    const ids = async (as: string) => ((await body(await profile(as, owner.handle))).profile.sets as Json[]).map((s) => s.id);
    expect(await ids(other.cookie)).toContain(id);
    expect(await ids(owner.cookie)).toContain(id);
    const hide = await h.fetch(`/api/sets/${id}`, { method: 'PATCH', as: adm.cookie, body: JSON.stringify({ status: 'hidden' }) });
    expect(hide.status, await hide.clone().text()).toBe(200);
    expect(await ids(other.cookie)).not.toContain(id);
    expect(await ids(owner.cookie)).toContain(id);
    expect(await ids(adm.cookie)).toContain(id);
  });
});

describe('avatar', () => {
  const put = (as: string, bytes: Uint8Array, type: string) => h.fetch('/api/me/avatar', { method: 'PUT', as, body: bytes, headers: { 'content-type': type } });

  it('PUT stores a PNG; a member fetches it sandboxed; DELETE removes it', async () => {
    const a = await school('av-a');
    const b = await school('av-b');
    expect((await h.fetch(`/api/profiles/${a.handle}/avatar`, { as: b.cookie })).status).toBe(404);
    const png = pngBytes('avatar');
    const r = await put(a.cookie, png, 'image/png');
    expect(r.status).toBe(201);
    expect((await body(r)).hash).toBe(sha(png));
    const pr = (await body(await profile(b.cookie, a.handle))).profile;
    expect(pr.avatar).toBe(`/api/profiles/${a.handle}/avatar?v=${sha(png).slice(0, 12)}`);
    const got = await h.fetch(`/api/profiles/${a.handle}/avatar`, { as: b.cookie });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
    const g = await personal('av-g');
    expect((await h.fetch(`/api/profiles/${a.handle}/avatar`, { as: g.cookie })).status).toBe(403);
    expect((await h.fetch(`/api/profiles/${a.handle}/avatar`)).status).toBe(401);
    expect((await h.fetch('/api/me/avatar', { method: 'DELETE', as: a.cookie })).status).toBe(200);
    expect((await h.fetch(`/api/profiles/${a.handle}/avatar`, { as: b.cookie })).status).toBe(404);
    expect((await body(await profile(b.cookie, a.handle))).profile.avatar).toBeNull();
  });

  it('a private profile\'s avatar is 404 to other members', async () => {
    const a = await school('av-pv');
    const b = await school('av-pw');
    expect((await put(a.cookie, pngBytes('x'), 'image/png')).status).toBe(201);
    await patch(a.cookie, { visibility: 'private' });
    expect((await h.fetch(`/api/profiles/${a.handle}/avatar`, { as: b.cookie })).status).toBe(404);
    expect((await h.fetch(`/api/profiles/${a.handle}/avatar`, { as: a.cookie })).status).toBe(200);
  });

  it('rejects wrong magic bytes and wrong types with 415, and oversized files with 413', async () => {
    const a = await school('av-bad');
    expect((await put(a.cookie, new Uint8Array([0xff, 0xd8, 0xff, ...new Uint8Array(40)]), 'image/png')).status).toBe(415);
    expect((await put(a.cookie, pngBytes('x'), 'image/gif')).status).toBe(415);
    expect((await put(a.cookie, enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(64, ' ')), 'image/svg+xml')).status).toBe(415);
    expect((await put(a.cookie, pngBytes('x').slice(0, 8), 'image/png')).status).toBe(415);
    const big = new Uint8Array(512 * 1024 + 1);
    big.set(pngBytes('big'));
    expect((await put(a.cookie, big, 'image/png')).status).toBe(413);
    const edge = new Uint8Array(512 * 1024);
    edge.set(pngBytes('edge'));
    expect((await put(a.cookie, edge, 'image/png')).status).toBe(201);
  });

  it('replacing the photo deletes the old object', async () => {
    const a = await school('av-rep');
    const one = pngBytes('one');
    const two = pngBytes('two');
    await put(a.cookie, one, 'image/png');
    await put(a.cookie, two, 'image/png');
    const r2 = (await h.mf.getR2Bucket('FILES')) as unknown as { head(key: string): Promise<unknown> };
    expect(await r2.head(`avatars/${a.id}/${sha(one)}`)).toBeNull();
    expect(await r2.head(`avatars/${a.id}/${sha(two)}`)).not.toBeNull();
  });
});

describe('POST /api/profiles/<handle>/report', () => {
  const report = (as: string | undefined, handle: string, reason: unknown = 'rude') => h.fetch(`/api/profiles/${handle}/report`, { method: 'POST', as, body: JSON.stringify({ reason }) });

  it('own profile 400; another\'s 201 and listed for admins; validation; access', async () => {
    const a = await school('rp-a');
    const b = await school('rp-b');
    const adm = await admin();
    expect((await report(a.cookie, a.handle)).status).toBe(400);
    expect((await report(b.cookie, a.handle, '')).status).toBe(400);
    expect((await report(b.cookie, a.handle, 'x'.repeat(501))).status).toBe(400);
    expect((await report(undefined, a.handle)).status).toBe(401);
    expect((await report((await personal('rp-g')).cookie, a.handle)).status).toBe(403);
    expect((await report(b.cookie, a.handle, 'impersonation')).status).toBe(201);
    expect((await report(b.cookie, a.handle, 'impersonation again')).status).toBe(201);
    const mod = await body(await h.fetch('/api/admin/moderation', { as: adm.cookie }));
    const row = (mod.people as Json[]).find((p) => p.handle === a.handle)!;
    expect(row).toBeTruthy();
    expect(row.reports).toBe(1);
    expect(row.reasons[0].reason).toBe('impersonation again');
    expect((await h.fetch('/api/admin/moderation', { as: b.cookie })).status).toBe(403);
  });

  it('cannot report a private profile of someone else', async () => {
    const a = await school('rp-pa');
    const b = await school('rp-pb');
    await patch(a.cookie, { visibility: 'private' });
    expect((await report(b.cookie, a.handle)).status).toBe(404);
  });
});
