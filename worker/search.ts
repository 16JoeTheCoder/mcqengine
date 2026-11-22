import { caller } from './auth';
import { ApiError, json } from './http';
import { VISIBLE_SQL } from './profiles';
import type { Env, ExecutionContext } from './types';

/**
 * GET /api/search?q=: Library sets and profiles the caller may see, through the same rules as
 * their own routes (approved sets, the caller's own, everything for admins; profiles by
 * visibility). Non-members get empty results, never an error, so the app's search box works for
 * everyone (it searches the device as well).
 */
export function ftsQuery(q: string): string | null {
  const words = q.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = [...new Set(words)].filter((w) => w.length >= 1).slice(0, 8);
  return terms.length ? terms.map((w) => `"${w}"*`).join(' ') : null;
}

export async function search(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  if (q.length > 200) throw new ApiError('Search for at most 200 characters');
  const c = await caller(req, env, ctx);
  const match = ftsQuery(q);
  if (!c?.access.member || !match) return json({ sets: [], people: [] });
  const admin = c.access.admin ? 1 : 0;
  const [sets, people] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT s.id, s.title, s.subject, s.owner_name AS ownerName, s.paper_count AS paperCount, s.latest_version AS version
      FROM sets_fts f JOIN sets s ON s.rowid = f.rowid
      WHERE sets_fts MATCH ?3 AND (s.status = 'approved' OR s.owner = ?1 OR ?2 = 1)
      ORDER BY bm25(sets_fts, 4.0, 1.0, 2.0, 1.0) LIMIT 20`).bind(c.user.id, admin, match),
    env.DB.prepare(`SELECT u.handle, u.display_name AS name, u.headline
      FROM users_fts f JOIN users u ON u.rowid = f.rowid
      WHERE users_fts MATCH ?3 AND u.handle IS NOT NULL AND ${VISIBLE_SQL('u')}
      ORDER BY bm25(users_fts, 4.0, 3.0, 1.0, 1.0) LIMIT 10`).bind(c.user.id, admin, match),
  ]);
  return json({ sets: sets!.results, people: people!.results }, 200, { 'Cache-Control': 'private, no-store' });
}
