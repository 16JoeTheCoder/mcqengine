import { access, backups, downloads, moderation, storage } from './admin';
import { devLogin, finishGoogle, logout, me, need, startGoogle, updateMe } from './auth';
import { collectGarbage, runBackup } from './backup';
import { checkBlobs, getBlob, putBlob } from './blobs';
import { ApiError, fail, json, obj, readJson } from './http';
import { deleteSet, getSet, listSets, lookupPapers, publishVersion, report, star, updateSet } from './library';
import { pull, push } from './sync';
import type { Env, ExecutionContext, ScheduledController } from './types';

/**
 * The DMC Worker: serves the static app (assets) and every /api route. It replaces Supabase.
 * Each route checks auth and membership itself; the app never decides access.
 */
export type { Env } from './types';

type Handler = (req: Request, env: Env, ctx: ExecutionContext, ...params: string[]) => Promise<Response>;
const ROUTES: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/health$/, health],
  ['POST', /^\/api\/client-error$/, clientError],
  ['GET', /^\/api\/auth\/google$/, (r, e) => startGoogle(r, e)],
  ['GET', /^\/api\/auth\/google\/callback$/, (r, e) => finishGoogle(r, e)],
  ['POST', /^\/api\/auth\/logout$/, (r, e) => logout(r, e)],
  ['POST', /^\/api\/auth\/dev$/, (r, e) => devLogin(r, e)],
  ['GET', /^\/api\/me$/, me],
  ['PATCH', /^\/api\/me$/, (r, e) => updateMe(r, e)],
  ['GET', /^\/api\/me\/backup$/, personalBackup],
  ['PUT', /^\/api\/me\/backup$/, personalBackup],
  ['DELETE', /^\/api\/me\/backup$/, personalBackup],
  ['GET', /^\/api\/sets$/, listSets],
  ['GET', /^\/api\/sets\/([^/]+)$/, (r, e, c, id) => getSet(r, e, c, id!)],
  ['GET', /^\/api\/sets\/([^/]+)\/versions\/(\d{1,7})$/, (r, e, c, id, v) => getSet(r, e, c, id!, Number(v))],
  ['POST', /^\/api\/sets\/([^/]+)\/versions$/, (r, e, c, id) => publishVersion(r, e, c, id!)],
  ['PATCH', /^\/api\/sets\/([^/]+)$/, (r, e, c, id) => updateSet(r, e, c, id!)],
  ['DELETE', /^\/api\/sets\/([^/]+)$/, (r, e, c, id) => deleteSet(r, e, c, id!)],
  ['PUT', /^\/api\/sets\/([^/]+)\/star$/, (r, e, c, id) => star(r, e, c, id!)],
  ['POST', /^\/api\/sets\/([^/]+)\/report$/, (r, e, c, id) => report(r, e, c, id!)],
  ['POST', /^\/api\/papers\/lookup$/, lookupPapers],
  ['POST', /^\/api\/blobs\/check$/, checkBlobs],
  ['PUT', /^\/api\/blobs\/([^/]+)$/, (r, e, c, h) => putBlob(r, e, c, h!)],
  ['GET', /^\/api\/blob\/([^/]+)$/, (r, e, c, h) => getBlob(r, e, c, h!)],
  ['HEAD', /^\/api\/blob\/([^/]+)$/, (r, e, c, h) => getBlob(r, e, c, h!)],
  ['POST', /^\/api\/sync\/push$/, push],
  ['GET', /^\/api\/sync\/pull$/, pull],
  ['GET', /^\/api\/admin\/storage$/, storage],
  ['GET', /^\/api\/admin\/downloads$/, downloads],
  ['GET', /^\/api\/admin\/moderation$/, moderation],
  ['GET', /^\/api\/admin\/backups$/, backups],
  ['POST', /^\/api\/admin\/backups$/, backups],
  ...(['allowlist', 'admins', 'domains'] as const).flatMap((l) => (['GET', 'POST', 'DELETE'] as const).map((m): [string, RegExp, Handler] => [m, new RegExp(`^/api/admin/${l}$`), (r, e, c) => access(r, e, c, l)])),
];

/**
 * Cross-site request forgery: cookies are SameSite=Lax, and every state-changing request must
 * come from this app (matching Origin, and the X-DMC header a cross-site form cannot set).
 */
