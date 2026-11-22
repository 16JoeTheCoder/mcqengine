import { ApiError, json, obj, sha256Hex, str, email as emailOf, readJson } from './http';
import type { Env, ExecutionContext } from './types';

/**
 * Google sign-in (OAuth authorization code with PKCE) and sessions.
 *
 * * The browser never sees a Google token. The Worker exchanges the code, verifies the ID token
 *   (RS256 signature against Google's JWKS, iss, aud, exp, iat, nonce, email_verified) and starts
 *   a session.
 * * A session is 32 random bytes in an HttpOnly, Secure, SameSite=Lax cookie. D1 stores only
 *   its SHA-256. Sessions roll on use (30 days idle) and end after 90 days regardless.
 * * Library membership is decided here from the verified email, its `hd` claim and the
 *   admin-managed tables. The app only reads the verdict.
 */
export const SESSION_COOKIE = '__Host-dmc_session';
const OAUTH_COOKIE = '__Host-dmc_oauth';
export const IDLE_MS = 30 * 86_400_000;
export const ABSOLUTE_MS = 90 * 86_400_000;
const ROLL_AFTER_MS = 3_600_000;
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
export const MEMBER_QUOTA = 300 * 1024 * 1024;
export const STAFF_QUOTA = 2 * 1024 * 1024 * 1024;

export interface User { id: string; email: string; email_verified: number; hd: string | null; display_name: string; role: string | null; handle?: string | null; quota_bytes?: number | null }
export interface Access { member: boolean; admin: boolean; allowlisted: boolean; school: boolean }
export interface Caller { user: User; access: Access; tokenHash: string }

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** "josef.yang@stjbs.sch.id" -> "Josef Yang". Split on . _ -, title-case, at most 80 characters. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const words = local.split(/[._-]+/).filter((w) => /[a-z]/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return (words.join(' ') || local || 'DMC user').slice(0, 80);
}

export function cookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}
const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function secret(env: Env): string {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new ApiError('Sign-in is not configured on this server', 503);
  return env.SESSION_SECRET;
}
const origin = (req: Request, env: Env) => (env.APP_ORIGIN?.replace(/\/+$/, '') || new URL(req.url).origin);
/** Only hash routes inside this app: "#/library", never another site. */
export const safeReturn = (r: string | null) => (r && /^#\/[A-Za-z0-9/_\-.~%]{0,200}$/.test(r) ? r : '#/');

/** GET /api/auth/google?return=#/library&school=1 */
export async function startGoogle(req: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new ApiError('Google sign-in is not configured on this server', 503);
  const url = new URL(req.url);
  const verifier = random(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = random(24);
  const nonce = random(24);
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ s: state, n: nonce, v: verifier, r: safeReturn(url.searchParams.get('return')), e: Date.now() + 600_000 })));
  const signed = `${payload}.${await hmac(secret(env), payload)}`;
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin(req, env)}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  // A hint for Google's account chooser only; membership is checked from the verified token.
  if (url.searchParams.get('school') === '1') q.set('hd', 'stjbs.sch.id');
  return new Response(null, { status: 302, headers: { Location: `${GOOGLE_AUTH}?${q}`, 'Set-Cookie': cookie(OAUTH_COOKIE, signed, 600), 'Cache-Control': 'no-store' } });
}

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let jwksCache: { keys: Jwk[]; until: number } | null = null;
export const resetJwksCache = () => { jwksCache = null; };
async function jwks(force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.until > Date.now()) return jwksCache.keys;
  const r = await fetch(GOOGLE_JWKS, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new ApiError('Google sign-in is unavailable. Try again.', 503);
  const body = (await r.json()) as { keys?: Jwk[] };
  const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  jwksCache = { keys: body.keys ?? [], until: Date.now() + Math.min(Math.max(maxAge, 300), 86_400) * 1000 };
  return jwksCache.keys;
}

