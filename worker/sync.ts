import { need } from './auth';
import { ApiError, isObj, json, obj, readJson, type Obj } from './http';
import type { D1PreparedStatement, Env, ExecutionContext } from './types';

/**
 * Sync, ported from supabase/schema.sql (sync_push / sync_pull) with the same behaviour:
 * compare-and-set writes against the version the device last saw, idempotent retries, per
 * account limits, and a monotonic server revision cursor. A push is one D1 batch, so it is
 * all-or-nothing; a stale base makes a guarded statement fail and rolls the batch back.
 */
const STORES = ['packs', 'sessions', 'sessionDetail', 'questionStats', 'snips', 'overrides', 'settings'] as const;
type Store = (typeof STORES)[number];
const MAX_RECORDS = 500;
const MAX_PUSH_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 262_144;
const MAX_ROWS = 50_000;
const MAX_ACCOUNT_BYTES = 64 * 1024 * 1024;

interface Incoming { store: Store; id: string; updated_at: number; base_updated_at: number; deleted: boolean; data: Obj | null; text: string | null }
interface Row { store: Store; id: string; updated_at: number; deleted: number; data: string | null; bytes: number }

const between = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const count = (v: unknown) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : 0);

/** The same shape rules as the SQL function, record by record. */
function check(x: unknown): Incoming {
  const invalid = (m = 'Invalid sync record'): never => { throw new ApiError(m); };
  if (!isObj(x)) return invalid();
  for (const k of Object.keys(x)) if (!['store', 'id', 'updated_at', 'base_updated_at', 'deleted', 'data'].includes(k)) invalid();
  if (!STORES.includes(x.store as Store) || typeof x.id !== 'string' || x.id.length < 1 || x.id.length > 300) invalid();
  if (typeof x.updated_at !== 'number' || typeof x.base_updated_at !== 'number') invalid();
  const incoming = x.updated_at as number;
  const base = x.base_updated_at as number;
  if (!Number.isInteger(incoming) || incoming < 1 || incoming > Number.MAX_SAFE_INTEGER || !Number.isInteger(base) || base < 0) invalid('Invalid version');
  const gone = x.deleted === true;
  if (x.deleted !== undefined && typeof x.deleted !== 'boolean') invalid();
  const store = x.store as Store;
  const id = x.id as string;
  let data: Obj | null = null;
  let text: string | null = null;
  if (!gone) {
    if (!isObj(x.data)) invalid('Invalid sync payload');
    data = x.data as Obj;
    text = JSON.stringify(data);
    if (new TextEncoder().encode(text).byteLength > MAX_RECORD_BYTES) invalid('Invalid sync payload');
    if (store !== 'settings') {
      if (['packs', 'sessions', 'sessionDetail'].includes(store) && data.id !== id) invalid('Record id does not match payload');
      if (['questionStats', 'snips', 'overrides'].includes(store) && data.key !== id) invalid('Record key does not match payload');
      if (store !== 'packs' && !(typeof data.packId === 'string' && data.packId.length >= 1 && data.packId.length <= 300)) invalid('Missing pack id');
      if (store === 'sessions' && !['submitted', 'auto-submitted'].includes(String(data.status))) invalid('Only finished sessions sync');
    }
    if (store === 'sessionDetail') {
      const q = data.questionIds, a = data.answers;
      if (!Array.isArray(q) || !Array.isArray(a) || q.length < 1 || q.length > 200 || a.length !== q.length) invalid('Invalid bounded session details');
      if ('snapshots' in data && ((!Array.isArray(data.snapshots) && !isObj(data.snapshots)) || count(data.snapshots) > 200)) invalid('Too many question snapshots');
      if ('regrades' in data && (!Array.isArray(data.regrades) || data.regrades.length > 100)) invalid('Invalid regrade history');
    }
    if (store === 'sessions') {
      const total = data.total, answered = data.answered, correct = data.correct;
      if (!['paper', 'random', 'drill', 'daily'].includes(String(data.type)) || !['exam', 'practice'].includes(String(data.mode))
        || !between(total, 1, 200) || !between(answered, 0, total as number) || !between(correct, 0, answered as number)) invalid('Invalid session summary');
    }
    if (store === 'settings' && id !== 'settings') invalid('Invalid settings id');
  }
  if (store === 'settings' && id !== 'settings') invalid('Invalid settings id');
  return { store, id, updated_at: incoming, base_updated_at: base, deleted: gone, data, text };
}

