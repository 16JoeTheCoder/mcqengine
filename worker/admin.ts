import { ensureHandle, needAdmin } from './auth';
import { FP_SAME, similarity } from '../shared/fingerprint';
import { MEMBER_SQL } from './profiles';
import { listBackups, runBackup } from './backup';
import { ApiError, email, int, json, obj, readJson, str, uuid } from './http';
import type { D1PreparedStatement, Env, ExecutionContext } from './types';

/** Admin dashboard: overview, users, content, access and operations. Admins only; every change is audited. */

/** One audit row, to add to the same batch as the change it records. */
export const audit = (env: Env, actor: string, action: string, target: string, detail: Record<string, unknown> = {}): D1PreparedStatement =>
  env.DB.prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5)').bind(Date.now(), actor, action, target, JSON.stringify(detail).slice(0, 2000));
export const FREE_TIER_BYTES = 10 * 1000 * 1000 * 1000;

/** GET /api/admin/storage */
export async function storage(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  const [total, per, backups] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS bytes, count(*) AS files FROM blobs'),
    env.DB.prepare(`SELECT b.first_uploader AS user_id, u.email, u.display_name AS name, SUM(b.size) AS bytes, count(*) AS files
      FROM blobs b LEFT JOIN users u ON u.id = b.first_uploader GROUP BY b.first_uploader ORDER BY bytes DESC LIMIT 200`),
    env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS bytes, count(*) AS n FROM user_backups'),
  ]);
  const backupBytes = [...(await listBackups(env, 'daily')), ...(await listBackups(env, 'weekly'))].reduce((a, b) => a + b.bytes, 0);
  const t = total!.results[0] as { bytes: number; files: number };
  const pb = backups!.results[0] as { bytes: number; n: number };
  return json({
    freeTierBytes: FREE_TIER_BYTES,
    totalBytes: t.bytes + backupBytes + pb.bytes,
    libraryBytes: t.bytes,
    files: t.files,
    databaseBackupBytes: backupBytes,
    personalBackupBytes: pb.bytes,
    perAccount: per!.results,
  });
}

/** GET /api/admin/downloads?days=14 */
export async function downloads(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get('days')) || 14));
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await env.DB.prepare(`SELECT d.day, d.user_id, u.email, u.display_name AS name, d.downloads, d.download_bytes, d.uploads, d.upload_bytes
    FROM usage_daily d LEFT JOIN users u ON u.id = d.user_id WHERE d.day >= ?1 ORDER BY d.day DESC, d.download_bytes DESC LIMIT 2000`).bind(since).all();
  return json({ since, rows: rows.results });
}

type ListName = 'allowlist' | 'admins' | 'domains';
const TABLE: Record<ListName, { table: string; key: string }> = {
  allowlist: { table: 'library_allowlist', key: 'email' },
  admins: { table: 'library_admins', key: 'email' },
  domains: { table: 'library_domains', key: 'domain' },
};

/** GET/POST/DELETE /api/admin/<allowlist|admins|domains> */
export async function access(req: Request, env: Env, ctx: ExecutionContext, list: ListName): Promise<Response> {
  const c = await needAdmin(req, env, ctx);
  const { table, key } = TABLE[list];
  if (req.method === 'GET') return json({ items: (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()).results });
  const body = obj(await readJson(req, 4096), [key, 'note']);
  const value = key === 'email' ? email(body.email) : domainOf(body.domain);
  if (req.method === 'POST') {
    const stmt = list === 'domains' ? env.DB.prepare('INSERT OR IGNORE INTO library_domains (domain) VALUES (?1)').bind(value)
      : list === 'allowlist' ? env.DB.prepare('INSERT INTO library_allowlist (email, note, added_at, added_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (email) DO UPDATE SET note = excluded.note').bind(value, body.note === undefined ? '' : str(body.note, 'Note', 200), Date.now(), c.user.email)
      : env.DB.prepare('INSERT OR IGNORE INTO library_admins (email, added_at, added_by) VALUES (?1, ?2, ?3)').bind(value, Date.now(), c.user.email);
    await env.DB.batch([stmt, audit(env, c.user.email, `${list}.add`, value)]);
    return json({ ok: true }, 201);
  }
  if (req.method === 'DELETE') {
    if (list === 'admins' && value === c.user.email) throw new ApiError('You cannot remove yourself. Ask another admin.', 409);
    if (list === 'admins' && ((await env.DB.prepare('SELECT count(*) AS n FROM library_admins').first<{ n: number }>())?.n ?? 0) <= 1) throw new ApiError('Keep at least one admin', 409);
    await env.DB.batch([env.DB.prepare(`DELETE FROM ${table} WHERE ${key} = ?1`).bind(value), audit(env, c.user.email, `${list}.remove`, value)]);
    return json({ ok: true });
  }
  throw new ApiError('Method not allowed', 405);
}

