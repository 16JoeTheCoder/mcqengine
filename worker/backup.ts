import { BACKUP_TABLES, expired, isSunday, jakartaDate, primaryKey, toJsonl, type BackupManifest } from './backup-format';
import type { Env } from './types';

/**
 * Nightly D1 backup to R2 (cron 17:00 UTC = 00:00 Asia/Jakarta): every table as gzipped JSON
 * lines under backups/daily/<date>/. 7 daily copies are kept, and Sunday's copy is also kept as
 * a weekly one (4 kept). Files are not backed up: R2 already stores them durably.
 */
const PAGE: Record<string, number> = { sync_records: 100, set_versions: 50 };
export const DAILY_KEEP = 7;
export const WEEKLY_KEEP = 4;

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function runBackup(env: Env, now = Date.now()): Promise<BackupManifest> {
  const date = jakartaDate(now);
  const prefix = `backups/daily/${date}/`;
  const manifest: BackupManifest = { format: 'dmc-backup/1', date, createdAt: now, tables: {} };
  for (const t of BACKUP_TABLES) {
    const rows: Record<string, unknown>[] = [];
    const size = PAGE[t] ?? 1000;
    const order = primaryKey(t).join(', ');
    for (let offset = 0; ; offset += size) {
      const page = await env.DB.prepare(`SELECT * FROM ${t} ORDER BY ${order} LIMIT ?1 OFFSET ?2`).bind(size, offset).all();
      rows.push(...page.results);
      if (page.results.length < size) break;
    }
    const body = await gzip(toJsonl(rows));
    await env.FILES.put(`${prefix}${t}.jsonl.gz`, body, { httpMetadata: { contentType: 'application/gzip' } });
    manifest.tables[t] = { rows: rows.length, bytes: body.byteLength };
  }
  // The manifest goes last: a backup without one is incomplete and is never restored.
  await env.FILES.put(`${prefix}manifest.json`, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
  if (isSunday(date)) {
    for (const t of [...BACKUP_TABLES.map((x) => `${x}.jsonl.gz`), 'manifest.json']) {
      const o = await env.FILES.get(`${prefix}${t}`);
      if (o) await env.FILES.put(`backups/weekly/${date}/${t}`, await o.arrayBuffer());
    }
  }
  await prune(env, 'daily', DAILY_KEEP);
  await prune(env, 'weekly', WEEKLY_KEEP);
  return manifest;
}

export async function listBackups(env: Env, kind: 'daily' | 'weekly'): Promise<{ date: string; bytes: number; complete: boolean }[]> {
  const out = new Map<string, { bytes: number; complete: boolean }>();
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: `backups/${kind}/`, cursor, limit: 1000 });
    for (const o of page.objects) {
      const [, , date, file] = o.key.split('/');
      if (!date || !file) continue;
      const e = out.get(date) ?? { bytes: 0, complete: false };
      e.bytes += o.size;
      if (file === 'manifest.json') e.complete = true;
      out.set(date, e);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return [...out.entries()].map(([date, e]) => ({ date, ...e })).sort((a, b) => b.date.localeCompare(a.date));
}

async function prune(env: Env, kind: 'daily' | 'weekly', keep: number) {
  const dates = (await listBackups(env, kind)).map((b) => b.date);
  for (const date of expired(dates, keep)) {
    let cursor: string | undefined;
    do {
      const page = await env.FILES.list({ prefix: `backups/${kind}/${date}/`, cursor, limit: 1000 });
      if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

/**
 * Deletes files nothing points at, 7 days after they were orphaned (or uploaded and never
 * published), then drops registry entries whose files are gone and expired sessions.
 */
export async function collectGarbage(env: Env, now = Date.now()): Promise<{ deleted: number }> {
  const cutoff = now - 7 * 86_400_000;
  // Rows first (only if still unreferenced), then the objects: a publish racing with this either
  // keeps the row or fails on its missing file; it can never point at deleted bytes.
  const rows = await env.DB.prepare(
    `DELETE FROM blobs WHERE hash IN (SELECT hash FROM blobs WHERE orphaned_at IS NOT NULL AND orphaned_at < ?1 LIMIT 500)
       AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.hash = blobs.hash) RETURNING hash`,
  ).bind(cutoff).all<{ hash: string }>();
  const hashes = rows.results.map((r) => r.hash);
  if (hashes.length) await env.FILES.delete(hashes.map((h) => `blobs/${h}`));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM papers WHERE qp_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = papers.qp_hash)`),
    env.DB.prepare(`UPDATE papers SET ms_hash = NULL WHERE ms_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = papers.ms_hash)`),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?1 OR absolute_expires_at < ?1`).bind(now),
  ]);
  return { deleted: hashes.length };
}
