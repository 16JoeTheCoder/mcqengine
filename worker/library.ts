import { bandsOf, FP_SAME, isFingerprint, similarity } from '../shared/fingerprint';
import { isPaperKey, msKeyOf } from '../shared/paper-key';
import { MANIFEST_LIMITS, validateManifest, type SetManifest } from '../shared/manifest';
import { audit } from './admin';
import { needMember, type Caller } from './auth';
import { ApiError, int, json, obj, readJson, str, uuid } from './http';
import type { D1PreparedStatement, Env, ExecutionContext } from './types';

/**
 * The school Library: sets, versions, the paper registry, stars, reports and moderation. Every
 * rule that row-level security used to enforce is here, checked on the server for every request:
 *  * members read approved sets, their own sets, and (admins) every set;
 *  * only the owner posts versions or edits the name and description; only admins change status;
 *  * owners and admins delete; three distinct reports hide a set.
 */
const SETS_PER_PERSON = 40;
/** Versions kept per set: the current one and the one before (copies on it still update cleanly). */
const KEEP_VERSIONS = 2;

interface SetRow {
  id: string; owner: string; owner_name: string; title: string; description: string; subject: string; code: string;
  paper_count: number; question_count: number; keyed: number; latest_version: number; bytes: number; cover_hash: string | null;
  status: 'approved' | 'hidden'; star_count: number; report_count: number; created_at: number; updated_at: number;
}

const view = (r: SetRow, me: string, starred: boolean) => ({
  id: r.id, owner: r.owner, ownerName: r.owner_name, title: r.title, description: r.description, subject: r.subject, code: r.code,
  paperCount: r.paper_count, questionCount: r.question_count, keyed: !!r.keyed, version: r.latest_version, bytes: r.bytes,
  coverHash: r.cover_hash, status: r.status, stars: r.star_count, starred, reports: r.report_count,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), mine: r.owner === me,
});

/** The visibility rule, as one SQL condition over `s` with ?me and ?admin bound by the caller. */
const READABLE = `(s.status = 'approved' OR s.owner = ?1 OR ?2 = 1)`;
const bindMe = (c: Caller) => [c.user.id, c.access.admin ? 1 : 0] as const;

async function readable(env: Env, c: Caller, id: string): Promise<SetRow | null> {
  return env.DB.prepare(`SELECT * FROM sets s WHERE s.id = ?3 AND ${READABLE}`).bind(...bindMe(c), id).first<SetRow>();
}

/** GET /api/sets?search=&limit=&offset= */
export async function listSets(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const q = new URL(req.url).searchParams;
  const limit = Math.min(50, Math.max(1, Number(q.get('limit')) || 24));
  const offset = Math.min(10_000, Math.max(0, Number(q.get('offset')) || 0));
  const search = (q.get('search') ?? '').trim().toLowerCase().slice(0, 80).replace(/[%_\\]/g, (m) => `\\${m}`);
  const rows = await env.DB.prepare(
    `SELECT s.*, EXISTS (SELECT 1 FROM stars st WHERE st.set_id = s.id AND st.user_id = ?1) AS starred
       FROM sets s WHERE ${READABLE} AND s.latest_version > 0
        AND (?3 = '' OR lower(s.title || ' ' || s.description || ' ' || s.subject || ' ' || s.code) LIKE '%' || ?3 || '%' ESCAPE '\\')
      ORDER BY s.star_count DESC, s.created_at DESC LIMIT ?4 OFFSET ?5`,
  ).bind(...bindMe(c), search, limit, offset).all<SetRow & { starred: number }>();
  return json({ sets: rows.results.map((r) => view(r, c.user.id, !!r.starred)) });
}

/** GET /api/sets/<id>[/versions/<n>]: the set and a version's manifest (latest by default). */
export async function getSet(req: Request, env: Env, ctx: ExecutionContext, id: string, version?: number): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const row = await readable(env, c, uuid(id, 'Set ID'));
  if (!row || !row.latest_version) throw new ApiError('This set is no longer available', 404);
  const v = await env.DB.prepare('SELECT manifest, version FROM set_versions WHERE set_id = ?1 AND version = ?2').bind(row.id, version ?? row.latest_version).first<{ manifest: string; version: number }>();
  if (!v) throw new ApiError('That version is no longer kept; download the latest', 404);
  const starred = !!(await env.DB.prepare('SELECT 1 FROM stars WHERE set_id = ?1 AND user_id = ?2').bind(row.id, c.user.id).first());
  return json({ set: view(row, c.user.id, starred), manifest: { ...(JSON.parse(v.manifest) as SetManifest), setId: row.id, version: v.version } });
}

