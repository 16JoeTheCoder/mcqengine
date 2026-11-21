import { ensureHandle, HANDLE_RE, need, needMember, type Caller } from './auth';
import { ApiError, json, obj, readJson, sha256Hex, str } from './http';
import type { Env, ExecutionContext } from './types';

/**
 * Profiles: a school member's page that other members can open. Visible only inside the school
 * (never public, never indexed). The owner chooses "school" (members) or "private" (only them and
 * admins), and whether practice stats show. Personal (non-member) accounts have no public profile.
 * No messages and no follower feed: most users are school students under 18.
 */
const AVATAR_MAX = 512 * 1024;
const SUBJECTS_MAX = 8;

/** SQL true when user row `u` is a Library member (the rule in auth.accessOf, as SQL). */
export const MEMBER_SQL = (u: string) => `(${u}.email_verified = 1 AND (
  EXISTS (SELECT 1 FROM library_domains d WHERE ${u}.email LIKE '%@' || d.domain AND ${u}.hd = d.domain)
  OR EXISTS (SELECT 1 FROM library_allowlist l WHERE l.email = ${u}.email)
  OR EXISTS (SELECT 1 FROM library_admins a WHERE a.email = ${u}.email)))`;

/** SQL true when the viewer (bound as ?1, with admin flag ?2) may see profile row `u`. */
export const VISIBLE_SQL = (u: string) => `(${u}.suspended_at IS NULL AND (${u}.id = ?1 OR ?2 = 1 OR (${u}.visibility = 'school' AND ${MEMBER_SQL(u)})))`;

interface ProfileRow {
  id: string; handle: string; display_name: string; headline: string; bio: string; subjects: string; avatar_hash: string | null;
  visibility: 'school' | 'private'; show_stats: number; stats: string; created_at: number;
}

const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };

async function findVisible(env: Env, c: Caller, handle: string): Promise<ProfileRow> {
  if (!HANDLE_RE.test(handle)) throw new ApiError('No such profile', 404);
  const row = await env.DB.prepare(`SELECT u.* FROM users u WHERE u.handle = ?3 AND ${VISIBLE_SQL('u')}`).bind(c.user.id, c.access.admin ? 1 : 0, handle).first<ProfileRow>();
  if (!row) throw new ApiError('No such profile', 404);
  return row;
}

