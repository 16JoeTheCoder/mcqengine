// @vitest-environment node
// Library file storage through the real Worker (workerd via Miniflare, real D1 and R2).
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfBytes, pngBytes, sha, startWorker, type Harness } from './worker-harness';

let h: Harness;
let seq = 0;
const uid = () => crypto.randomUUID();
const tag = (p: string) => `${p}${++seq}`;
const enc = new TextEncoder();
const MB = 1024 * 1024;

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

const put = (as: string | undefined, bytes: Uint8Array, type: string, hash = sha(bytes), headers: Record<string, string> = {}) =>
  h.fetch(`/api/blobs/${hash}`, { method: 'PUT', as, body: bytes, headers: { 'content-type': type, 'content-length': String(bytes.byteLength), ...headers } });
async function upload(as: string, bytes: Uint8Array, type: string): Promise<string> {
  const r = await put(as, bytes, type);
  expect(r.status, `upload ${type}`).toBeLessThan(300);
  return sha(bytes);
}
const get = (as: string | undefined, hash: string, headers: Record<string, string> = {}, method = 'GET') => h.fetch(`/api/blob/${hash}`, { as, headers, method });
const bytesOf = async (r: Response) => new Uint8Array(await r.arrayBuffer());
const blobRows = (hash: string) => h.sql<{ hash: string; size: number; type: string; first_uploader: string; orphaned_at: number | null }>('SELECT * FROM blobs WHERE hash = ?1', hash);
const r2 = async () => (await h.mf.getR2Bucket('FILES')) as unknown as { head(key: string): Promise<object | null> };

/** Fills a user's quota with fake rows (the table allows 25 MB per row at most). */
async function fillQuota(userId: string, bytes = 300 * MB) {
  const per = 25 * MB;
  for (let i = 0; i * per < bytes; i++) {
    await h.sql('INSERT INTO blobs (hash, size, type, first_uploader, created_at) VALUES (?1, ?2, \'application/pdf\', ?3, 0)', sha(`fake-${userId}-${i}`), Math.min(per, bytes - i * per), userId);
  }
}

interface PublishOpts { id?: string; base?: number; key?: string; label?: string; extra?: Uint8Array[] }
async function publish(as: string, o: PublishOpts = {}) {
  const id = o.id ?? uid();
  const key = o.key ?? '9702_s24_qp_12';
  const label = o.label ?? id;
  const pack = await upload(as, enc.encode(`{"format":"dmc-pack/1","label":"${label}"}`), 'application/json');
  const pdf = await upload(as, pdfBytes(label), 'application/pdf');
  const files: Record<string, string> = { [`pdfs/${key}.pdf`]: pdf };
  for (const [i, b] of (o.extra ?? []).entries()) files[`pdfs/extra-${i}.pdf`] = await upload(as, b, 'application/pdf');
  const manifest = {
    format: 'dmc-set/1', pack, files,
    papers: [{ id: key, key, title: 'P12', questionCount: 40, keyed: 40, qp: pdf }],
    meta: { title: `Set ${label}`, description: '', subject: 'Physics', code: '9702' },
  };
  const res = await h.fetch(`/api/sets/${id}/versions`, { method: 'POST', as, body: JSON.stringify({ base: o.base ?? 0, manifest }) });
  expect(res.status, await res.clone().text()).toBe(201);
  return { id, pack, pdf, files };
}