/** POST /api/papers/lookup { keys }: registry entries, so a second set links to existing files. */
export async function lookupPapers(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needMember(req, env, ctx);
  const body = obj(await readJson(req, 50_000), ['keys']);
  if (!Array.isArray(body.keys) || body.keys.length > MANIFEST_LIMITS.papers || !body.keys.every((k) => isPaperKey(k))) throw new ApiError(`Send at most ${MANIFEST_LIMITS.papers} paper keys`);
  const rows = await env.DB.prepare(
    `SELECT p.paper_key, p.qp_hash, p.ms_hash, p.question_count FROM papers p WHERE p.paper_key IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(body.keys)).all<{ paper_key: string; qp_hash: string | null; ms_hash: string | null; question_count: number | null }>();
  return json({ papers: rows.results.map((r) => ({ key: r.paper_key, msKey: msKeyOf(r.paper_key), qp: r.qp_hash, ms: r.ms_hash, questionCount: r.question_count })) });
}

/**
 * POST /api/papers/match { papers: [{ qp?, fp?, key? }] }
 * Finds each paper already in the Library, without anyone typing a code: by the question paper's
 * bytes (SHA-256), then by text fingerprint (the same paper saved again), then by the Cambridge
 * code read from the file name or cover. Returns the stored files to link instead of uploading.
 */
export async function matchPapers(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needMember(req, env, ctx);
  const body = obj(await readJson(req, 300_000), ['papers']);
  if (!Array.isArray(body.papers) || body.papers.length > MANIFEST_LIMITS.papers) throw new ApiError(`Send at most ${MANIFEST_LIMITS.papers} papers`);
  const HASH = /^[0-9a-f]{64}$/;
  const asks = body.papers.map((x, i) => {
    const o = obj(x, ['qp', 'fp', 'key']);
    if (o.qp !== undefined && !(typeof o.qp === 'string' && HASH.test(o.qp))) throw new ApiError(`Paper ${i + 1}: qp must be a file hash`);
    if (o.fp !== undefined && !isFingerprint(o.fp)) throw new ApiError(`Paper ${i + 1}: fp must be a text fingerprint`);
    if (o.key !== undefined && !isPaperKey(o.key)) throw new ApiError(`Paper ${i + 1}: key must be a Cambridge code`);
    return o as { qp?: string; fp?: string; key?: string };
  });
  type Print = { qp_hash: string; ms_hash: string | null; fingerprint: string | null; label: string | null; question_count: number | null };
  const cols = 'p.qp_hash, p.ms_hash, p.fingerprint, p.label, p.question_count';
  const hashes = asks.map((a) => a.qp).filter(Boolean);
  const bands = [...new Set(asks.flatMap((a) => (a.fp ? bandsOf(a.fp) : [])))];
  const keys = [...new Set(asks.map((a) => a.key).filter(Boolean))];
  const [byHash, byBand, byKey] = await env.DB.batch<Print & { band?: string }>([
    env.DB.prepare(`SELECT ${cols} FROM paper_prints p WHERE p.qp_hash IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(hashes)),
    env.DB.prepare(`SELECT DISTINCT ${cols} FROM paper_bands b JOIN paper_prints p ON p.qp_hash = b.qp_hash WHERE b.band IN (SELECT value FROM json_each(?1)) LIMIT 2000`).bind(JSON.stringify(bands)),
    env.DB.prepare(`SELECT ${cols} FROM paper_prints p WHERE p.label IN (SELECT value FROM json_each(?1)) ORDER BY p.created_at`).bind(JSON.stringify(keys)),
  ]);
  const out = asks.map((a) => {
    const exact = a.qp ? byHash!.results.find((r) => r.qp_hash === a.qp) : undefined;
    let hit: Print | undefined = exact;
    let how: 'file' | 'text' | 'code' = 'file';
    let score = exact ? 1 : 0;
    if (!hit && a.fp) {
      for (const r of byBand!.results) {
        const sim = r.fingerprint ? similarity(a.fp, r.fingerprint) : 0;
        if (sim >= FP_SAME && sim > score) { hit = r; score = sim; how = 'text'; }
      }
    }
    // A code alone links only when the stored paper has no fingerprint to disagree with.
    if (!hit && a.key) {
      const r = byKey!.results.find((x) => x.label === a.key && (!a.fp || !x.fingerprint));
      if (r) { hit = r; how = 'code'; }
    }
    return hit ? { qp: hit.qp_hash, ms: hit.ms_hash, questionCount: hit.question_count, label: hit.label, how, similarity: Math.round(score * 100) / 100 } : null;
  });
  return json({ matches: out });
}

