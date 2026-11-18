#!/usr/bin/env node
/**
 * One-time copy of the pilot's Supabase project into Cloudflare D1 and R2.
 *
 *   node scripts/migrate-supabase.mjs --env staging [--dry-run] [--out migration-out] [--force]
 *
 * Needs, in the environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Supabase dashboard >
 * Project Settings > API; never commit it), and for the upload CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID. See setup.md, "Copy the pilot from Supabase".
 *
 * What it copies: library domains, allowlist and admins; accounts (same IDs, matched to Google
 * by email at first sign-in); every set as version 1 under its existing set ID (so packs students
 * already downloaded stay linked); stars; reports; synced progress; and every set file, stored
 * once by SHA-256 at blobs/<hash>. Run it once, into a freshly migrated, empty database.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8, strToU8 } from 'fflate';
import { isPaperKey, paperKeyFromName, qpKeyOf } from '../shared/paper-key.ts';
import { sqlValue } from '../worker/backup-format.ts';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', json: 'application/json' };
const typeOf = (path) => TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;
const ms = (iso) => (iso ? Date.parse(iso) : 0) || 0;
const CHUNK = 60_000;

/** "josef.yang@stjbs.sch.id" -> "Josef Yang" (the Worker's rule). */
export function nameFromEmail(email) {
  const local = email.split('@')[0] ?? '';
  const words = local.split(/[._-]+/).filter((w) => /[a-z]/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return (words.join(' ') || local || 'DMC user').slice(0, 80);
}

/** INSERT for one row; text longer than D1's statement limit is appended in pieces. */
function insert(table, row, key) {
  const cols = Object.keys(row);
  const long = cols.filter((c) => typeof row[c] === 'string' && row[c].length > CHUNK);
  const out = [`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => (long.includes(c) ? "''" : sqlValue(row[c]))).join(', ')});`];
  for (const c of long) {
    const where = key.map((k) => `${k} = ${sqlValue(row[k])}`).join(' AND ');
    for (let i = 0; i < row[c].length; i += CHUNK) out.push(`UPDATE ${table} SET ${c} = ${c} || ${sqlValue(row[c].slice(i, i + CHUNK))} WHERE ${where};`);
  }
  return out;
}

/** A paper's key, from what can be trusted: its PDF file names, then a canonical id. */
function keyOf(paper) {
  for (const name of [paper?.pdf?.questionPaper, paper?.source?.questionPaper, paper?.pdf?.markScheme, paper?.source?.markScheme]) {
    const k = name ? paperKeyFromName(String(name)) : null;
    if (k) return qpKeyOf(k);
  }
  return isPaperKey(paper?.id) ? qpKeyOf(paper.id) : null;
}

/**
 * The pure part: Supabase rows and set files in, SQL statements and blobs out.
 * `files(path)` returns the bytes of a storage object in the `sets` bucket, or null.
 */
export async function buildMigration(src, files, now = Date.now()) {
  const sql = ['PRAGMA defer_foreign_keys = ON;'];
  const blobs = new Map(); // hash -> { bytes, type, uploader }
  const problems = [];
  const addBlob = (bytes, type, uploader) => {
    const h = sha(bytes);
    if (!blobs.has(h)) blobs.set(h, { bytes, type, uploader });
    return h;
  };

  for (const d of src.domains ?? []) sql.push(`INSERT OR IGNORE INTO library_domains (domain) VALUES (${sqlValue(String(d.domain).toLowerCase())});`);
  for (const a of src.allowlist ?? []) sql.push(`INSERT OR IGNORE INTO library_allowlist (email, note, added_at, added_by) VALUES (${sqlValue(a.email.toLowerCase())}, ${sqlValue((a.note ?? '').slice(0, 200))}, ${ms(a.added_at)}, 'supabase');`);
  for (const a of src.admins ?? []) sql.push(`INSERT OR IGNORE INTO library_admins (email, added_at, added_by) VALUES (${sqlValue(a.email.toLowerCase())}, ${ms(a.added_at)}, 'supabase');`);

  const users = new Set();
  for (const u of src.users ?? []) {
    if (!u.email) continue;
    const email = u.email.toLowerCase();
    const meta = u.user_metadata ?? {};
    const name = String(meta.full_name ?? meta.name ?? '').trim().slice(0, 80) || nameFromEmail(email);
    // google_sub stays empty: the first Google sign-in with this email links the account.
    sql.push(...insert('users', { id: u.id, email, email_verified: u.email_confirmed_at ? 1 : 0, google_sub: null, hd: null, display_name: name, role: null, created_at: ms(u.created_at), last_seen_at: ms(u.last_sign_in_at ?? u.created_at) }, ['id']));
    users.add(u.id);
  }

  const papers = new Map();
  const setIds = new Set();
  for (const s of src.sets ?? []) {
    if (!users.has(s.owner)) { problems.push(`Set ${s.id} (${s.title}): owner account missing, skipped`); continue; }
    const zip = await files(s.file_path);
    if (!zip) { problems.push(`Set ${s.id} (${s.title}): pack.zip missing in storage, skipped`); continue; }
    let entries;
    try { entries = unzipSync(new Uint8Array(zip)); } catch { problems.push(`Set ${s.id} (${s.title}): pack.zip is not a valid zip, skipped`); continue; }
    const jsonName = Object.keys(entries).find((n) => /(^|\/)pack\.json$/i.test(n)) ?? Object.keys(entries).find((n) => n.toLowerCase().endsWith('.json'));
    if (!jsonName) { problems.push(`Set ${s.id} (${s.title}): no pack.json, skipped`); continue; }
    let doc;
    try { doc = JSON.parse(strFromU8(entries[jsonName])); } catch { problems.push(`Set ${s.id} (${s.title}): pack.json is not strict JSON, skipped`); continue; }
    const base = jsonName.includes('/') ? jsonName.slice(0, jsonName.lastIndexOf('/') + 1) : '';
    const fileMap = {};
    for (const [name, bytes] of Object.entries(entries)) {
      if (name === jsonName || name.endsWith('/')) continue;
      const rel = name.startsWith(base) ? name.slice(base.length) : name;
      const type = typeOf(rel);
      if (!/^(pdfs|images)\//.test(rel) || !type) continue;
      if (bytes.byteLength > 25 * 1024 * 1024) { problems.push(`Set ${s.id}: ${rel} is over 25 MB and was left out`); continue; }
      fileMap[rel] = addBlob(bytes, type, s.owner);
    }
    // The set keeps its permanent ID: copies already downloaded (lib-<id>) stay linked.
    doc.pack = { ...(doc.pack ?? {}), title: doc.pack?.title ?? s.title, setId: s.id, version: 1 };
    const mpapers = [];
    for (const p of Array.isArray(doc.papers) ? doc.papers : []) {
      const key = keyOf(p);
      if (key) p.key = key;
      const qs = Array.isArray(p.questions) ? p.questions : [];
      const answers = (doc.answers ?? []).find((a) => a.paper === p.id);
      const keyed = Math.min(Number(p.questionCount) || qs.length, qs.filter((q) => q.answer !== null && q.answer !== undefined).length || (typeof answers?.key === 'string' ? answers.key.replace(/[^A-E]/gi, '').length : 0));
      const qp = p.pdf?.questionPaper ? fileMap[p.pdf.questionPaper] : undefined;
      const msh = p.pdf?.markScheme ? fileMap[p.pdf.markScheme] : undefined;
      mpapers.push({ id: String(p.id).slice(0, 64), key, title: String(p.title ?? p.id).slice(0, 120), questionCount: Math.min(200, Math.max(1, Number(p.questionCount) || qs.length || 1)), keyed, ...(qp ? { qp } : {}), ...(msh ? { ms: msh } : {}), ...(p.bare ? { bare: true } : {}) });
      if (key && qp && !papers.has(key)) papers.set(key, { qp, ms: msh ?? null, questionCount: Number(p.questionCount) || null, setId: s.id });
    }
    if (!mpapers.length) { problems.push(`Set ${s.id} (${s.title}): no papers, skipped`); continue; }
    const packHash = addBlob(strToU8(JSON.stringify(doc)), 'application/json', s.owner);
    let cover;
    if (s.cover_path) {
      const c = await files(s.cover_path);
      const type = typeOf(s.cover_path);
      if (c && type?.startsWith('image/')) cover = addBlob(new Uint8Array(c), type, s.owner);
    }
    const manifest = { format: 'dmc-set/1', pack: packHash, ...(cover ? { cover } : {}), files: fileMap, papers: mpapers, meta: { title: s.title.slice(0, 120), description: (s.description ?? '').slice(0, 1000), subject: (s.subject ?? '').slice(0, 80), code: (s.code ?? '').slice(0, 20) } };
    const hashes = [...new Set([packHash, ...(cover ? [cover] : []), ...Object.values(fileMap)])];
    const bytes = hashes.reduce((a, h) => a + blobs.get(h).bytes.byteLength, 0);
    const created = ms(s.created_at) || now;
    sql.push(...insert('sets', {
      id: s.id, owner: s.owner, owner_name: s.owner_name.slice(0, 80), title: s.title.slice(0, 120), description: (s.description ?? '').slice(0, 1000), subject: (s.subject ?? '').slice(0, 80), code: (s.code ?? '').slice(0, 20),
      paper_count: mpapers.length, question_count: mpapers.reduce((a, p) => a + p.questionCount, 0), keyed: mpapers.every((p) => p.keyed >= p.questionCount) ? 1 : 0,
      latest_version: 1, bytes, cover_hash: cover ?? null, status: s.status === 'hidden' ? 'hidden' : 'approved', star_count: 0, report_count: 0, created_at: created, updated_at: created,
    }, ['id']));
    sql.push(...insert('set_versions', { set_id: s.id, version: 1, manifest: JSON.stringify(manifest), bytes, created_by: s.owner, created_at: created }, ['set_id', 'version']));
    for (const h of hashes) sql.push(`INSERT INTO blob_refs (set_id, version, hash) VALUES (${sqlValue(s.id)}, 1, ${sqlValue(h)});`);
    setIds.add(s.id);
  }
  // Blobs first in the file would be tidier, but foreign keys are deferred to the commit.
  for (const [h, b] of blobs) sql.splice(1, 0, `INSERT OR IGNORE INTO blobs (hash, size, type, first_uploader, created_at, orphaned_at) VALUES (${sqlValue(h)}, ${b.bytes.byteLength}, ${sqlValue(b.type)}, ${sqlValue(b.uploader)}, ${now}, NULL);`);
  for (const [key, p] of papers) sql.push(`INSERT OR IGNORE INTO papers (paper_key, qp_hash, ms_hash, question_count, first_set_id, created_at, updated_at) VALUES (${sqlValue(key)}, ${sqlValue(p.qp)}, ${sqlValue(p.ms)}, ${p.questionCount ?? 'NULL'}, ${sqlValue(p.setId)}, ${now}, ${now});`);

  const starCount = new Map();
  for (const st of src.stars ?? []) {
    if (!setIds.has(st.set_id) || !users.has(st.user_id)) continue;
    sql.push(`INSERT OR IGNORE INTO stars (set_id, user_id, created_at) VALUES (${sqlValue(st.set_id)}, ${sqlValue(st.user_id)}, ${ms(st.created_at)});`);
    starCount.set(st.set_id, (starCount.get(st.set_id) ?? 0) + 1);
  }
  const reportCount = new Map();
  for (const r of src.reports ?? []) {
    if (!setIds.has(r.set_id) || !users.has(r.reporter)) continue;
    sql.push(`INSERT OR IGNORE INTO reports (id, set_id, reporter, reason, created_at) VALUES (${sqlValue(r.id)}, ${sqlValue(r.set_id)}, ${sqlValue(r.reporter)}, ${sqlValue(String(r.reason).slice(0, 500))}, ${ms(r.created_at)});`);
    reportCount.set(r.set_id, (reportCount.get(r.set_id) ?? 0) + 1);
  }
  for (const [id, n] of starCount) sql.push(`UPDATE sets SET star_count = ${n} WHERE id = ${sqlValue(id)};`);
  for (const [id, n] of reportCount) sql.push(`UPDATE sets SET report_count = ${n} WHERE id = ${sqlValue(id)};`);

  // Synced progress, in the old server order, so every device pulls it as new.
  let revision = 0;
  const sync = [...(src.sync ?? [])].filter((r) => users.has(r.user_id)).sort((a, b) => Number(a.server_revision ?? 0) - Number(b.server_revision ?? 0));
  for (const r of sync) {
    const data = r.data === null || r.data === undefined ? null : typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    sql.push(...insert('sync_records', { user_id: r.user_id, store: r.store, id: r.id, updated_at: Number(r.updated_at), deleted: r.deleted ? 1 : 0, data, bytes: data ? Buffer.byteLength(data) : 0, server_revision: ++revision, synced_at: ms(r.synced_at) || now }, ['user_id', 'store', 'id']));
  }
  sql.push(`UPDATE counters SET value = MAX(value, ${revision}) WHERE name = 'sync';`);
  return { sql, blobs, problems, counts: { users: users.size, sets: setIds.size, blobs: blobs.size, stars: [...starCount.values()].reduce((a, b) => a + b, 0), reports: [...reportCount.values()].reduce((a, b) => a + b, 0), sync: sync.length } };
}

/** Count, total, largest and median per file type: the pilot's real sizes, for log.md. */
export function sizeSummary(blobs) {
  const by = new Map();
  for (const b of blobs.values()) by.set(b.type, [...(by.get(b.type) ?? []), b.bytes.byteLength]);
  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  return [...by.entries()].map(([type, sizes]) => {
    sizes.sort((a, b) => a - b);
    return `${type}: ${sizes.length} files, total ${mb(sizes.reduce((a, b) => a + b, 0))}, largest ${mb(sizes[sizes.length - 1])}, median ${mb(sizes[Math.floor(sizes.length / 2)])}`;
  });
}

// ---------------- the command ----------------
async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const env = opt('env');
  if (!['staging', 'production'].includes(env)) throw new Error('Pass --env staging or --env production');
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first');
  const out = opt('out', 'migration-out');
  const db = env === 'production' ? 'dmc-prod' : 'dmc-staging';
  const bucket = env === 'production' ? 'dmc-files' : 'dmc-files-staging';
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  const rest = async (table) => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const r = await fetch(`${url}/rest/v1/${table}?select=*`, { headers: { ...headers, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
      if (r.status === 404) return rows; // table absent in this project
      if (!r.ok) throw new Error(`Reading ${table} failed (${r.status})`);
      const page = await r.json();
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  };
  const users = [];
  for (let page = 1; ; page++) {
    const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers });
    if (!r.ok) throw new Error(`Reading accounts failed (${r.status})`);
    const body = await r.json();
    users.push(...(body.users ?? []));
    if ((body.users ?? []).length < 1000) break;
  }
  const files = async (path) => {
    const r = await fetch(`${url}/storage/v1/object/sets/${path.split('/').map(encodeURIComponent).join('/')}`, { headers });
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  };
  console.log('-> reading Supabase');
  const src = { domains: await rest('library_domains'), allowlist: await rest('library_allowlist'), admins: await rest('library_admins'), sets: await rest('sets'), stars: await rest('stars'), reports: await rest('reports'), sync: await rest('sync_records'), users };
  const m = await buildMigration(src, files);
  mkdirSync(join(out, 'blobs'), { recursive: true });
  for (const [h, b] of m.blobs) writeFileSync(join(out, 'blobs', h), b.bytes);
  writeFileSync(join(out, 'migrate.sql'), m.sql.join('\n') + '\n');
  console.log(`ok ${m.counts.users} accounts, ${m.counts.sets} sets, ${m.counts.blobs} files, ${m.counts.stars} stars, ${m.counts.reports} reports, ${m.counts.sync} synced records -> ${out}/`);
  for (const line of sizeSummary(m.blobs)) console.log(`   ${line}`);
  for (const p of m.problems) console.log(`!  ${p}`);
  if (flag('dry-run')) return console.log('ok dry run: nothing uploaded. Check the folder, then run again without --dry-run.');

  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const run = (a) => {
    const r = spawnSync(npx, ['wrangler', ...a], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error(`wrangler ${a.slice(0, 3).join(' ')} failed:\n${r.stderr || r.stdout}`);
    return r.stdout;
  };
  if (!flag('force')) {
    const res = run(['d1', 'execute', db, '--remote', ...(env === 'staging' ? ['--env', 'staging'] : []), '--json', '--command', 'SELECT count(*) AS n FROM sets']);
    if (Number(JSON.parse(res)[0]?.results?.[0]?.n ?? 0) > 0) throw new Error(`${db} already has sets. This copy runs once into an empty database (use --force only if you know why).`);
  }
  console.log(`-> uploading ${m.blobs.size} files to ${bucket}`);
  let i = 0;
  for (const [h, b] of m.blobs) {
    run(['r2', 'object', 'put', `${bucket}/blobs/${h}`, '--file', join(out, 'blobs', h), '--content-type', b.type, '--remote']);
    if (++i % 20 === 0) console.log(`   ${i} of ${m.blobs.size}`);
  }
  console.log(`-> writing ${db}`);
  run(['d1', 'execute', db, '--remote', ...(env === 'staging' ? ['--env', 'staging'] : []), '--file', join(out, 'migrate.sql'), '--yes']);
  console.log('ok migration finished. Check /api/health and open the Library.');
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')))) {
  main().catch((e) => { console.error(`x ${e.message}`); process.exit(1); });
}