/** GET /api/profiles/<handle>: members only; the owner and admins see private profiles too. */
export async function getProfile(req: Request, env: Env, ctx: ExecutionContext, handle: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const p = await findVisible(env, c, handle);
  const mine = p.id === c.user.id;
  const [sets, stars] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT id, title, subject, paper_count AS paperCount, question_count AS questionCount, star_count AS stars, latest_version AS version, updated_at AS updatedAt
      FROM sets WHERE owner = ?1 AND (status = 'approved' OR ?2 = 1) ORDER BY updated_at DESC LIMIT 60`).bind(p.id, mine || c.access.admin ? 1 : 0),
    env.DB.prepare(`SELECT COALESCE(SUM(star_count), 0) AS n FROM sets WHERE owner = ?1 AND status = 'approved'`).bind(p.id),
  ]);
  return json({
    profile: {
      handle: p.handle, name: p.display_name, headline: p.headline, bio: p.bio, subjects: parse<string[]>(p.subjects, []),
      avatar: p.avatar_hash ? `/api/profiles/${p.handle}/avatar?v=${p.avatar_hash.slice(0, 12)}` : null,
      joined: p.created_at, mine, visibility: mine || c.access.admin ? p.visibility : undefined,
      showStats: !!p.show_stats, stats: p.show_stats || mine ? parse<Record<string, number>>(p.stats, {}) : null,
      starsReceived: (stars!.results[0] as { n: number }).n, sets: sets!.results,
    },
  }, 200, { 'Cache-Control': 'private, no-store' });
}

/** PATCH /api/me/profile { handle?, headline?, bio?, subjects?, visibility?, showStats?, stats? } */
export async function updateProfile(req: Request, env: Env): Promise<Response> {
  const c = await need(req, env);
  const b = obj(await readJson(req, 8192), ['handle', 'headline', 'bio', 'subjects', 'visibility', 'showStats', 'stats']);
  const plain = (v: string, what: string) => { if (/[\p{Cc}<>]/u.test(v.replace(/\n/g, ''))) throw new ApiError(`${what} must be plain text`); return v; };
  const sets: string[] = [];
  const vals: unknown[] = [c.user.id];
  const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = ?${vals.length}`); };
  if (b.handle !== undefined) {
    const h = str(b.handle, 'Profile name', 30, 3).trim().toLowerCase();
    if (!HANDLE_RE.test(h)) throw new ApiError('Profile names use 3 to 30 letters, digits, dots, dashes or underscores');
    const taken = await env.DB.prepare('SELECT 1 FROM users WHERE handle = ?1 AND id <> ?2').bind(h, c.user.id).first();
    if (taken) throw new ApiError('That profile name is taken', 409);
    put('handle', h);
  }
  if (b.headline !== undefined) put('headline', plain(str(b.headline, 'Headline', 80).trim(), 'Headline'));
  if (b.bio !== undefined) put('bio', plain(str(b.bio, 'Bio', 160).trim(), 'Bio'));
  if (b.subjects !== undefined) {
    if (!Array.isArray(b.subjects) || b.subjects.length > SUBJECTS_MAX) throw new ApiError(`List at most ${SUBJECTS_MAX} subjects`);
    put('subjects', JSON.stringify([...new Set(b.subjects.map((x) => plain(str(x, 'Subject', 40, 1).trim(), 'Subject')))]));
  }
  if (b.visibility !== undefined) {
    if (b.visibility !== 'school' && b.visibility !== 'private') throw new ApiError('Visibility is school or private');
    put('visibility', b.visibility);
  }
  if (b.showStats !== undefined) put('show_stats', b.showStats === true ? 1 : 0);
  if (b.stats !== undefined) {
    const st = obj(b.stats, ['sessions', 'questions', 'accuracy', 'papers', 'streak']);
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(st)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e7) throw new ApiError(`stats.${k} must be a number`);
      clean[k] = k === 'accuracy' ? Math.min(100, Math.round(v)) : Math.round(v);
    }
    put('stats', JSON.stringify(clean));
  }
  if (!sets.length) throw new ApiError('Nothing to change');
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?1`).bind(...vals).run();
  return json({ ok: true, handle: b.handle !== undefined ? String(b.handle).trim().toLowerCase() : await ensureHandle(env, c.user) });
}

const AVATAR_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};

/** PUT /api/me/avatar (image body, at most 512 KB) and DELETE /api/me/avatar. */
export async function putAvatar(req: Request, env: Env): Promise<Response> {
  const c = await need(req, env);
  const key = (h: string) => `avatars/${c.user.id}/${h}`;
  const old = await env.DB.prepare('SELECT avatar_hash FROM users WHERE id = ?1').bind(c.user.id).first<{ avatar_hash: string | null }>();
  if (req.method === 'DELETE') {
    if (old?.avatar_hash) await env.FILES.delete(key(old.avatar_hash));
    await env.DB.prepare('UPDATE users SET avatar_hash = NULL WHERE id = ?1').bind(c.user.id).run();
    return json({ ok: true });
  }
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim();
  const sniff = AVATAR_TYPES[type];
  if (!sniff) throw new ApiError('Use a WebP, PNG or JPEG image', 415);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > AVATAR_MAX) throw new ApiError('Photos are limited to 512 KB', 413);
  if (bytes.length < 12 || !sniff(bytes)) throw new ApiError('That file is not the image it claims to be', 415);
  const hash = await sha256Hex(bytes);
  await env.FILES.put(key(hash), bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare('UPDATE users SET avatar_hash = ?2 WHERE id = ?1').bind(c.user.id, hash).run();
  if (old?.avatar_hash && old.avatar_hash !== hash) await env.FILES.delete(key(old.avatar_hash));
  return json({ ok: true, hash }, 201);
}

/** GET /api/profiles/<handle>/avatar: same visibility as the profile. */
export async function getAvatar(req: Request, env: Env, ctx: ExecutionContext, handle: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const p = await findVisible(env, c, handle);
  if (!p.avatar_hash) throw new ApiError('No photo', 404);
  const o = await env.FILES.get(`avatars/${p.id}/${p.avatar_hash}`);
  if (!o) throw new ApiError('No photo', 404);
  return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType ?? 'image/webp', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
}

/** POST /api/profiles/<handle>/report { reason }: goes to the admin queue. */
export async function reportProfile(req: Request, env: Env, ctx: ExecutionContext, handle: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const p = await findVisible(env, c, handle);
  if (p.id === c.user.id) throw new ApiError('You cannot report your own profile');
  const b = obj(await readJson(req, 4096), ['reason']);
  const reason = str(b.reason, 'Reason', 500, 1).trim();
  await env.DB.prepare('INSERT INTO profile_reports (user_id, reporter, reason, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (user_id, reporter) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at')
    .bind(p.id, c.user.id, reason, Date.now()).run();
  return json({ ok: true }, 201);
}