/**
 * POST /api/sets/<id>/versions { base, manifest }
 * Creates the set on its first version (the client's permanent set ID becomes the Library ID) or
 * adds a version. `base` is the version the poster built on: if someone else's post landed first
 * the request is refused, so a version is never silently overwritten. Every file must already be
 * stored; the whole publish is one D1 batch.
 */
export async function publishVersion(req: Request, env: Env, ctx: ExecutionContext, id0: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  if (env.WRITE_LIMITER && !(await env.WRITE_LIMITER.limit({ key: c.user.id })).success) throw new ApiError('Too many posts in a minute. Wait a moment.', 429, 30);
  const id = uuid(id0, 'Set ID');
  const body = obj(await readJson(req, 1_000_000), ['base', 'manifest']);
  const base = int(body.base, 'base', 0, 1_000_000);
  let checked: ReturnType<typeof validateManifest>;
  try { checked = validateManifest(body.manifest); } catch (e) { throw new ApiError((e as Error).message); }
  const { manifest, hashes } = checked;
  for (const p of manifest.papers) {
    for (const h of [p.qp, p.ms]) if (h && !Object.values(manifest.files).includes(h)) throw new ApiError(`Paper "${p.id}" points at a file the set does not list`);
  }
  const known = await env.DB.prepare('SELECT hash, size, type FROM blobs WHERE hash IN (SELECT value FROM json_each(?1))').bind(JSON.stringify([...hashes])).all<{ hash: string; size: number; type: string }>();
  const byHash = new Map(known.results.map((r) => [r.hash, r] as const));
  const missing = [...hashes].filter((h) => !byHash.has(h));
  if (missing.length) throw new ApiError(`${missing.length} file${missing.length === 1 ? ' is' : 's are'} not uploaded yet. Resume the post.`, 409);
  if (byHash.get(manifest.pack)?.type !== 'application/json') throw new ApiError('The pack file must be JSON');
  if (manifest.cover && !byHash.get(manifest.cover)?.type.startsWith('image/')) throw new ApiError('The cover must be an image');
  const bytes = [...hashes].reduce((a, h) => a + byHash.get(h)!.size, 0);
  if (bytes > MANIFEST_LIMITS.versionBytes) throw new ApiError('A set version is limited to 200 MB', 413);

  const existing = await env.DB.prepare('SELECT * FROM sets WHERE id = ?1').bind(id).first<SetRow>();
  if (existing && existing.owner !== c.user.id) throw new ApiError('This set belongs to someone else. Post your own copy as a new set.', 403);
  if ((existing?.latest_version ?? 0) !== base) throw new ApiError(existing ? `Version ${existing.latest_version} was posted since you last downloaded. Update first, then post again.` : 'This set does not exist yet; post it as version 1', 409);
  if (!existing) {
    const n = (await env.DB.prepare('SELECT count(*) AS n FROM sets WHERE owner = ?1').bind(c.user.id).first<{ n: number }>())?.n ?? 0;
    if (n >= SETS_PER_PERSON) throw new ApiError(`Library limit reached: ${SETS_PER_PERSON} sets per person. Delete an old set first.`, 403);
  }
  const now = Date.now();
  const version = base + 1;
  const meta = manifest.meta;
  const questions = manifest.papers.reduce((a, p) => a + p.questionCount, 0);
  const keyed = manifest.papers.every((p) => p.keyed >= p.questionCount) ? 1 : 0;
  const code = meta.code || (manifest.papers.find((p) => p.key)?.key?.slice(0, 4) ?? '');
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [];
  // Guard: the version we build on is still the latest (a concurrent post fails the whole batch).
  stmts.push(db.prepare(`INSERT INTO cas_guard (ok) SELECT CASE WHEN COALESCE((SELECT latest_version FROM sets WHERE id = ?1), 0) = ?2 THEN 1 ELSE 0 END`).bind(id, base));
  stmts.push(db.prepare('DELETE FROM cas_guard'));
  if (!existing)
    stmts.push(db.prepare(`INSERT INTO sets (id, owner, owner_name, title, description, subject, code, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`)
      .bind(id, c.user.id, c.user.display_name.slice(0, 80), meta.title.trim(), meta.description.trim(), meta.subject.trim(), code.slice(0, 20), now));
  stmts.push(db.prepare('INSERT INTO set_versions (set_id, version, manifest, bytes, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, version, JSON.stringify(manifest), bytes, c.user.id, now));
  stmts.push(db.prepare(`INSERT INTO blob_refs (set_id, version, hash) SELECT ?1, ?2, value FROM json_each(?3)`).bind(id, version, JSON.stringify([...hashes])));
  stmts.push(db.prepare(`UPDATE blobs SET orphaned_at = NULL WHERE hash IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify([...hashes])));
  stmts.push(db.prepare(`UPDATE sets SET title = ?2, description = ?3, subject = ?4, code = ?5, paper_count = ?6, question_count = ?7, keyed = ?8,
      latest_version = ?9, bytes = ?10, cover_hash = ?11, updated_at = ?12 WHERE id = ?1`)
    .bind(id, meta.title.trim(), meta.description.trim(), meta.subject.trim(), code.slice(0, 20), manifest.papers.length, questions, keyed, version, bytes, manifest.cover ?? null, now));
  // The paper registry: the first set to bring a paper's files is where later sets link to.
  for (const p of manifest.papers) {
    if (!p.qp) continue;
    // Paper identity: the question paper's bytes, its text fingerprint and bands for lookup.
    stmts.push(db.prepare(`INSERT INTO paper_prints (qp_hash, ms_hash, fingerprint, label, title, question_count, first_set_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      ON CONFLICT (qp_hash) DO UPDATE SET ms_hash = COALESCE(paper_prints.ms_hash, excluded.ms_hash), fingerprint = COALESCE(paper_prints.fingerprint, excluded.fingerprint), label = COALESCE(paper_prints.label, excluded.label), updated_at = excluded.updated_at`)
      .bind(p.qp, p.ms ?? null, p.fp ?? null, p.key, p.title.slice(0, 120), p.questionCount, id, now));
    if (p.fp) stmts.push(db.prepare(`INSERT OR IGNORE INTO paper_bands (band, qp_hash) SELECT value, ?1 FROM json_each(?2)`).bind(p.qp, JSON.stringify(bandsOf(p.fp))));
    if (!p.key) continue;
    stmts.push(db.prepare(`INSERT INTO papers (paper_key, qp_hash, ms_hash, question_count, first_set_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
      ON CONFLICT (paper_key) DO UPDATE SET ms_hash = COALESCE(papers.ms_hash, excluded.ms_hash), qp_hash = COALESCE(papers.qp_hash, excluded.qp_hash), updated_at = excluded.updated_at`)
      .bind(p.key, p.qp, p.ms ?? null, p.questionCount, id, now));
  }
  stmts.push(...pruneVersions(env, id, version - KEEP_VERSIONS, now));
  try {
    await db.batch(stmts);
  } catch (e) {
    if (/CHECK constraint failed/i.test(String((e as Error).message))) throw new ApiError('Someone posted a newer version at the same moment. Update first, then post again.', 409);
    throw e;
  }
  return json({ setId: id, version, bytes }, 201);
}

/** Statements that drop versions at or below `upTo` and mark files nothing points at any more. */
function pruneVersions(env: Env, setId: string, upTo: number, now: number): D1PreparedStatement[] {
  if (upTo < 1) return [];
  return [
    env.DB.prepare(`DELETE FROM set_versions WHERE set_id = ?1 AND version <= ?2`).bind(setId, upTo),
    env.DB.prepare(`UPDATE blobs SET orphaned_at = ?1 WHERE orphaned_at IS NULL AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.hash = blobs.hash)`).bind(now),
  ];
}

/** PATCH /api/sets/<id> { title?, description?, status? } */
export async function updateSet(req: Request, env: Env, ctx: ExecutionContext, id0: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const id = uuid(id0, 'Set ID');
  const body = obj(await readJson(req, 8192), ['title', 'description', 'subject', 'status']);
  const row = await env.DB.prepare('SELECT * FROM sets WHERE id = ?1').bind(id).first<SetRow>();
  if (!row || !(row.owner === c.user.id || c.access.admin)) throw new ApiError('Not allowed', 403);
  if (body.status !== undefined) {
    if (!c.access.admin) throw new ApiError("Only an admin can change a set's status", 403);
    if (!['approved', 'hidden'].includes(String(body.status))) throw new ApiError('Status must be approved or hidden');
  }
  const title = body.title === undefined ? row.title : str(body.title, 'Name', 120, 1).trim();
  const description = body.description === undefined ? row.description : str(body.description, 'Description', 1000).trim();
  const subject = body.subject === undefined ? row.subject : str(body.subject, 'Subject', 80).trim();
  const status = (body.status as string | undefined) ?? row.status;
  // Restoring a set clears its report count, so three new reports are needed to hide it again.
  const upd = env.DB.prepare('UPDATE sets SET title = ?2, description = ?3, subject = ?6, status = ?4, report_count = CASE WHEN ?4 = \'approved\' AND status = \'hidden\' THEN 0 ELSE report_count END, updated_at = ?5 WHERE id = ?1')
    .bind(id, title, description, status, Date.now(), subject);
  await env.DB.batch(row.owner === c.user.id && body.status === undefined ? [upd] : [upd, audit(env, c.user.email, body.status !== undefined ? `set.${status}` : 'set.edit', id, { title })]);
  if (status === 'approved' && row.status === 'hidden') await env.DB.prepare('DELETE FROM reports WHERE set_id = ?1').bind(id).run();
  return json({ ok: true });
}

/** DELETE /api/sets/<id>: owner or admin. Files nothing else points at are collected after 7 days. */
export async function deleteSet(req: Request, env: Env, ctx: ExecutionContext, id0: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const id = uuid(id0, 'Set ID');
  const row = await env.DB.prepare('SELECT owner FROM sets WHERE id = ?1').bind(id).first<{ owner: string }>();
  if (!row) throw new ApiError('No such set', 404);
  if (row.owner !== c.user.id && !c.access.admin) throw new ApiError('Not allowed', 403);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sets WHERE id = ?1').bind(id),
    env.DB.prepare(`UPDATE blobs SET orphaned_at = ?1 WHERE orphaned_at IS NULL AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.hash = blobs.hash)`).bind(now),
    ...(row.owner !== c.user.id ? [audit(env, c.user.email, 'set.delete', id)] : []),
  ]);
  return json({ ok: true });
}

/** PUT /api/sets/<id>/star { on } */
export async function star(req: Request, env: Env, ctx: ExecutionContext, id0: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const id = uuid(id0, 'Set ID');
  const body = obj(await readJson(req, 1024), ['on']);
  if (typeof body.on !== 'boolean') throw new ApiError('on must be true or false');
  if (!(await readable(env, c, id))) throw new ApiError('No such set', 404);
  const db = env.DB;
  if (body.on)
    await db.batch([
      db.prepare('UPDATE sets SET star_count = star_count + 1 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM stars WHERE set_id = ?1 AND user_id = ?2)').bind(id, c.user.id),
      db.prepare('INSERT OR IGNORE INTO stars (set_id, user_id, created_at) VALUES (?1, ?2, ?3)').bind(id, c.user.id, Date.now()),
    ]);
  else
    await db.batch([
      db.prepare('UPDATE sets SET star_count = MAX(0, star_count - 1) WHERE id = ?1 AND EXISTS (SELECT 1 FROM stars WHERE set_id = ?1 AND user_id = ?2)').bind(id, c.user.id),
      db.prepare('DELETE FROM stars WHERE set_id = ?1 AND user_id = ?2').bind(id, c.user.id),
    ]);
  return json({ ok: true });
}

/** POST /api/sets/<id>/report { reason }: once per person per set; three hide the set. */
export async function report(req: Request, env: Env, ctx: ExecutionContext, id0: string): Promise<Response> {
  const c = await needMember(req, env, ctx);
  const id = uuid(id0, 'Set ID');
  const body = obj(await readJson(req, 4096), ['reason']);
  const reason = str(body.reason, 'Reason', 500, 1).trim();
  if (!(await readable(env, c, id))) throw new ApiError('No such set', 404);
  if (await env.DB.prepare('SELECT 1 FROM reports WHERE set_id = ?1 AND reporter = ?2').bind(id, c.user.id).first()) throw new ApiError('You already reported this set', 409);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO reports (id, set_id, reporter, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(crypto.randomUUID(), id, c.user.id, reason, Date.now()),
    env.DB.prepare(`UPDATE sets SET report_count = report_count + 1, status = CASE WHEN report_count + 1 >= 3 THEN 'hidden' ELSE status END WHERE id = ?1`).bind(id),
  ]);
  return json({ ok: true }, 201);
}
