#!/usr/bin/env node
/**
 * Turns a DMC database backup (backups/<daily|weekly>/<date>/ in R2) into SQL that restores it.
 *
 *   node scripts/restore-backup.mjs <backup folder> [out.sql]
 *
 * The folder holds the files of one backup: manifest.json and <table>.jsonl.gz. Download them
 * with the commands in setup.md ("Restore a backup"), run this, then apply the SQL with
 * `npx wrangler d1 execute <db> --remote --file <out.sql>`. The SQL replaces every backed-up
 * table; sessions are not in backups, so everyone signs in again afterwards.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { BACKUP_TABLES, fromJsonl, restoreSql } from '../worker/backup-format.ts';

export function readBackup(dir) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`No manifest.json in ${dir}: the backup is incomplete. Use an earlier date.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 'dmc-backup/1') throw new Error('Not a DMC backup');
  const tables = {};
  for (const t of BACKUP_TABLES) {
    const file = join(dir, `${t}.jsonl.gz`);
    if (!manifest.tables[t]) continue;
    if (!existsSync(file)) throw new Error(`Missing ${t}.jsonl.gz`);
    const rows = fromJsonl(gunzipSync(readFileSync(file)).toString('utf8'));
    if (rows.length !== manifest.tables[t].rows) throw new Error(`${t}: expected ${manifest.tables[t].rows} rows, found ${rows.length}`);
    tables[t] = rows;
  }
  return { manifest, tables };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, out = 'restore.sql'] = process.argv.slice(2);
  if (!dir) {
    console.error('Usage: node scripts/restore-backup.mjs <backup folder> [out.sql]');
    process.exit(2);
  }
  try {
    const { manifest, tables } = readBackup(dir);
    writeFileSync(out, restoreSql(tables).join('\n') + '\n');
    const rows = Object.values(manifest.tables).reduce((a, t) => a + t.rows, 0);
    console.log(`Backup of ${manifest.date}: ${Object.keys(tables).length} tables, ${rows} rows -> ${out}`);
  } catch (e) {
    console.error(`Restore failed: ${e.message}`);
    process.exit(1);
  }
}
