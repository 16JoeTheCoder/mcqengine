import { BLOB_TYPES, MANIFEST_LIMITS, sniffMatches } from '../shared/manifest';
import { needMember, quotaOf, type Caller } from './auth';
import { ApiError, hash, hex, json, obj, readJson, SHA256, today } from './http';
import type { Env, ExecutionContext } from './types';

/**
 * Files stored once by content: R2 key `blobs/<sha256>`. Uploads stream through the Worker, which
 * checks the declared type against the real first bytes, counts bytes, and lets R2 verify the
 * SHA-256 (the put fails if the bytes do not match the name). Downloads check membership first,
 * then serve from the Cache API: a file named by its hash never changes.
 */
export const blobKey = (h: string) => `blobs/${h}`;

/** POST /api/blobs/check { hashes } -> { missing } */
export async function checkBlobs(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needMember(req, env, ctx);
  const body = obj(await readJson(req, 200_000), ['hashes']);
  if (!Array.isArray(body.hashes) || body.hashes.length > MANIFEST_LIMITS.files) throw new ApiError(`Send at most ${MANIFEST_LIMITS.files} hashes`);
  const asked = [...new Set(body.hashes.map(hash))];
  if (!asked.length) return json({ missing: [] });
  const have = await env.DB.prepare('SELECT hash FROM blobs WHERE hash IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(asked)).all<{ hash: string }>();
  const known = new Set(have.results.map((r) => r.hash));
  return json({ missing: asked.filter((h) => !known.has(h)) });
}

async function usage(env: Env, userId: string, column: 'download' | 'upload', bytes: number) {
  const [count, size] = column === 'download' ? ['downloads', 'download_bytes'] : ['uploads', 'upload_bytes'];
  await env.DB.prepare(`INSERT INTO usage_daily (day, user_id, ${count}, ${size}) VALUES (?1, ?2, 1, ?3)
    ON CONFLICT (day, user_id) DO UPDATE SET ${count} = ${count} + 1, ${size} = ${size} + ?3`).bind(today(), userId, bytes).run();
}

export async function bytesUsed(env: Env, userId: string): Promise<number> {
  return (await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS b FROM blobs WHERE first_uploader = ?1').bind(userId).first<{ b: number }>())?.b ?? 0;
}

/** PUT /api/blobs/<sha256> with the raw bytes, Content-Type and Content-Length. */
export async function putBlob(req: Request, env: Env, ctx: ExecutionContext, h0: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const h = hash(h0);
  if (env.UPLOAD_LIMITER && !(await env.UPLOAD_LIMITER.limit({ key: c.user.id })).success) throw new ApiError('Too many uploads in a minute. Wait a moment, then resume.', 429, 30);
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(BLOB_TYPES as readonly string[]).includes(type)) throw new ApiError('Only PDFs, images and pack files can be uploaded', 415);
  const size = Number(req.headers.get('content-length'));
  if (!Number.isInteger(size) || size < 1) throw new ApiError('Send the file size (Content-Length)', 411);
  if (size > MANIFEST_LIMITS.fileBytes) throw new ApiError('Files are limited to 25 MB each', 413);
  if (!req.body) throw new ApiError('The file is empty');

  if (await env.DB.prepare('SELECT 1 FROM blobs WHERE hash = ?1').bind(h).first()) {
    await req.body.cancel();
    return json({ stored: true, existed: true });
  }
  // Quota counts only bytes new to the bucket, attributed to the first uploader.
  const used = await bytesUsed(env, c.user.id);
  const limit = quotaOf(c.access);
  if (used + size > limit) {
    await req.body.cancel();
    throw new ApiError(`Upload quota reached: ${Math.round(used / 1048576)} of ${Math.round(limit / 1048576)} MB used. Delete an old set first.`, 413);
  }

  const fixed = new FixedLengthStream(size);
  const writer = fixed.writable.getWriter();
  const digest = new crypto.DigestStream('SHA-256');
  const dw = digest.getWriter();
  const pump = (async () => {
    const reader = req.body!.getReader();
    let seen = 0;
    let head = new Uint8Array(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += value.byteLength;
        if (seen > size) throw new ApiError('The file is larger than its stated size', 400);
        if (head.byteLength < 512) {
          const next = new Uint8Array(Math.min(512, head.byteLength + value.byteLength));
          next.set(head);
          next.set(value.subarray(0, next.byteLength - head.byteLength), head.byteLength);
          head = next;
          if (head.byteLength >= Math.min(512, size) && !sniffMatches(type, head)) throw new ApiError(`The file is not a real ${type === 'application/pdf' ? 'PDF' : type.replace('image/', '').toUpperCase()}`, 415);
        }
        await dw.write(value);
        await writer.write(value);
      }
      if (seen !== size) throw new ApiError('The upload was cut short. Resume to try again.', 400);
      await dw.close();
      await writer.close();
    } catch (e) {
      await reader.cancel().catch(() => {});
      await writer.abort(e).catch(() => {});
      await dw.abort(e).catch(() => {});
      throw e;
    }
  })();
  let putError: unknown = null;
  // R2 checks the SHA-256 itself and refuses to store bytes that do not match the name.
  const put = env.FILES.put(blobKey(h), fixed.readable, { httpMetadata: { contentType: type }, sha256: h }).catch((e: unknown) => { putError = e; return null; });
  await pump;
  await put;
  const actual = hex(await digest.digest);
  if (actual !== h) {
    // Defence in depth: never record bytes whose hash differs from their name.
    if (!putError) await env.FILES.delete(blobKey(h)).catch(() => {});
    throw new ApiError('The file did not match its hash. It may have changed while uploading; try again.', 400);
  }
  if (putError) throw putError;
  const now = Date.now();
  // Unpublished files count as orphaned from upload; publishing a version clears this.
  await env.DB.prepare('INSERT OR IGNORE INTO blobs (hash, size, type, first_uploader, created_at, orphaned_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(h, size, type, c.user.id, now).run();
  ctx.waitUntil(usage(env, c.user.id, 'upload', size));
  return json({ stored: true, existed: false }, 201);
}

/** A member may read a file a readable set points at, a file they uploaded, or any file if admin. */
async function mayRead(env: Env, c: Caller, h: string): Promise<{ type: string; size: number } | null> {
  return env.DB.prepare(
    `SELECT b.type, b.size FROM blobs b WHERE b.hash = ?1 AND (
       ?3 = 1 OR b.first_uploader = ?2 OR EXISTS (
         SELECT 1 FROM blob_refs r JOIN sets s ON s.id = r.set_id
          WHERE r.hash = b.hash AND (s.status = 'approved' OR s.owner = ?2)))`,
  ).bind(h, c.user.id, c.access.admin ? 1 : 0).first<{ type: string; size: number }>();
}

function parseRange(v: string | null, size: number): { offset: number; length: number } | null | 'invalid' {
  if (!v) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(v.trim());
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start: number, end: number;
  if (!m[1]) { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start > end || start >= size) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

/** GET /api/blob/<sha256>, with Range support so pdf.js can load page by page. */
export async function getBlob(req: Request, env: Env, ctx: ExecutionContext, h0: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  if (!SHA256.test(h0)) throw new ApiError('Not found', 404);
  const meta = await mayRead(env, c, h0);
  if (!meta) throw new ApiError('This file is not available to you', 404);
  const headers = new Headers({
    'Content-Type': meta.type,
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: `"${h0}"`,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
    // Files are data, never pages: an SVG opened directly cannot run anything.
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  });
  if (req.headers.get('if-none-match') === `"${h0}"`) return new Response(null, { status: 304, headers });
  const range = parseRange(req.headers.get('range'), meta.size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } });
  if (range) {
    const obj = await env.FILES.get(blobKey(h0), { range });
    if (!obj) throw new ApiError('This file is missing from storage', 404);
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);
    headers.set('Content-Length', String(range.length));
    if (range.offset === 0) ctx.waitUntil(usage(env, c.user.id, 'download', meta.size));
    return new Response(obj.body, { status: 206, headers });
  }
  ctx.waitUntil(usage(env, c.user.id, 'download', meta.size));
  // The cache key is internal and per file; access was checked above, before the cache.
  const cacheKey = new Request(`https://blob-cache.dmc.internal/${h0}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const hit = await cache?.match(cacheKey);
  if (hit) return new Response(hit.body, { status: 200, headers });
  const body = await env.FILES.get(blobKey(h0));
  if (!body) throw new ApiError('This file is missing from storage', 404);
  headers.set('Content-Length', String(meta.size));
  if (cache) {
    const [a, b] = body.body.tee();
    ctx.waitUntil(cache.put(cacheKey, new Response(b, { headers: { 'Content-Type': meta.type, 'Content-Length': String(meta.size), 'Cache-Control': 'public, max-age=31536000, immutable' } })).catch(() => {}));
    return new Response(a, { status: 200, headers });
  }
  return new Response(body.body, { status: 200, headers });
}