/** The device names the account it is syncing; a different signed-in account stops the sync. */
async function syncCaller(req: Request, env: Env, ctx: ExecutionContext) {
  const c = await need(req, env, ctx);
  const expected = req.headers.get('x-dmc-account');
  if (expected && expected !== c.user.id) throw new ApiError('Account changed. Sync stopped.', 409);
  return c;
}

/** POST /api/sync/push { records } -> { accepted } */
export async function push(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const c = await syncCaller(req, env, ctx);
  const body = obj(await readJson(req, MAX_PUSH_BYTES), ['records']);
  if (!Array.isArray(body.records) || body.records.length > MAX_RECORDS) throw new ApiError(`Push must contain at most ${MAX_RECORDS} records and 4 MB`);
  const records = body.records.map(check);
  const keys = records.map((r) => `${r.store}|${r.id}`);
  if (new Set(keys).size !== keys.length) throw new ApiError('Duplicate records in one push');
  const uid = c.user.id;
  const db = env.DB;
  if (!records.length) return json({ accepted: 0 });

  const [existing, totals, deletedPacks] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT store, id, updated_at, deleted, data, bytes FROM sync_records WHERE user_id = ?1 AND (store || '|' || id) IN (SELECT value FROM json_each(?2))`).bind(uid, JSON.stringify(keys)),
    db.prepare('SELECT count(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM sync_records WHERE user_id = ?1').bind(uid),
    db.prepare(`SELECT id FROM sync_records WHERE user_id = ?1 AND store = 'packs' AND deleted = 1 AND id IN (SELECT value FROM json_each(?2))`)
      .bind(uid, JSON.stringify([...new Set(records.filter((r) => r.data && typeof r.data.packId === 'string').map((r) => r.data!.packId as string))])),
  ]);
  const old = new Map((existing!.results as unknown as Row[]).map((r) => [`${r.store}|${r.id}`, r] as const));
  const tot = totals!.results[0] as { n: number; b: number };
  const gonePacks = new Set((deletedPacks!.results as { id: string }[]).map((r) => r.id));
  const additions = records.filter((r) => !old.has(`${r.store}|${r.id}`)).length;
  if (tot.n + additions > MAX_ROWS) throw new ApiError('Sync creation limit reached; existing records can still be updated or deleted', 413);
  const size = (r: Incoming) => (r.text ? new TextEncoder().encode(r.text).byteLength : 0);
  const projected = tot.b + records.reduce((a, r) => a + size(r) - (old.get(`${r.store}|${r.id}`)?.bytes ?? 0), 0);
  if (projected > MAX_ACCOUNT_BYTES) throw new ApiError('Sync payload limit reached: 64 MB per account', 413);

  let accepted = 0;
  const writes: Incoming[] = [];
  for (const r of records) {
    if (!r.deleted && r.store !== 'packs' && r.store !== 'settings' && gonePacks.has(r.data!.packId as string))
      throw new ApiError('The parent pack was deleted; restore it explicitly before editing dependent records', 409);
    const o = old.get(`${r.store}|${r.id}`);
    // A response lost after commit can safely be retried, even with its previous base token.
    if (o && o.updated_at === r.updated_at && !!o.deleted === r.deleted && (o.data ?? null) === (r.deleted ? null : canonical(r.text))) { accepted++; continue; }
    if ((!o && r.base_updated_at !== 0) || (o && o.updated_at !== r.base_updated_at)) throw new ApiError('Sync conflict: pull the latest records before retrying', 409);
    if (o && r.updated_at === o.updated_at) throw new ApiError('Changed payload needs a new version', 409);
    writes.push(r);
    accepted++;
  }

  // Dependents of a deleted pack, and the partner of a deleted session, become tombstones too,
  // including ones this device has never pulled. Their history stays on the server.
  const cascades: { store: Store; id: string; updated_at: number; base: number }[] = [];
  const delPacks = writes.filter((r) => r.store === 'packs' && r.deleted);
  const delSessions = writes.filter((r) => (r.store === 'sessions' || r.store === 'sessionDetail') && r.deleted);
  if (delPacks.length || delSessions.length) {
    const deps = await db.prepare(
      `SELECT store, id, updated_at, json_extract(data, '$.packId') AS pack_id FROM sync_records WHERE user_id = ?1 AND deleted = 0 AND (
         (store <> 'packs' AND json_extract(data, '$.packId') IN (SELECT value FROM json_each(?2)))
         OR (store IN ('sessions', 'sessionDetail') AND id IN (SELECT value FROM json_each(?3))))`,
    ).bind(uid, JSON.stringify(delPacks.map((r) => r.id)), JSON.stringify(delSessions.map((r) => r.id))).all<{ store: Store; id: string; updated_at: number; pack_id: string | null }>();
    const writing = new Set(writes.map((r) => `${r.store}|${r.id}`));
    for (const d of deps.results) {
      if (writing.has(`${d.store}|${d.id}`)) continue;
      const parent = (d.store !== 'packs' ? delPacks.find((p) => p.id === d.pack_id) : undefined) ?? delSessions.find((s) => s.id === d.id);
      cascades.push({ store: d.store, id: d.id, updated_at: Math.max(d.updated_at + 1, parent?.updated_at ?? 0), base: d.updated_at });
    }
  }

  const stmts: D1PreparedStatement[] = [];
  const now = Date.now();
  const bump = db.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'sync'`);
  const upsert = (store: Store, id: string, updatedAt: number, base: number, deleted: boolean, text: string | null) => {
    stmts.push(bump);
    stmts.push(db.prepare(
      `INSERT INTO sync_records (user_id, store, id, updated_at, deleted, data, bytes, server_revision, synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT value FROM counters WHERE name = 'sync'), ?8)
       ON CONFLICT (user_id, store, id) DO UPDATE SET
         updated_at = CASE WHEN sync_records.updated_at = ?9 THEN excluded.updated_at END,
         deleted = excluded.deleted, data = excluded.data, bytes = excluded.bytes,
         server_revision = excluded.server_revision, synced_at = excluded.synced_at`,
    ).bind(uid, store, id, updatedAt, deleted ? 1 : 0, text, text ? new TextEncoder().encode(text).byteLength : 0, now, base));
  };
  for (const r of writes) upsert(r.store, r.id, r.updated_at, r.base_updated_at, r.deleted, r.deleted ? null : canonical(r.text));
  for (const d of cascades) upsert(d.store, d.id, d.updated_at, d.base, true, null);
  if (stmts.length) {
    try {
      await db.batch(stmts);
    } catch (e) {
      // A base that changed between the read and the batch nulls updated_at: NOT NULL fails, nothing is written.
      if (/NOT NULL constraint failed/i.test(String((e as Error).message))) throw new ApiError('Sync conflict: pull the latest records before retrying', 409);
      throw e;
    }
  }
  return json({ accepted });
}