export interface GoogleClaims { sub: string; email: string; email_verified: boolean; hd?: string; name?: string }
/** Verifies a Google ID token completely. Throws ApiError(401) on any failure. */
export async function verifyIdToken(token: string, clientId: string, nonce: string, now = Date.now()): Promise<GoogleClaims> {
  const bad = (why: string): never => { throw new ApiError(`Google sign-in could not be verified (${why})`, 401); };
  const parts = token.split('.');
  if (parts.length !== 3) bad('format');
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]!)));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!)));
  } catch { return bad('format'); }
  if (header.alg !== 'RS256' || !header.kid) bad('algorithm');
  let jwk = (await jwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await jwks(true)).find((k) => k.kid === header.kid); // keys rotate
  if (!jwk) bad('unknown key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk!.kty, n: jwk!.n, e: jwk!.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) bad('signature');
  const sec = now / 1000;
  if (!ISSUERS.includes(String(claims.iss))) bad('issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) bad('audience');
  if (aud.length > 1 && claims.azp !== clientId) bad('authorized party');
  if (typeof claims.exp !== 'number' || claims.exp < sec - 60) bad('expired');
  if (typeof claims.iat !== 'number' || claims.iat > sec + 300) bad('issued in the future');
  if (claims.nonce !== nonce) bad('nonce');
  if (claims.email_verified !== true) bad('email not verified');
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') bad('claims');
  return { sub: claims.sub as string, email: (claims.email as string).toLowerCase(), email_verified: true, ...(typeof claims.hd === 'string' ? { hd: claims.hd.toLowerCase() } : {}), ...(typeof claims.name === 'string' ? { name: claims.name } : {}) };
}

/** Finds the account by Google subject, then by email (accounts migrated from Supabase), or creates it. */
export async function upsertUser(env: Env, c: GoogleClaims, now = Date.now()): Promise<User> {
  const db = env.DB;
  let u = await db.prepare('SELECT * FROM users WHERE google_sub = ?1').bind(c.sub).first<User>();
  if (!u) {
    u = await db.prepare('SELECT * FROM users WHERE email = ?1 AND google_sub IS NULL').bind(c.email).first<User>();
    if (u) await db.prepare('UPDATE users SET google_sub = ?2 WHERE id = ?1').bind(u.id, c.sub).run();
  }
  if (!u) {
    const id = crypto.randomUUID();
    // Another Google account may have held this email earlier (a recycled address): release it.
    await db.batch([
      db.prepare("UPDATE users SET email = 'released+' || id || '@invalid' WHERE email = ?1").bind(c.email),
      db.prepare('INSERT INTO users (id, email, email_verified, google_sub, hd, display_name, created_at, last_seen_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?6)').bind(id, c.email, c.sub, c.hd ?? null, nameFromEmail(c.email), now),
    ]);
    return (await db.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<User>())!;
  }
  await db.prepare('UPDATE users SET email = ?2, email_verified = 1, hd = ?3, last_seen_at = ?4 WHERE id = ?1').bind(u.id, c.email, c.hd ?? null, now).run();
  return { ...u, email: c.email, email_verified: 1, hd: c.hd ?? null };
}

export async function createSession(env: Env, userId: string, now = Date.now()): Promise<string> {
  const token = random(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, absolute_expires_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?3)')
    .bind(await sha256Hex(token), userId, now, now + IDLE_MS, now + ABSOLUTE_MS).run();
  return cookie(SESSION_COOKIE, token, IDLE_MS / 1000);
}

/** GET /api/auth/google/callback. Errors return to the app with ?signin=failed, never a JSON page. */
export async function finishGoogle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const back = (hash: string, setCookie: string[] = []) => {
    const h = new Headers({ Location: `${origin(req, env)}/${hash}`, 'Cache-Control': 'no-store' });
    h.append('Set-Cookie', cookie(OAUTH_COOKIE, '', 0));
    for (const c of setCookie) h.append('Set-Cookie', c);
    return new Response(null, { status: 302, headers: h });
  };
  try {
    const raw = cookies(req).get(OAUTH_COOKIE) ?? '';
    const [payload, sig] = raw.split('.');
    if (!payload || !sig || !timingSafeEqual(sig, await hmac(secret(env), payload))) throw new ApiError('Sign-in expired. Start again.', 400);
    const st = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { s: string; n: string; v: string; r: string; e: number };
    if (st.e < Date.now() || !timingSafeEqual(st.s, url.searchParams.get('state') ?? '')) throw new ApiError('Sign-in expired. Start again.', 400);
    const code = url.searchParams.get('code');
    if (!code) throw new ApiError('Sign-in was cancelled', 400);
    const r = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${origin(req, env)}/api/auth/google/callback`, grant_type: 'authorization_code', code_verifier: st.v }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new ApiError('Google refused the sign-in', 401);
    const tok = (await r.json()) as { id_token?: string };
    if (!tok.id_token) throw new ApiError('Google returned no identity', 401);
    const claims = await verifyIdToken(tok.id_token, env.GOOGLE_CLIENT_ID!, st.n);
    const user = await upsertUser(env, claims);
    if ((user as User & { suspended_at?: number | null }).suspended_at) return back('#/?signin=suspended');
    return back(safeReturn(st.r), [await createSession(env, user.id)]);
  } catch (e) {
    console.warn(JSON.stringify({ level: 'warn', route: 'auth/callback', message: (e as Error).message.slice(0, 200) }));
    return back('#/?signin=failed');
  }
}

export async function accessOf(env: Env, u: Pick<User, 'email' | 'email_verified' | 'hd'>): Promise<Access> {
  if (!u.email_verified) return { member: false, admin: false, allowlisted: false, school: false };
  const domain = u.email.split('@')[1] ?? '';
  const row = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM library_allowlist WHERE email = ?1) AS allow,
            EXISTS (SELECT 1 FROM library_domains WHERE domain = ?2) AS dom,
            EXISTS (SELECT 1 FROM library_admins WHERE email = ?1) AS adm`,
  ).bind(u.email, domain).first<{ allow: number; dom: number; adm: number }>();
  // School accounts need both the domain and Google's hosted-domain claim (a Workspace account,
  // not a personal Google account that happens to use the address).
  const school = !!row?.dom && u.hd === domain;
  const allowlisted = !!row?.allow;
  const admin = !!row?.adm;
  return { member: school || allowlisted || admin, admin, allowlisted, school };
}

