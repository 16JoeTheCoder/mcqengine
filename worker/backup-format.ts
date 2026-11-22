/**
 * Backup format, shared by the Worker's nightly dump and scripts/restore-backup.mjs (Node runs
 * this file directly, so it must stay plain, erasable TypeScript with no imports).
 *
 * One gzipped JSON-lines file per table at backups/daily/<date>/<table>.jsonl.gz, plus
 * manifest.json listing the tables and row counts. Session tokens are never backed up.
 */
export const BACKUP_TABLES = [
  'library_domains', 'library_allowlist', 'library_admins', 'users', 'blobs', 'sets', 'set_versions',
  'blob_refs', 'papers', 'stars', 'reports', 'sync_records', 'counters', 'usage_daily', 'user_backups',
  'paper_prints', 'paper_bands', 'profile_reports', 'audit_log', 'error_daily',
] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];
export interface BackupManifest { format: 'dmc-backup/1'; date: string; createdAt: number; tables: Record<string, { rows: number; bytes: number }> }

/** D1 refuses statements over 100 KB; long text values are appended in pieces below that. */
const CHUNK = 60_000;

export function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Non-finite number in backup');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`Unsupported value in backup: ${typeof v}`);
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Invalid column name "${s}"`);
  return s;
};

/** SQL that replaces every backed-up table with the backup's rows, in foreign-key order. */
export function restoreSql(tables: Partial<Record<BackupTable, Record<string, unknown>[]>>): string[] {
  const out: string[] = ['PRAGMA defer_foreign_keys = ON;'];
  for (const t of [...BACKUP_TABLES].reverse()) if (tables[t]) out.push(`DELETE FROM ${t};`);
  for (const t of BACKUP_TABLES) {
    const rows = tables[t];
    if (!rows) continue;
    for (const row of rows) {
      const cols = Object.keys(row).map(ident);
      const long = cols.filter((c) => typeof row[c] === 'string' && (row[c] as string).length > CHUNK);
      const values = cols.map((c) => (long.includes(c) ? "''" : sqlValue(row[c])));
      out.push(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${values.join(', ')});`);
      if (long.length) {
        const keyCols = primaryKey(t).map(ident);
        const where = keyCols.map((k) => `${k} = ${sqlValue(row[k])}`).join(' AND ');
        for (const c of long) {
          const text = row[c] as string;
          for (let i = 0; i < text.length; i += CHUNK) out.push(`UPDATE ${t} SET ${c} = ${c} || ${sqlValue(text.slice(i, i + CHUNK))} WHERE ${where};`);
        }
      }
    }
  }
  return out;
}

export function primaryKey(t: BackupTable): string[] {
  switch (t) {
    case 'library_domains': return ['domain'];
    case 'library_allowlist': case 'library_admins': return ['email'];
    case 'users': case 'sets': case 'reports': return ['id'];
    case 'blobs': return ['hash'];
    case 'set_versions': return ['set_id', 'version'];
    case 'blob_refs': return ['set_id', 'version', 'hash'];
    case 'papers': return ['paper_key'];
    case 'stars': return ['set_id', 'user_id'];
    case 'sync_records': return ['user_id', 'store', 'id'];
    case 'counters': return ['name'];
    case 'usage_daily': return ['day', 'user_id'];
    case 'user_backups': return ['user_id'];
    case 'paper_prints': return ['qp_hash'];
    case 'paper_bands': return ['band', 'qp_hash'];
    case 'profile_reports': return ['user_id', 'reporter'];
    case 'audit_log': return ['id'];
    case 'error_daily': return ['day'];
  }
}

export const toJsonl = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
export const fromJsonl = (text: string) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);

/** The Asia/Jakarta calendar date (UTC+7, no daylight saving) for a moment. */
export const jakartaDate = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
export const isSunday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

/** Which dated backups to delete, keeping the newest `keep`. */
export function expired(dates: string[], keep: number): string[] {
  return [...dates].sort().reverse().slice(keep);
}