describe('upload and download', () => {
  it('round-trips a PDF byte for byte, with HEAD, caching headers and 304', async () => {
    const m = await school('rt');
    const bytes = pdfBytes('round trip', 5000);
    for (let i = 100; i < 5000; i += 7) bytes[i] = i % 251;
    const hash = sha(bytes);
    const up = await put(m.cookie, bytes, 'application/pdf');
    expect(up.status).toBe(201);
    expect(await up.json()).toEqual({ stored: true, existed: false });
    const row = (await blobRows(hash))[0]!;
    expect(row).toMatchObject({ size: 5000, type: 'application/pdf', first_uploader: m.id });

    const r = await get(m.cookie, hash);
    expect(r.status).toBe(200);
    expect(await bytesOf(r)).toEqual(bytes);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('etag')).toBe(`"${hash}"`);
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('accept-ranges')).toBe('bytes');

    // A second read (served from the cache) is identical.
    expect(await bytesOf(await get(m.cookie, hash))).toEqual(bytes);

    const head = await get(m.cookie, hash, {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(`"${hash}"`);
    expect(head.headers.get('content-type')).toBe('application/pdf');
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const nm = await get(m.cookie, hash, { 'if-none-match': `"${hash}"` });
    expect(nm.status).toBe(304);
    expect(nm.headers.get('etag')).toBe(`"${hash}"`);
    expect((await nm.arrayBuffer()).byteLength).toBe(0);
    expect((await get(m.cookie, hash, { 'if-none-match': '"other"' })).status).toBe(200);
  });

  it('stores each accepted type and serves it with its type', async () => {
    const m = await school('types');
    const cases: [string, Uint8Array][] = [
      ['image/png', pngBytes('png')],
      ['image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])],
      ['image/gif', enc.encode('GIF89a-gif-body')],
      ['image/webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9])],
      ['image/svg+xml', enc.encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')],
      ['application/json', enc.encode('{"format":"dmc-pack/1","t":"types"}')],
    ];
    for (const [type, bytes] of cases) {
      const hash = await upload(m.cookie, bytes, type);
      const r = await get(m.cookie, hash);
      expect(r.status, type).toBe(200);
      expect(r.headers.get('content-type')).toBe(type);
      expect(await bytesOf(r)).toEqual(bytes);
    }
  });

  it('accepts a content type with parameters and in any case', async () => {
    const m = await school('ctype');
    const bytes = pdfBytes('ctype');
    expect((await put(m.cookie, bytes, 'Application/PDF; charset=binary')).status).toBe(201);
    expect((await get(m.cookie, sha(bytes))).headers.get('content-type')).toBe('application/pdf');
  });

  it('records the upload in usage_daily', async () => {
    const m = await school('use-up');
    const bytes = pdfBytes('usage up', 1234);
    await upload(m.cookie, bytes, 'application/pdf');
    await until(async () => (await h.sql('SELECT uploads FROM usage_daily WHERE user_id = ?1', m.id)).length > 0);
    expect((await h.sql('SELECT uploads, upload_bytes FROM usage_daily WHERE user_id = ?1', m.id))[0]).toEqual({ uploads: 1, upload_bytes: 1234 });
  });
});

async function until(f: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out waiting for condition');
}

describe('range requests', () => {
  async function seeded() {
    const m = await school('range');
    const bytes = pdfBytes(`range ${m.id}`, 1000);
    for (let i = 30; i < 1000; i++) bytes[i] = i % 256;
    await upload(m.cookie, bytes, 'application/pdf');
    return { m, bytes, hash: sha(bytes) };
  }

  it('bytes=0-3 is 206 with Content-Range', async () => {
    const { m, bytes, hash } = await seeded();
    const r = await get(m.cookie, hash, { range: 'bytes=0-3' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-3/1000');
    expect(r.headers.get('content-length')).toBe('4');
    expect(await bytesOf(r)).toEqual(bytes.subarray(0, 4));
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('%PDF');
  });

  it('serves middle, open-ended and suffix ranges', async () => {
    const { m, bytes, hash } = await seeded();
    const mid = await get(m.cookie, hash, { range: 'bytes=100-199' });
    expect(mid.status).toBe(206);
    expect(mid.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(await bytesOf(mid)).toEqual(bytes.subarray(100, 200));
    const open = await get(m.cookie, hash, { range: 'bytes=990-' });
    expect(open.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(await bytesOf(open)).toEqual(bytes.subarray(990));
    const suffix = await get(m.cookie, hash, { range: 'bytes=-4' });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 996-999/1000');
    expect(await bytesOf(suffix)).toEqual(bytes.subarray(996));
    const past = await get(m.cookie, hash, { range: 'bytes=900-5000' });
    expect(past.headers.get('content-range')).toBe('bytes 900-999/1000');
    const big = await get(m.cookie, hash, { range: 'bytes=-5000' });
    expect(big.headers.get('content-range')).toBe('bytes 0-999/1000');
  });

  it('invalid ranges are 416', async () => {
    const { m, hash } = await seeded();
    for (const range of ['bytes=1000-', 'bytes=5000-6000', 'bytes=10-5', 'bytes=abc', 'bytes=-', 'bytes=-0', 'items=0-3']) {
      const r = await get(m.cookie, hash, { range });
      expect(r.status, range).toBe(416);
      expect(r.headers.get('content-range')).toBe('bytes */1000');
    }
  });

  it('range reads still need access', async () => {
    const { hash } = await seeded();
    const p = await personal('range-p');
    expect((await get(p.cookie, hash, { range: 'bytes=0-3' })).status).toBe(403);
    expect((await get(undefined, hash, { range: 'bytes=0-3' })).status).toBe(401);
  });
});

describe('integrity', () => {
  it('a body that differs from the hash in the URL is 400 and stores nothing', async () => {
    const m = await school('hash');
    const adm = await admin('hash-adm');
    const bytes = pdfBytes('actual content');
    const claimed = sha(pdfBytes('claimed content'));
    const r = await put(m.cookie, bytes, 'application/pdf', claimed);
    expect(r.status).toBe(400);
    expect(await blobRows(claimed)).toEqual([]);
    expect(await blobRows(sha(bytes))).toEqual([]);
    expect((await get(adm.cookie, claimed)).status).toBe(404);
    expect((await get(m.cookie, claimed)).status).toBe(404);
    expect(await (await r2()).head(`blobs/${claimed}`)).toBeNull();
    // The right hash still works afterwards.
    expect((await put(m.cookie, bytes, 'application/pdf')).status).toBe(201);
  });

  it('a lookalike hash cannot be used to overwrite an existing file', async () => {
    const a = await school('over-a');
    const b = await school('over-b');
    const real = pdfBytes('original');
    await upload(a.cookie, real, 'application/pdf');
    const evil = pdfBytes('replacement');
    // The file already exists, so the upload is a no-op even for different bytes under that name.
    const r = await put(b.cookie, evil, 'application/pdf', sha(real));
    expect(r.status).toBeLessThan(300);
    expect(await bytesOf(await get(a.cookie, sha(real)))).toEqual(real);
  });

  it('rejects hashes that are not 64 lowercase hex characters', async () => {
    const m = await school('badhash');
    for (const bad of ['abc', 'G'.repeat(64), sha('x').toUpperCase(), `${sha('x')}0`]) {
      expect((await put(m.cookie, pdfBytes('x'), 'application/pdf', bad)).status, bad).toBe(400);
    }
    expect((await get(m.cookie, 'abc')).status).toBe(404);
  });
});

describe('type checks', () => {
  it('PNG bytes declared as a PDF are 415 and not stored', async () => {
    const m = await school('t1');
    const png = pngBytes('not a pdf');
    expect((await put(m.cookie, png, 'application/pdf')).status).toBe(415);
    expect(await blobRows(sha(png))).toEqual([]);
    expect(await (await r2()).head(`blobs/${sha(png)}`)).toBeNull();
  });

  it('text declared as an image is 415', async () => {
    const m = await school('t2');
    const text = enc.encode('hello, I am only text');
    expect((await put(m.cookie, text, 'image/png')).status).toBe(415);
    expect((await put(m.cookie, text, 'image/jpeg')).status).toBe(415);
    expect((await put(m.cookie, text, 'application/pdf')).status).toBe(415);
    expect((await put(m.cookie, enc.encode('[1,2]'), 'application/json')).status).toBe(415);
    expect((await put(m.cookie, enc.encode('<html><script>alert(1)</script></html>'), 'image/svg+xml')).status).toBe(415);
    expect(await blobRows(sha(text))).toEqual([]);
  });

  it('PDF bytes declared as an image or JSON are 415', async () => {
    const m = await school('t3');
    expect((await put(m.cookie, pdfBytes('x'), 'image/png')).status).toBe(415);
    expect((await put(m.cookie, pdfBytes('y'), 'application/json')).status).toBe(415);
  });

  it('unsupported content types are 415', async () => {
    const m = await school('t4');
    const html = enc.encode('<html></html>');
    for (const type of ['text/html', 'text/plain', 'application/octet-stream', 'application/zip', 'image/tiff', '']) {
      expect((await put(m.cookie, html, type)).status, type).toBe(415);
    }
    expect((await put(m.cookie, pdfBytes('no type'), 'application/pdf', sha(pdfBytes('no type')), { 'content-type': '' })).status).toBe(415);
  });

  it('a missing content-length is refused (411) and an empty file too', async () => {
    const m = await school('t5');
    const hash = sha(pdfBytes('x'));
    const r = await h.fetch(`/api/blobs/${hash}`, { method: 'PUT', as: m.cookie, headers: { 'content-type': 'application/pdf', 'content-length': '0' } });
    expect(r.status).toBe(411);
  });
});

/** Sends a raw HTTP request so the declared and actual sizes can disagree, which fetch forbids. */
async function raw(cookie: string, hash: string, declared: number, payload: Uint8Array, half = false, type = 'application/pdf'): Promise<number> {
  const url = new URL(String(await h.mf.ready));
  const head = `PUT /api/blobs/${hash} HTTP/1.1\r\nHost: localhost\r\nCookie: __Host-dmc_session=${cookie}\r\nX-DMC: 1\r\nContent-Type: ${type}\r\nContent-Length: ${declared}\r\nConnection: close\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const sock = connect(Number(url.port), url.hostname);
    let data = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('raw request timed out')); }, 8000);
    sock.on('connect', () => { sock.write(head); sock.write(payload); if (half) sock.end(); });
    sock.on('data', (d) => { data += d.toString('latin1'); });
    const done = () => { clearTimeout(timer); const m = /^HTTP\/1\.\d (\d{3})/.exec(data); if (m) resolve(Number(m[1])); else reject(new Error(`no response: ${JSON.stringify(data.slice(0, 80))}`)); };
    sock.on('end', done);
    sock.on('close', () => { if (data) done(); });
    sock.on('error', reject);
  });
}

describe('size limits', () => {
  it('a declared size above 25 MB is 413 before the body is read', async () => {
    const m = await school('big');
    const bytes = pdfBytes('big', 2000);
    const status = await raw(m.cookie, sha(bytes), 25 * MB + 1, bytes);
    expect(status).toBe(413);
    expect(await blobRows(sha(bytes))).toEqual([]);
  });

  it('exactly 25 MB is not refused for its size', async () => {
    const m = await school('edge');
    const bytes = pdfBytes('edge', 25 * MB);
    const r = await put(m.cookie, bytes, 'application/pdf');
    expect(r.status).toBe(201);
    expect((await blobRows(sha(bytes)))[0]!.size).toBe(25 * MB);
  });

  it('a body larger than its stated size does not store a file', async () => {
    const m = await school('over');
    const bytes = pdfBytes('over', 1000);
    // Content-Length says 500 but 1000 bytes follow: the server reads 500 and sees leftover bytes
    // (or the hash of the first 500 does not match the name); either way nothing is stored.
    let status: number | null = null;
    try { status = await raw(m.cookie, sha(bytes), 500, bytes); } catch { status = null; }
    if (status !== null) expect([400, 413]).toContain(status);
    expect(await blobRows(sha(bytes))).toEqual([]);
  });

  it('a body shorter than its stated size is not stored', async () => {
    const m = await school('short');
    const bytes = pdfBytes('short', 1000);
    let status: number | null = null;
    try { status = await raw(m.cookie, sha(bytes), 2000, bytes, true); } catch { status = null; }
    if (status !== null) expect(status).toBeGreaterThanOrEqual(400);
    expect(await blobRows(sha(bytes))).toEqual([]);
  });
});

describe('quota', () => {
  it('a member over 300 MB is refused with 413 mentioning the quota', async () => {
    const m = await school('q1');
    await fillQuota(m.id);
    const me = await body(await h.fetch('/api/me', { as: m.cookie }));
    expect(me.quota).toEqual({ used: 300 * MB, limit: 300 * MB });
    const bytes = pdfBytes('over quota');
    const r = await put(m.cookie, bytes, 'application/pdf');
    expect(r.status).toBe(413);
    expect((await body(r)).error).toMatch(/quota/i);
    expect(await blobRows(sha(bytes))).toEqual([]);
  });

  it('just under the limit passes and the last byte over fails', async () => {
    const m = await school('q1b');
    await fillQuota(m.id, 300 * MB - 2000);
    expect((await put(m.cookie, pdfBytes('fits', 2000), 'application/pdf')).status).toBe(201);
    expect((await put(m.cookie, enc.encode('%PDF-1 x'), 'application/pdf')).status).toBe(413);
  });

  it('an admin and an allowlisted account with the same usage can still upload (2 GB)', async () => {
    const adm = await admin('q2');
    const al = await allowlisted('q3');
    for (const who of [adm, al]) {
      await fillQuota(who.id);
      const bytes = pdfBytes(`staff ${who.id}`);
      expect((await put(who.cookie, bytes, 'application/pdf')).status).toBe(201);
      expect((await body(await h.fetch('/api/me', { as: who.cookie }))).quota.limit).toBe(2048 * MB);
    }
    await fillQuota(adm.id, 2048 * MB - 300 * MB - 1000).catch(() => {});
  });

  it('an allowlisted account is refused past 2 GB', async () => {
    const al = await allowlisted('q3b');
    const per = 25 * MB;
    const rows = Math.floor((2048 * MB) / per);
    for (let i = 0; i < rows; i++) await h.sql('INSERT INTO blobs (hash, size, type, first_uploader, created_at) VALUES (?1, ?2, \'application/pdf\', ?3, 0)', sha(`full-${al.id}-${i}`), per, al.id);
    await h.sql('INSERT INTO blobs (hash, size, type, first_uploader, created_at) VALUES (?1, ?2, \'application/pdf\', ?3, 0)', sha(`full-${al.id}-x`), 2048 * MB - rows * per, al.id);
    const r = await put(al.cookie, pdfBytes('too much'), 'application/pdf');
    expect(r.status).toBe(413);
    expect((await body(r)).error).toMatch(/quota/i);
  });

  it('uploading a file that already exists costs nothing, even at full quota', async () => {
    const owner = await school('q4');
    const full = await school('q5');
    const bytes = pdfBytes('shared file');
    await upload(owner.cookie, bytes, 'application/pdf');
    await fillQuota(full.id);
    const r = await put(full.cookie, bytes, 'application/pdf');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ stored: true, existed: true });
    // The bytes are still charged to the first uploader only.
    expect((await blobRows(sha(bytes)))[0]!.first_uploader).toBe(owner.id);
    expect((await body(await h.fetch('/api/me', { as: full.cookie }))).quota.used).toBe(300 * MB);
  });
});

describe('blobs/check', () => {
  const check = (as: string | undefined, hashes: unknown) => h.fetch('/api/blobs/check', { method: 'POST', as, body: JSON.stringify({ hashes }) });

  it('returns only the missing hashes, once each', async () => {
    const m = await school('chk');
    const have = await upload(m.cookie, pdfBytes('have'), 'application/pdf');
    const miss1 = sha('missing 1');
    const miss2 = sha('missing 2');
    const r = await check(m.cookie, [have, miss1, miss2, miss1]);
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ missing: [miss1, miss2] });
    expect(await body(await check(m.cookie, [have]))).toEqual({ missing: [] });
    expect(await body(await check(m.cookie, []))).toEqual({ missing: [] });
  });

  it('rejects non-hex, wrong-length and uppercase hashes, non-arrays and oversized lists', async () => {
    const m = await school('chk2');
    for (const bad of [['xyz'], ['g'.repeat(64)], [sha('a').toUpperCase()], [sha('a').slice(1)], [5], 'nope', null]) {
      expect((await check(m.cookie, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect([400, 413]).toContain((await check(m.cookie, Array.from({ length: 3001 }, (_, i) => sha(String(i))))).status);
    expect((await h.fetch('/api/blobs/check', { method: 'POST', as: m.cookie, body: JSON.stringify({ hashes: [], extra: 1 }) })).status).toBe(400);
  });

  it('is members only', async () => {
    expect((await check(undefined, [])).status).toBe(401);
    expect((await check((await personal('chk3')).cookie, [])).status).toBe(403);
  });
});

describe('download access', () => {
  it('the uploader reads an unpublished file; another member cannot until it is in an approved set', async () => {
    const up = await school('acc-up');
    const other = await school('acc-other');
    const adm = await admin('acc-adm');
    const bytes = pdfBytes('unpublished');
    const hash = await upload(up.cookie, bytes, 'application/pdf');
    expect((await get(up.cookie, hash)).status).toBe(200);
    expect((await get(other.cookie, hash)).status).toBe(404);
    expect((await get(adm.cookie, hash)).status).toBe(200);
    expect((await get(other.cookie, hash, { range: 'bytes=0-3' })).status).toBe(404);
    expect((await get(other.cookie, hash, { 'if-none-match': `"${hash}"` })).status).toBe(404);
    expect((await get(other.cookie, hash, {}, 'HEAD')).status).toBe(404);

    const set = await publish(up.cookie, { label: 'acc-set', extra: [bytes] });
    expect(Object.values(set.files)).toContain(hash);
    expect((await get(other.cookie, hash)).status).toBe(200);

    // Hidden again: only the owner and admins.
    await h.fetch(`/api/sets/${set.id}`, { method: 'PATCH', as: adm.cookie, body: JSON.stringify({ status: 'hidden' }) });
    expect((await get(other.cookie, hash)).status).toBe(404);
    expect((await get(up.cookie, hash)).status).toBe(200);
    expect((await get(adm.cookie, hash)).status).toBe(200);
  });

  it('a file in someone else\'s hidden set stays hidden even if the reader also uploaded other files', async () => {
    const owner = await school('acc-h1');
    const other = await school('acc-h2');
    const adm = await admin('acc-h3');
    const set = await publish(owner.cookie);
    await h.fetch(`/api/sets/${set.id}`, { method: 'PATCH', as: adm.cookie, body: JSON.stringify({ status: 'hidden' }) });
    await upload(other.cookie, pdfBytes('mine'), 'application/pdf');
    expect((await get(other.cookie, set.pdf)).status).toBe(404);
  });

  it('personal, school-without-hd and unverified accounts get 403; anonymous 401', async () => {
    const owner = await school('acc-own');
    const set = await publish(owner.cookie);
    const p = await personal('acc-p');
    const noHd = await h.signIn(`${tag('acc-nohd')}@stjbs.sch.id`, { hd: null });
    const unv = await h.signIn(`${tag('acc-unv')}@stjbs.sch.id`, { verified: false });
    for (const who of [p, noHd, unv]) {
      expect((await get(who.cookie, set.pdf)).status).toBe(403);
      expect((await get(who.cookie, set.pdf, {}, 'HEAD')).status).toBe(403);
      expect((await put(who.cookie, pdfBytes('x'), 'application/pdf')).status).toBe(403);
    }
    expect((await get(undefined, set.pdf)).status).toBe(401);
    expect((await put(undefined, pdfBytes('x'), 'application/pdf')).status).toBe(401);
  });

  it('an unknown or malformed hash is 404', async () => {
    const m = await school('acc-404');
    expect((await get(m.cookie, sha('nothing here'))).status).toBe(404);
    expect((await get(m.cookie, 'zzz')).status).toBe(404);
  });

  it('a blob row whose object is missing from storage is 404, not a crash', async () => {
    const m = await school('acc-gone');
    const hash = sha('ghost row');
    await h.sql('INSERT INTO blobs (hash, size, type, first_uploader, created_at) VALUES (?1, 10, \'application/pdf\', ?2, 0)', hash, m.id);
    expect((await get(m.cookie, hash)).status).toBe(404);
    expect((await get(m.cookie, hash, { range: 'bytes=0-3' })).status).toBe(404);
  });
});

describe('usage', () => {
  it('records downloads for the downloader (a full read counts once, a later range does not)', async () => {
    const up = await school('use-up2');
    const dl = await school('use-dl');
    const bytes = pdfBytes('usage down', 4321);
    const hash = await upload(up.cookie, bytes, 'application/pdf');
    await publish(up.cookie, { label: 'usage-set', extra: [bytes] });
    const rows = () => h.sql<{ downloads: number; download_bytes: number }>('SELECT downloads, download_bytes FROM usage_daily WHERE user_id = ?1', dl.id);
    expect(await rows()).toEqual([]);

    expect((await get(dl.cookie, hash, { range: 'bytes=100-199' })).status).toBe(206);
    expect((await get(dl.cookie, hash)).status).toBe(200);
    await until(async () => ((await rows())[0]?.downloads ?? 0) >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await rows()).toEqual([{ downloads: 1, download_bytes: 4321 }]);

    // A read that opens at byte 0 (pdf.js loading the header) counts as a download.
    expect((await get(dl.cookie, hash, { range: 'bytes=0-9' })).status).toBe(206);
    await until(async () => ((await rows())[0]?.downloads ?? 0) >= 2);
    expect(await rows()).toEqual([{ downloads: 2, download_bytes: 8642 }]);

    // The uploader's own record is separate, and 304s and refused reads count for nobody.
    expect((await get(dl.cookie, hash, { 'if-none-match': `"${hash}"` })).status).toBe(304);
    const stranger = await school('use-none');
    await get(stranger.cookie, sha('nothing'));
    expect(await h.sql('SELECT downloads FROM usage_daily WHERE user_id = ?1', stranger.id)).toEqual([]);
    const admDl = await body(await h.fetch('/api/admin/downloads?days=1', { as: (await admin('use-adm')).cookie }));
    expect((admDl.rows as Json[]).find((r) => r.user_id === dl.id)).toMatchObject({ downloads: 2, download_bytes: 8642 });
  });
});

// Last on purpose: garbage collection removes every orphaned file older than the cutoff, which
// includes the unpublished uploads of the tests above.
describe('garbage collection', () => {
  const DAY = 86_400_000;

  it('removes orphans 7 days after deletion and keeps shared and fresh files', async () => {
    const owner = await school('gc-o');
    const adm = await admin('gc-adm');
    const sharedPdf = pdfBytes('gc shared');
    const keyA = '9709_s24_qp_11';
    const a = await publish(owner.cookie, { label: 'gc-a', key: keyA, extra: [sharedPdf] });
    const b = await publish(owner.cookie, { label: 'gc-b', key: '9709_s24_qp_12', extra: [sharedPdf] });
    const shared = sha(sharedPdf);
    expect(Object.values(a.files)).toContain(shared);
    expect(Object.values(b.files)).toContain(shared);
    const mine = [a.pack, a.pdf];
    expect((await h.sql('SELECT paper_key FROM papers WHERE paper_key = ?1', keyA))).toHaveLength(1);

    // Another set with a different owner still referencing nothing of a: used as a control.
    const control = await publish((await school('gc-c')).cookie, { label: 'gc-control', key: '9709_s24_qp_13' });

    expect((await h.fetch(`/api/sets/${a.id}`, { method: 'DELETE', as: adm.cookie })).status).toBe(200);
    for (const hash of mine) expect((await blobRows(hash))[0]!.orphaned_at).not.toBeNull();
    expect((await blobRows(shared))[0]!.orphaned_at).toBeNull();

    // One day later: nothing is old enough.
    await h.scheduled(Date.now() + DAY);
    await new Promise((r) => setTimeout(r, 300));
    for (const hash of mine) expect(await blobRows(hash)).toHaveLength(1);
    expect(await (await r2()).head(`blobs/${a.pdf}`)).not.toBeNull();

    // Eight days later: the orphans go from D1 and R2, shared and live files stay.
    await h.scheduled(Date.now() + 8 * DAY);
    await until(async () => (await blobRows(a.pdf)).length === 0);
    for (const hash of mine) {
      expect(await blobRows(hash)).toEqual([]);
      expect(await (await r2()).head(`blobs/${hash}`)).toBeNull();
    }
    for (const hash of [shared, b.pdf, b.pack, control.pdf, control.pack]) {
      expect(await blobRows(hash), hash).toHaveLength(1);
      expect(await (await r2()).head(`blobs/${hash}`), hash).not.toBeNull();
    }
    // The cron also ended the expired test sessions, so sign in again.
    const reader = await school('gc-reader');
    expect((await get(reader.cookie, shared)).status).toBe(200);
    expect((await get((await admin('gc-adm2')).cookie, a.pdf)).status).toBe(404);
    // The paper registry no longer points at the removed file.
    await until(async () => (await h.sql('SELECT paper_key FROM papers WHERE paper_key = ?1', keyA)).length === 0);
    expect(await h.sql('SELECT paper_key FROM papers WHERE paper_key = \'9709_s24_qp_12\'')).toHaveLength(1);
  });

  it('removes expired sessions and files uploaded but never published', async () => {
    const m = await school('gc-s');
    const bytes = pdfBytes('never published');
    const hash = await upload(m.cookie, bytes, 'application/pdf');
    expect((await blobRows(hash))[0]!.orphaned_at).not.toBeNull();
    await h.scheduled(Date.now() + 8 * DAY);
    await until(async () => (await blobRows(hash)).length === 0);
    expect(await (await r2()).head(`blobs/${hash}`)).toBeNull();
    expect(await h.sql('SELECT token_hash FROM sessions WHERE user_id = ?1', m.id)).toEqual([]);
  });
});