function domainOf(v: unknown): string {
  const d = typeof v === 'string' ? v.trim().toLowerCase().replace(/^@/, '') : '';
  if (d.length > 100 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new ApiError('Enter a domain such as stjbs.sch.id');
  return d;
}

/** GET /api/admin/moderation: hidden or reported sets, with their reports. */
export async function moderation(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  const sets = await env.DB.prepare(`SELECT s.id, s.title, s.owner_name AS ownerName, s.status, s.report_count AS reports, s.updated_at AS updatedAt,
      (SELECT json_group_array(json_object('reason', r.reason, 'at', r.created_at)) FROM reports r WHERE r.set_id = s.id) AS reasons
    FROM sets s WHERE s.status = 'hidden' OR s.report_count > 0 ORDER BY s.status = 'hidden' DESC, s.report_count DESC LIMIT 200`).all<{ reasons: string }>();
  const people = await env.DB.prepare(`SELECT u.id, u.handle, u.display_name AS name, u.visibility, count(r.reporter) AS reports, max(r.created_at) AS lastAt,
      json_group_array(json_object('reason', r.reason, 'at', r.created_at)) AS reasons
    FROM profile_reports r JOIN users u ON u.id = r.user_id GROUP BY u.id ORDER BY reports DESC, lastAt DESC LIMIT 200`).all<{ reasons: string }>();
  return json({ sets: sets.results.map((s) => ({ ...s, reasons: JSON.parse(s.reasons) as unknown[] })), people: people.results.map((p) => ({ ...p, reasons: JSON.parse(p.reasons) as unknown[] })) });
}

/** GET /api/admin/backups, POST /api/admin/backups (run now) */
export async function backups(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  if (req.method === 'POST') {
    const c = await needAdmin(req, env, ctx);
    const manifest = await runBackup(env);
    await audit(env, c.user.email, 'backup.run', manifest.date).run();
    return json({ manifest }, 201);
  }
  return json({ daily: await listBackups(env, 'daily'), weekly: await listBackups(env, 'weekly') });
}

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** GET /api/admin/overview: the numbers that say whether DMC is healthy. */
export async function overview(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  const now = Date.now();
  const [users, sets, bytes, usage, errors, reports] = await env.DB.batch<Record<string, number | string>>([
    env.DB.prepare(`SELECT count(*) AS total, sum(last_seen_at > ?1) AS active7, sum(last_seen_at > ?2) AS active30, sum(suspended_at IS NOT NULL) AS suspended, sum(${MEMBER_SQL('users')}) AS members FROM users`).bind(now - 7 * 86_400_000, now - 30 * 86_400_000),
    env.DB.prepare(`SELECT count(*) AS total, sum(status = 'hidden') AS hidden, COALESCE(sum(star_count), 0) AS stars FROM sets`),
    env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS library, count(*) AS files FROM blobs'),
    env.DB.prepare(`SELECT day, sum(downloads) AS downloads, sum(download_bytes) AS downloadBytes, sum(uploads) AS uploads, sum(upload_bytes) AS uploadBytes FROM usage_daily WHERE day >= ?1 GROUP BY day ORDER BY day`).bind(day(13)),
    env.DB.prepare('SELECT COALESCE(sum(n), 0) AS n FROM error_daily WHERE day >= ?1').bind(day(1)),
    env.DB.prepare(`SELECT (SELECT count(*) FROM sets WHERE report_count > 0 OR status = 'hidden') + (SELECT count(DISTINCT user_id) FROM profile_reports) AS open`),
  ]);
  const daily = await listBackups(env, 'daily');
  const series = Array.from({ length: 14 }, (_, i) => day(13 - i)).map((d) => {
    const r = usage!.results.find((x) => x.day === d) as Record<string, number> | undefined;
    return { day: d, downloads: r?.downloads ?? 0, downloadBytes: r?.downloadBytes ?? 0, uploads: r?.uploads ?? 0, uploadBytes: r?.uploadBytes ?? 0 };
  });
  return json({
    users: users!.results[0], sets: sets!.results[0], storage: { ...bytes!.results[0], limit: FREE_TIER_BYTES },
    usage: series, errors24h: (errors!.results[0] as { n: number }).n, openReports: (reports!.results[0] as { open: number }).open,
    lastBackup: daily.length ? daily[daily.length - 1] : null,
  });
}

/** GET /api/admin/users?q=&offset= */
export async function users(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  const u = new URL(req.url);
  const q = (u.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 100);
  const offset = Math.max(0, Math.min(100_000, Number(u.searchParams.get('offset')) || 0));
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await env.DB.prepare(`SELECT u.id, u.email, u.display_name AS name, u.handle, u.created_at AS createdAt, u.last_seen_at AS lastSeenAt,
      u.suspended_at AS suspendedAt, u.quota_bytes AS quotaBytes, u.visibility, ${MEMBER_SQL('u')} AS member,
      EXISTS (SELECT 1 FROM library_admins a WHERE a.email = u.email) AS admin,
      (SELECT COALESCE(SUM(size), 0) FROM blobs b WHERE b.first_uploader = u.id) AS bytes,
      (SELECT count(*) FROM sets s WHERE s.owner = u.id) AS sets,
      (SELECT count(*) FROM sessions x WHERE x.user_id = u.id AND x.expires_at > ?3) AS sessions
    FROM users u WHERE ?1 = '' OR lower(u.email) LIKE ?2 ESCAPE '\\' OR lower(u.display_name) LIKE ?2 ESCAPE '\\' OR u.handle LIKE ?2 ESCAPE '\\'
    ORDER BY u.last_seen_at DESC LIMIT 51 OFFSET ?4`).bind(q, like, Date.now(), offset).all();
  return json({ users: rows.results.slice(0, 50), more: rows.results.length > 50 });
}

/** POST /api/admin/users/<id> { action: suspend | restore | signout | quota | hide-profile, quotaBytes? } */
export async function userAction(req: Request, env: Env, ctx: ExecutionContext, id0: string): Promise<Response> {
  const c = await needAdmin(req, env, ctx);
  const id = uuid(id0, 'User ID');
  const b = obj(await readJson(req, 4096), ['action', 'quotaBytes']);
  const target = await env.DB.prepare('SELECT id, email, handle FROM users WHERE id = ?1').bind(id).first<{ id: string; email: string; handle: string | null }>();
  if (!target) throw new ApiError('No such account', 404);
  const db = env.DB;
  const signout = db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id);
  let stmts: D1PreparedStatement[];
  switch (b.action) {
    case 'suspend':
      if (id === c.user.id) throw new ApiError('You cannot suspend yourself', 409);
      // Suspension ends every session at once; the account cannot sign in until restored.
      stmts = [db.prepare('UPDATE users SET suspended_at = ?2 WHERE id = ?1').bind(id, Date.now()), signout];
      break;
    case 'restore': stmts = [db.prepare('UPDATE users SET suspended_at = NULL WHERE id = ?1').bind(id), db.prepare('DELETE FROM profile_reports WHERE user_id = ?1').bind(id)]; break;
    case 'signout': stmts = [signout]; break;
    case 'hide-profile': stmts = [db.prepare("UPDATE users SET visibility = 'private' WHERE id = ?1").bind(id)]; break;
    case 'quota': {
      const q = b.quotaBytes === null ? null : int(b.quotaBytes, 'quotaBytes', 0, 10 * 1024 * 1024 * 1024);
      stmts = [db.prepare('UPDATE users SET quota_bytes = ?2 WHERE id = ?1').bind(id, q)];
      break;
    }
    default: throw new ApiError('Unknown action');
  }
  await db.batch([...stmts, audit(env, c.user.email, `user.${String(b.action)}`, target.email, b.action === 'quota' ? { quotaBytes: b.quotaBytes } : {})]);
  if (!target.handle) await ensureHandle(env, target);
  return json({ ok: true });
}

