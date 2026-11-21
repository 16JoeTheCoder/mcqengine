import { needAdmin } from './auth';
import { listBackups, runBackup } from './backup';
import { ApiError, email, json, obj, readJson, str } from './http';
import type { Env, ExecutionContext } from './types';

/** Admin panel: storage, downloads, access management, moderation and backups. Admins only. */
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
    if (list === 'domains') await env.DB.prepare('INSERT OR IGNORE INTO library_domains (domain) VALUES (?1)').bind(value).run();
    else if (list === 'allowlist') await env.DB.prepare('INSERT INTO library_allowlist (email, note, added_at, added_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (email) DO UPDATE SET note = excluded.note').bind(value, body.note === undefined ? '' : str(body.note, 'Note', 200), Date.now(), c.user.email).run();
    else await env.DB.prepare('INSERT OR IGNORE INTO library_admins (email, added_at, added_by) VALUES (?1, ?2, ?3)').bind(value, Date.now(), c.user.email).run();
    return json({ ok: true }, 201);
  }
  if (req.method === 'DELETE') {
    if (list === 'admins' && value === c.user.email) throw new ApiError('You cannot remove yourself. Ask another admin.', 409);
    if (list === 'admins' && ((await env.DB.prepare('SELECT count(*) AS n FROM library_admins').first<{ n: number }>())?.n ?? 0) <= 1) throw new ApiError('Keep at least one admin', 409);
    await env.DB.prepare(`DELETE FROM ${table} WHERE ${key} = ?1`).bind(value).run();
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
  return json({ sets: sets.results.map((s) => ({ ...s, reasons: JSON.parse(s.reasons) as unknown[] })) });
}

/** GET /api/admin/backups, POST /api/admin/backups (run now) */
export async function backups(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  if (req.method === 'POST') return json({ manifest: await runBackup(env) }, 201);
  return json({ daily: await listBackups(env, 'daily'), weekly: await listBackups(env, 'weekly') });
}