/** Stored text is the record's JSON, so an identical retry compares equal. */
const canonical = (text: string | null) => text;

/** GET /api/sync/pull?after=<revision>&limit=<n> -> { records, cursor } */
export async function pull(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const c = await syncCaller(req, env, ctx);
  const q = new URL(req.url).searchParams;
  const after = q.get('after');
  if (after !== null && after !== '' && !/^\d{1,15}$/.test(after)) throw new ApiError('Invalid revision cursor');
  const limit = Number(q.get('limit') ?? 500);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiError('Invalid page size');
  const rows = await env.DB.prepare(
    `SELECT store, id, updated_at, deleted, data, server_revision FROM sync_records WHERE user_id = ?1 AND server_revision > ?2 ORDER BY server_revision LIMIT ?3`,
  ).bind(c.user.id, after ? Number(after) : 0, limit).all<{ store: Store; id: string; updated_at: number; deleted: number; data: string | null; server_revision: number }>();
  const records = rows.results.map((r) => ({ store: r.store, id: r.id, updated_at: r.updated_at, deleted: !!r.deleted, data: r.data === null ? null : JSON.parse(r.data), server_revision: String(r.server_revision) }));
  const last = rows.results[rows.results.length - 1];
  return json({ records, cursor: last ? String(last.server_revision) : (after || null) });
}