export const quotaOf = (a: Access, override?: number | null) => override ?? (a.admin || a.allowlisted ? STAFF_QUOTA : MEMBER_QUOTA);

/** Profile handles: 3 to 30 of a-z, 0-9, dot, dash, underscore; starting with a letter or digit. */
export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
export function handleBase(email: string): string {
  const local = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '').replace(/^[._-]+/, '').slice(0, 24);
  return local.length >= 3 ? local : `user${local}`.slice(0, 24);
}
/** Gives an account a unique handle from its email the first time it is needed. */
export async function ensureHandle(env: Env, u: Pick<User, 'id' | 'email' | 'handle'>): Promise<string> {
  if (u.handle) return u.handle;
  const base = handleBase(u.email);
  for (let n = 0; n < 6; n++) {
    const h = n === 0 ? base : n < 5 ? `${base}${n + 1}` : `${base}-${u.id.slice(0, 6)}`;
    const r = await env.DB.prepare('UPDATE users SET handle = ?2 WHERE id = ?1 AND handle IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE handle = ?2)').bind(u.id, h).run();
    if (r.meta.changes) return h;
    const now = await env.DB.prepare('SELECT handle FROM users WHERE id = ?1').bind(u.id).first<{ handle: string | null }>();
    if (now?.handle) return now.handle;
  }
  throw new ApiError('Could not give this account a profile name', 500);
}