function sameOrigin(req: Request, env: Env): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const self = (env.APP_ORIGIN?.replace(/\/+$/, '') || new URL(req.url).origin);
  const o = req.headers.get('origin');
  if (o && o !== self && o !== new URL(req.url).origin) return false;
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false;
  return req.headers.get('x-dmc') === '1';
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  let allowed: string[] = [];
  for (const [method, re, handler] of ROUTES) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    if (method !== req.method) { allowed.push(method); continue; }
    try {
      if (!sameOrigin(req, env)) throw new ApiError('Use DMC from its own site', 403);
      return await handler(req, env, ctx, ...m.slice(1).map((x) => decodeURIComponent(x ?? '')));
    } catch (e) {
      return fail(e, `${req.method} ${re.source}`);
    }
  }
  allowed = [...new Set(allowed)];
  return allowed.length ? json({ error: 'Method not allowed' }, 405, { Allow: allowed.join(', ') }) : json({ error: 'Not found' }, 404);
}

/** GET /api/health: D1, R2 and whether sign-in is configured. No personal data, no auth. */
async function health(_req: Request, env: Env): Promise<Response> {
  const check = async (f: () => Promise<unknown>) => { try { await f(); return true; } catch { return false; } };
  const [d1, r2] = await Promise.all([check(() => env.DB.prepare('SELECT 1').first()), check(() => env.FILES.head('health-check'))]);
  const ok = d1 && r2;
  return json({ ok, d1, r2, auth: { configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET) }, environment: env.ENVIRONMENT ?? 'unknown' }, ok ? 200 : 503);
}

/** POST /api/client-error: the app reports its own errors. Rate-limited; personal data scrubbed. */
async function clientError(req: Request, env: Env): Promise<Response> {
  const key = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (env.ERROR_LIMITER && !(await env.ERROR_LIMITER.limit({ key })).success) return json({ ok: false }, 429);
  const body = obj(await readJson(req, 16_384), ['message', 'stack', 'route', 'version', 'kind']);
  const scrub = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max).replace(/[^\s@]+@[^\s@]+/g, '<email>').replace(/\b[0-9a-f]{32,}\b/gi, '<hash>').replace(/[?#][^\s)]*/g, '') : undefined);
  console.error(JSON.stringify({ level: 'client-error', kind: scrub(body.kind, 40), message: scrub(body.message, 500), stack: scrub(body.stack, 2000), route: scrub(body.route, 100), version: scrub(body.version, 40) }));
  return json({ ok: true }, 202);
}

/** One private pack backup per account at user-backups/<id>/packs.zip, at most 200 MB. */
async function personalBackup(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const c = await need(req, env, ctx);
  const key = `user-backups/${c.user.id}/packs.zip`;
  if (req.method === 'GET') {
    const o = await env.FILES.get(key);
    if (!o) throw new ApiError('No cloud copy yet', 404);
    return new Response(o.body, { headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (req.method === 'DELETE') {
    await env.FILES.delete(key);
    await env.DB.prepare('DELETE FROM user_backups WHERE user_id = ?1').bind(c.user.id).run();
    return json({ ok: true });
  }
  const size = Number(req.headers.get('content-length'));
  if (!Number.isInteger(size) || size < 22) throw new ApiError('Send the backup with its size', 411);
  if (size > 200 * 1024 * 1024) throw new ApiError('Cloud copies are limited to 200 MB', 413);
  if (!(req.headers.get('content-type') ?? '').startsWith('application/zip') || !req.body) throw new ApiError('Send a zip file', 415);
  const fixed = new FixedLengthStream(size);
  const [put] = await Promise.all([env.FILES.put(key, fixed.readable, { httpMetadata: { contentType: 'application/zip' } }), req.body.pipeTo(fixed.writable)]);
  if (!put) throw new ApiError('The backup could not be stored', 500);
  await env.DB.prepare('INSERT INTO user_backups (user_id, size, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (user_id) DO UPDATE SET size = excluded.size, updated_at = excluded.updated_at').bind(c.user.id, size, Date.now()).run();
  return json({ ok: true, size }, 201);
}

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      const res = await route(req, env, ctx);
      for (const [k, v] of Object.entries(SECURITY)) if (!res.headers.has(k)) try { res.headers.set(k, v); } catch { /* immutable (streamed) */ }
      return res;
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return json({ error: 'Not found' }, 404);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 17:00 UTC is 00:00 in Asia/Jakarta: the nightly backup, then file collection.
    ctx.waitUntil((async () => {
      try { await runBackup(env, controller.scheduledTime); } catch (e) { console.error(JSON.stringify({ level: 'error', route: 'cron/backup', message: (e as Error).message })); }
      try { await collectGarbage(env, controller.scheduledTime); } catch (e) { console.error(JSON.stringify({ level: 'error', route: 'cron/gc', message: (e as Error).message })); }
    })());
  },
};