/** GET /api/admin/audit: the latest 200 admin actions. */
export async function auditLog(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  const rows = await env.DB.prepare('SELECT id, at, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT 200').all<{ detail: string }>();
  return json({ entries: rows.results.map((r) => ({ ...r, detail: JSON.parse(r.detail) as unknown })) });
}

/** GET /api/admin/duplicates: the same paper (by text) stored as different files. */
export async function duplicates(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  const pairs = await env.DB.prepare(`SELECT DISTINCT a.qp_hash AS a, b.qp_hash AS b FROM paper_bands a JOIN paper_bands b ON a.band = b.band AND a.qp_hash < b.qp_hash LIMIT 2000`).all<{ a: string; b: string }>();
  if (!pairs.results.length) return json({ groups: [] });
  const hashes = [...new Set(pairs.results.flatMap((p) => [p.a, p.b]))];
  const prints = await env.DB.prepare(`SELECT p.qp_hash, p.fingerprint, p.label, p.title, p.first_set_id AS setId, s.title AS setTitle, b.size
      FROM paper_prints p LEFT JOIN sets s ON s.id = p.first_set_id LEFT JOIN blobs b ON b.hash = p.qp_hash WHERE p.qp_hash IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(hashes)).all<{ qp_hash: string; fingerprint: string | null }>();
  const by = new Map(prints.results.map((p) => [p.qp_hash, p] as const));
  const groups = pairs.results.flatMap(({ a, b }) => {
    const x = by.get(a); const y = by.get(b);
    const sim = x?.fingerprint && y?.fingerprint ? similarity(x.fingerprint, y.fingerprint) : 0;
    const strip = (p: typeof x) => { const { fingerprint: _f, ...rest } = p!; return rest; };
    return sim >= FP_SAME ? [{ similarity: Math.round(sim * 100) / 100, papers: [strip(x), strip(y)] }] : [];
  });
  return json({ groups: groups.slice(0, 200) });
}

/** GET /api/admin/gc: what the next file collection would delete (a dry run). */
export async function gcPreview(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  const cutoff = Date.now() - 7 * 86_400_000;
  const [due, waiting] = await env.DB.batch<{ n: number; bytes: number }>([
    env.DB.prepare('SELECT count(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE orphaned_at IS NOT NULL AND orphaned_at < ?1').bind(cutoff),
    env.DB.prepare('SELECT count(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE orphaned_at IS NOT NULL AND orphaned_at >= ?1').bind(cutoff),
  ]);
  return json({ due: due!.results[0], waiting: waiting!.results[0] });
}