/** The signed-in caller, or null. Rolls the session forward at most once an hour. */
export async function caller(req: Request, env: Env, ctx?: ExecutionContext, now = Date.now()): Promise<Caller | null> {
  const token = cookies(req).get(SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.email_verified, u.hd, u.display_name, u.role, u.handle, u.quota_bytes, s.last_used_at, s.absolute_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND s.absolute_expires_at > ?2 AND u.suspended_at IS NULL`,
  ).bind(tokenHash, now).first<User & { last_used_at: number; absolute_expires_at: number }>();
  if (!row) return null;
  if (now - row.last_used_at > ROLL_AFTER_MS) {
    const roll = env.DB.prepare('UPDATE sessions SET expires_at = ?2, last_used_at = ?3 WHERE token_hash = ?1').bind(tokenHash, Math.min(now + IDLE_MS, row.absolute_expires_at), now).run();
    if (ctx) ctx.waitUntil(roll); else await roll;
  }
  const { last_used_at: _l, absolute_expires_at: _a, ...user } = row;
  return { user, access: await accessOf(env, user), tokenHash };
}

export async function need(req: Request, env: Env, ctx?: ExecutionContext): Promise<Caller> {
  const c = await caller(req, env, ctx);
  if (!c) throw new ApiError('Sign in first', 401);
  return c;
}
export async function needMember(req: Request, env: Env, ctx?: ExecutionContext): Promise<Caller> {
  const c = await need(req, env, ctx);
  if (!c.access.member) throw new ApiError('The Library is for school accounts', 403);
  return c;
}
export async function needAdmin(req: Request, env: Env, ctx?: ExecutionContext): Promise<Caller> {
  const c = await need(req, env, ctx);
  if (!c.access.admin) throw new ApiError('Admins only', 403);
  return c;
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = cookies(req).get(SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
}

/** GET /api/me: the account, the server's verdict on access, and the sync default. */
export async function me(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const c = await caller(req, env, ctx);
  if (!c) return json({ account: null, status: { member: false, admin: false } });
  const used = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS b FROM blobs WHERE first_uploader = ?1').bind(c.user.id).first<{ b: number }>();
  const handle = await ensureHandle(env, c.user);
  return json({
    account: { id: c.user.id, email: c.user.email, emailVerified: !!c.user.email_verified, name: c.user.display_name, handle },
    status: { member: c.access.member, admin: c.access.admin },
    // Sync is on by default for school accounts; anyone can turn it off in Settings.
    syncDefault: c.access.school,
    quota: { used: used?.b ?? 0, limit: quotaOf(c.access, c.user.quota_bytes) },
  });
}

/** PATCH /api/me { name } */
export async function updateMe(req: Request, env: Env): Promise<Response> {
  const c = await need(req, env);
  const body = obj(await readJson(req, 4096), ['name']);
  const name = str(body.name, 'Name', 80, 1).trim().replace(/\s+/g, ' ');
  if (/[\p{Cc}<>]/u.test(name)) throw new ApiError('Name must be plain text');
  await env.DB.prepare('UPDATE users SET display_name = ?2 WHERE id = ?1').bind(c.user.id, name).run();
  return json({ name });
}

/** POST /api/auth/dev { email, hd? } — local development and end-to-end tests only. */
export async function devLogin(req: Request, env: Env): Promise<Response> {
  const host = new URL(req.url).hostname;
  if (env.ENVIRONMENT !== 'local' || env.DEV_LOGIN !== '1' || !['localhost', '127.0.0.1'].includes(host)) throw new ApiError('Not found', 404);
  const body = obj(await readJson(req, 4096), ['email', 'hd']);
  const e = emailOf(body.email);
  const hd = body.hd === undefined ? (e.endsWith('@stjbs.sch.id') ? 'stjbs.sch.id' : undefined) : str(body.hd, 'hd', 100);
  const user = await upsertUser(env, { sub: `dev:${e}`, email: e, email_verified: true, ...(hd ? { hd } : {}) });
  return json({ ok: true, id: user.id }, 200, { 'Set-Cookie': await createSession(env, user.id) });
}
