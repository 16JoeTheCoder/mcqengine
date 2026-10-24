import { FORMAT_ID } from '../format/validate';
import { DEFAULT_SETTINGS, LETTERS, type Figure, type Pack, type Paper, type QuestionOverride, type Settings, type TimerConfig, type TimerState } from '../types';
import { sanitizeTimer } from '../engine/timer';
import { applyOverride, mergePaperCopies, metaOf } from '../format/merge';
import * as store from './db';
import { sha256Hex } from './files';

export const BACKUP_FORMAT = 'dmc-backup/1';
export type Tier = 'progress' | 'packs' | 'everything';

const TIER_STORES: Record<Tier, store.StoreName[]> = {
  progress: ['sessions', 'sessionDetail', 'questionStats', 'bankEvents', 'overrides', 'meta'],
  packs: ['packs', 'papers'],
  everything: ['packs', 'papers', 'sessions', 'sessionDetail', 'questionStats', 'bankEvents', 'overrides', 'meta'],
};

export interface BackupManifest {
  format: string;
  tier: Tier;
  createdAt: number;
  app: string;
  checksum: string;
  counts: Record<string, number>;
  images: Record<string, string>; // id -> mime type
}

type Dump = Partial<Record<store.StoreName, unknown[]>>;

async function dumpStores(names: store.StoreName[]): Promise<Dump> {
  const d = await store.db();
  const out: Dump = {};
  for (const n of names) {
    if (n === 'meta') {
      const s = await d.get('meta', 'settings');
      out.meta = s ? [{ key: 'settings', value: s }] : [];
    } else out[n] = await d.getAll(n as never);
  }
  return out;
}

/** Builds a backup. Progress tier is a JSON file; the others are zips with images. */
export async function createBackup(tier: Tier, now = Date.now()): Promise<{ blob: Blob; name: string }> {
  const dump = await dumpStores(TIER_STORES[tier]);
  const data = JSON.stringify(dump);
  const counts = Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v?.length ?? 0]));
  const images: Record<string, string> = {};
  const files: Record<string, Uint8Array> = {};
  if (tier !== 'progress') {
    const d = await store.db();
    for (const img of await d.getAll('images')) {
      images[img.id] = img.type;
      files[`images/${img.id}`] = new Uint8Array(await img.blob.arrayBuffer());
    }
  }
  const manifest: BackupManifest = { format: BACKUP_FORMAT, tier, createdAt: now, app: __APP_VERSION__, checksum: await sha256Hex(data), counts, images };
  const date = new Date(now).toISOString().slice(0, 10);
  if (tier === 'progress') {
    return { blob: new Blob([JSON.stringify({ manifest, data })], { type: 'application/json' }), name: `dmc-progress-${date}.json` };
  }
  const { zipSync, strToU8 } = await import('fflate');
  const zip = zipSync({ 'dmc-backup.json': strToU8(JSON.stringify(manifest)), 'data.json': strToU8(data), ...files }, { level: 6 });
  return { blob: new Blob([zip as BlobPart], { type: 'application/zip' }), name: `dmc-${tier}-${date}.zip` };
}

export interface RestorePlan {
  manifest: BackupManifest;
  dump: Dump;
  images: Map<string, Blob>;
  adds: Record<string, number>;
  merges: Record<string, number>;
  skips: Record<string, number>;
}

export class BackupError extends Error {}

const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 300;
const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const timerOk = (t: unknown): boolean => {
  if (t === undefined) return true;
  const c = (t as { config?: unknown }).config ?? t;
  const x = c as Record<string, unknown>;
  const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const rem = (t as { remainingMs?: unknown }).remainingMs;
  return !!c && typeof c === 'object' && ['none', 'total', 'perq'].includes(x.kind as string) && fin(x.capMs) && fin(x.totalMs) && (x.perQMs === undefined || fin(x.perQMs)) && (rem === undefined || (typeof rem === 'number' && Number.isFinite(rem) && rem >= 0));
};
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** Shape checks for restored rows: a recomputed checksum proves integrity, not validity. */
function validRow(name: store.StoreName, r: Record<string, unknown>): boolean {
  if (!r || typeof r !== 'object') return false;
  switch (name) {
    case 'packs':
      return (
        str(r.id) && typeof r.title === 'string' && Array.isArray(r.papers) && num(r.updatedAt) &&
        (r.papers as Record<string, unknown>[]).every(
          (m) => !!m && typeof m === 'object' && str(m.id) && typeof m.title === 'string' && Array.isArray(m.group) && int(m.questionCount, 1, 200) && int(m.timeLimitMin, 1, 600) && int(m.optionCount, 2, 5) && int(m.present, 0, 200) && int(m.keyed, 0, 200),
        )
      );
    case 'papers':
      return (
        str(r.key) && str(r.packId) && str(r.id) && r.key === `${r.packId}::${r.id}` && Array.isArray(r.questions) && num(r.timeLimitMin) && (r.timeLimitMin as number) >= 1 && (r.timeLimitMin as number) <= 600 &&
        (r.questions as Record<string, unknown>[]).every(
          (q) =>
            !!q && typeof q === 'object' && int(q.n, 1, 200) && q.id === `${r.id}#${q.n}` && int(q.optionCount, 2, 5) &&
            (q.answer === null || int(q.answer, 0, (q.optionCount as number) - 1)) &&
            (q.stem === undefined || typeof q.stem === 'string') && (q.image === undefined || typeof q.image === 'string') &&
            (q.options === undefined || (Array.isArray(q.options) && (q.options as unknown[]).every((o) => !!o && typeof o === 'object'))) &&
            (q.table === undefined || (!!q.table && Array.isArray((q.table as { rows?: unknown }).rows) && ((q.table as { rows: unknown[] }).rows).every(Array.isArray))),
        )
      );
    case 'sessions':
      return str(r.id) && str(r.packId) && ['paper', 'random', 'drill'].includes(r.type as string) && ['exam', 'practice'].includes(r.mode as string) && ['active', 'saved', 'submitted', 'auto-submitted'].includes(r.status as string) && num(r.total) && num(r.answered) && num(r.correct) && (r.correct as number) <= (r.answered as number) && (r.answered as number) <= (r.total as number) && timerOk(r.timer);
    case 'sessionDetail':
      return str(r.id) && str(r.packId) && Array.isArray(r.questionIds) && (r.questionIds as unknown[]).every(str) && Array.isArray(r.answers) && (r.answers as unknown[]).length === (r.questionIds as unknown[]).length && (r.answers as Record<string, unknown>[]).every((a) => !!a && typeof a === 'object' && str(a.qid) && (a.choice === null || num(a.choice)) && num(a.timeMs)) && timerOk(r.timer);
    case 'questionStats':
      return str(r.key) && str(r.packId) && str(r.qid) && r.key === `${r.packId}::${r.qid}` && num(r.timesSeen) && num(r.attempts) && typeof r.inBank === 'boolean';
    case 'bankEvents':
      return str(r.packId) && str(r.qid) && num(r.at) && (r.kind === 'in' || r.kind === 'out');
    case 'overrides':
      return str(r.key) && str(r.packId) && str(r.qid) && r.key === `${r.packId}::${r.qid}` && num(r.updatedAt);
    case 'meta':
      return r.key === 'settings' && typeof r.value === 'object' && r.value !== null;
    default:
      return false;
  }
}

/** Keeps only known settings whose type matches the default; anything else falls back to the default. */
function cleanSettings(v: Record<string, unknown>): Settings {
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    const x = v?.[k];
    if (x === undefined) continue;
    if (Array.isArray(def) ? Array.isArray(x) && x.every((y) => typeof y === 'string') : typeof x === typeof def && (typeof x !== 'number' || Number.isFinite(x))) out[k] = x;
  }
  if (typeof v?.examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.examDate)) out.examDate = v.examDate;
  if (typeof v?.lastBackupAt === 'number') out.lastBackupAt = v.lastBackupAt;
  if (!['system', 'light', 'dark'].includes(out.theme as string)) out.theme = 'system';
  out.backupEvery = Math.min(100, Math.max(1, Math.round(Number(out.backupEvery)) || 10));
  out.lastBackupAtCount = Math.min(1e6, Math.max(0, Math.round(Number(out.lastBackupAtCount)) || 0));
  if (typeof out.lastBackupAt === 'number' && !Number.isFinite(out.lastBackupAt)) delete out.lastBackupAt;
  return out as unknown as Settings;
}

/** Clamps restored timer state: remaining never above the budget, budget never above the cap. */
function clampTimer<T extends { timer?: TimerState | TimerConfig }>(row: T, questions: number): T {
  const t = row.timer as (TimerState & TimerConfig) | undefined;
  if (!t) return row;
  if ('config' in t && t.config) {
    const config = sanitizeTimer(t.config, questions);
    return { ...row, timer: { ...t, config, remainingMs: Math.max(0, Math.min(Number(t.remainingMs) || 0, config.totalMs)), endAt: undefined } };
  }
  return { ...row, timer: sanitizeTimer(t as TimerConfig, questions) };
}

/** Parses a progress JSON text (manifest + inline data). */
export function readProgressJson(text: string): { manifest: string; data: string } | null {
  try {
    const o = JSON.parse(text) as { manifest?: BackupManifest; data?: string };
    if (o?.manifest?.format === BACKUP_FORMAT && typeof o.data === 'string') return { manifest: JSON.stringify(o.manifest), data: o.data };
  } catch {
    /* not a backup */
  }
  return null;
}

const keyOf = (name: store.StoreName, r: Record<string, unknown>) =>
  name === 'packs' || name === 'sessions' || name === 'sessionDetail' ? (r.id as string) : name === 'bankEvents' ? `${r.packId}|${r.qid}|${r.at}|${r.kind}` : name === 'meta' ? (r.key as string) : (r.key as string);

const stamp = (name: store.StoreName, r: Record<string, unknown>): number =>
  Number(name === 'questionStats' ? (r.lastAnsweredAt ?? 0) : (r.updatedAt ?? r.addedAt ?? 0));

/** Verifies the checksum and computes what a restore would add or merge. */
export async function planRestore(manifestText: string, data: string, images: Map<string, Blob>): Promise<RestorePlan> {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new BackupError('The backup manifest is unreadable');
  }
  if (manifest.format !== BACKUP_FORMAT) throw new BackupError('This is not a DMC backup');
  if (!(manifest.tier in TIER_STORES)) throw new BackupError('Unknown backup type');
  if ((await sha256Hex(data)) !== manifest.checksum) throw new BackupError('Checksum mismatch: the backup is corrupted or was edited');
  let raw: Dump;
  try {
    raw = JSON.parse(data) as Dump;
  } catch {
    throw new BackupError('The backup data is unreadable');
  }
  // Only the stores the tier declares, and only rows that pass shape checks.
  const dump: Dump = {};
  for (const name of TIER_STORES[manifest.tier]) {
    const rows = raw[name];
    if (!Array.isArray(rows)) continue;
    // Any invalid row rejects the whole backup: a valid checksum on invalid data means tampering.
    const bad = (rows as Record<string, unknown>[]).findIndex((r) => !validRow(name, r));
    if (bad >= 0) throw new BackupError(`The backup contains an invalid ${name} record (#${bad + 1}); nothing was imported`);
    dump[name] = (rows as Record<string, unknown>[]).map((r) => {
      if (name === 'meta') return { key: 'settings', value: cleanSettings(r.value as Record<string, unknown>) };
      if (name === 'sessions') return clampTimer(r as never, Number(r.total) || 1);
      if (name === 'sessionDetail') return clampTimer(r as never, (r.questionIds as unknown[]).length || 1);
      return r;
    });
  }
  const d = await store.db();
  const adds: Record<string, number> = {};
  const merges: Record<string, number> = {};
  const skips: Record<string, number> = {};
  for (const [name, rows] of Object.entries(dump) as [store.StoreName, Record<string, unknown>[]][]) {
    if (!TIER_STORES.everything.includes(name) || !Array.isArray(rows)) continue;
    const existing = new Map<string, Record<string, unknown>>();
    if (name === 'meta') {
      const s = await d.get('meta', 'settings');
      if (s) existing.set('settings', { key: 'settings', value: s });
    } else for (const r of (await d.getAll(name as never)) as Record<string, unknown>[]) existing.set(keyOf(name, r), r);
    for (const r of rows) {
      const have = existing.get(keyOf(name, r));
      if (!have) adds[name] = (adds[name] ?? 0) + 1;
      else if (name !== 'bankEvents' && name !== 'meta' && stamp(name, r) > stamp(name, have)) merges[name] = (merges[name] ?? 0) + 1;
      else skips[name] = (skips[name] ?? 0) + 1;
    }
  }
  return { manifest, dump, images, adds, merges, skips };
}

/** Applies a restore plan: adds new records, replaces older ones by updatedAt, keeps newer local ones. */
export async function applyRestore(plan: RestorePlan): Promise<void> {
  const d = await store.db();
  const imgs: { id: string; type: string; blob: Blob }[] = [];
  for (const [id, type] of Object.entries(plan.manifest.images ?? {})) {
    const b = plan.images.get(id);
    if (!b || !/^[0-9a-f]{64}$/.test(id) || !/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(type)) continue;
    // Image ids are the SHA-256 of their bytes; anything else was tampered with.
    if ((await sha256Hex(await b.arrayBuffer())) !== id) continue;
    imgs.push({ id, type, blob: new Blob([b], { type }) });
  }
  // One open session per pack: an incoming open session is skipped if its pack already has one.
  const openPacks = new Set((await store.getOpenSessions()).map((s) => s.packId));
  const skippedOpen = new Set<string>();
  const sessions = (plan.dump.sessions ?? []) as Record<string, unknown>[];
  for (const s of sessions.slice().sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))) {
    if (s.status !== 'active' && s.status !== 'saved') continue;
    const local = await d.get('sessions', s.id as string);
    if (local && (local.status === 'active' || local.status === 'saved')) continue;
    if (openPacks.has(s.packId as string)) skippedOpen.add(s.id as string);
    else {
      openPacks.add(s.packId as string);
      s.status = 'saved';
    }
  }
  await store.write(async () => {
    const tx = d.transaction(store.STORES, 'readwrite');
    const winners = new Set<string>(); // packs/sessions whose incoming copy won
    const touchedPacks = new Set<string>();
    const order: store.StoreName[] = ['packs', 'papers', 'sessions', 'sessionDetail', 'questionStats', 'bankEvents', 'overrides', 'meta'];
    for (const name of order) {
      const rows = plan.dump[name] as Record<string, unknown>[] | undefined;
      if (!rows) continue;
      const os = tx.objectStore(name as never) as unknown as {
        get(k: unknown): Promise<Record<string, unknown> | undefined>;
        put(v: unknown, k?: unknown): Promise<unknown>;
        getAll(): Promise<Record<string, unknown>[]>;
      };
      if (name === 'meta') {
        const local = await os.get('settings');
        const inc = rows.find((r) => r.key === 'settings');
        if (inc && (!local || plan.manifest.tier === 'everything')) await os.put(inc.value, 'settings');
        continue;
      }
      const existingEvents = name === 'bankEvents' ? new Set((await os.getAll()).map((r) => keyOf(name, r))) : null;
      for (const r0 of rows) {
        const r = r0;
        if ((name === 'sessions' || name === 'sessionDetail') && skippedOpen.has(r.id as string)) continue;
        if (existingEvents) {
          if (!existingEvents.has(keyOf(name, r))) await os.put(r);
          continue;
        }
        const k = name === 'packs' || name === 'sessions' || name === 'sessionDetail' ? r.id : r.key;
        const have = await os.get(k);
        if (name === 'packs' && have) {
          // Same pack on two devices: keep every paper either copy knows about.
          const newer = stamp(name, r) > stamp(name, have);
          const [base, other] = newer ? [r, have] : [have, r];
          const metas = new Map(((other.papers as { id: string }[]) ?? []).map((m) => [m.id, m] as const));
          for (const m of base.papers as { id: string }[]) metas.set(m.id, m);
          const added = metas.size > (base.papers as unknown[]).length;
          if (newer || added) {
            await os.put({ ...base, papers: [...metas.values()] });
            if (newer) winners.add(`pack:${r.id}`);
            else winners.add(`pack-add:${r.id}`);
          }
          continue;
        }
        let take = !have || stamp(name, r) > stamp(name, have);
        if (name === 'papers') {
          // Question-level merge in both directions: never drop a question either copy has.
          if (have) {
            const incomingWins = winners.has(`pack:${r.packId}`);
            const [base, other] = (incomingWins ? [r, have] : [have, r]) as unknown as [Paper, Paper];
            const merged = mergePaperCopies(base, other);
            if (JSON.stringify(merged) !== JSON.stringify(have)) await os.put(merged);
            // The pack row may have been replaced above; its paper counts follow the stored papers.
            touchedPacks.add(merged.packId);
            continue;
          }
          take = true;
        }
        if (name === 'sessionDetail') take = !have || winners.has(`session:${r.id}`);
        if (take) {
          await os.put(r);
          if (name === 'packs') winners.add(`pack:${r.id}`);
          if (name === 'sessions') winners.add(`session:${r.id}`);
        }
      }
    }
    // Pack paper lists follow the merged papers' real counts.
    for (const packId of touchedPacks) {
      const pk = await tx.objectStore('packs').get(packId);
      if (!pk) continue;
      const ps = await tx.objectStore('papers').index('packId').getAll(packId);
      const metas = new Map(pk.papers.map((m) => [m.id, m] as const));
      for (const p of ps) metas.set(p.id, metaOf(p));
      await tx.objectStore('packs').put({ ...pk, papers: [...metas.values()] });
    }
    const imageStore = tx.objectStore('images');
    for (const i of imgs) if (!(await imageStore.get(i.id))) await imageStore.put(i);
    await tx.done;
  });
}

// ---------- shareable pack export (dmc-pack/1) ----------
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

/** Exports a pack in the documented import format, with fixes applied and images as files. */
export async function exportPackZip(pack: Pack, papers: Paper[], overrides: QuestionOverride[]): Promise<{ blob: Blob; name: string }> {
  const ov = new Map(overrides.map((o) => [o.qid, o] as const));
  const imageIds = new Set<string>();
  const files: Record<string, Uint8Array> = {};
  const types = new Map<string, string>();
  const d = await store.db();
  const pathOf = (id: string) => `images/${id.slice(0, 16)}.${EXT[types.get(id) ?? ''] ?? 'png'}`;
  const fig = (f?: Figure) => {
    if (!f) return undefined;
    if (f.kind === 'svg') return { svg: f.svg, ...(f.alt ? { alt: f.alt } : {}) };
    if (f.kind === 'needed') return { needed: true, ...(f.note ? { note: f.note } : {}) };
    imageIds.add(f.imageId);
    return { file: f.imageId, ...(f.alt ? { alt: f.alt } : {}) };
  };
  const doc = {
    format: FORMAT_ID,
    pack: { title: pack.title, subject: pack.subject },
    papers: papers
      .slice()
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((p) => ({
        id: p.id,
        title: p.title,
        group: p.group,
        questionCount: p.questionCount,
        timeLimitMinutes: p.timeLimitMin,
        optionCount: p.optionCount,
        questions: p.questions.map((q0) => {
          const q = applyOverride(q0, ov.get(q0.id));
          if (q.image) imageIds.add(q.image);
          return {
            n: q.n,
            ...(q.stem !== undefined ? { stem: q.stem } : {}),
            ...(q.image ? { image: q.image } : {}),
            ...(q.figure ? { figure: fig(q.figure) } : {}),
            ...(q.options ? { options: q.options.map((o) => (o.figure ? { ...(o.text ? { text: o.text } : {}), figure: fig(o.figure) } : (o.text ?? ''))) } : {}),
            ...(q.table ? { table: q.table } : {}),
            answer: q.answer === null ? null : LETTERS[q.answer],
            ...(q.topic ? { topic: q.topic } : {}),
            ...(q.explanation ? { explanation: q.explanation } : {}),
          };
        }),
      })),
  };
  for (const id of imageIds) {
    const img = await d.get('images', id);
    if (!img) continue;
    types.set(id, img.type);
    files[pathOf(id)] = new Uint8Array(await img.blob.arrayBuffer());
  }
  // Replace image ids with file paths now that types are known.
  const json = JSON.stringify(doc, null, 2).replace(/"(file|image)": "([0-9a-f]{64})"/g, (_m, k: string, id: string) => `"${k}": "${pathOf(id)}"`);
  const { zipSync, strToU8 } = await import('fflate');
  const zip = zipSync({ 'pack.json': strToU8(json), ...files }, { level: 6 });
  return { blob: new Blob([zip as BlobPart], { type: 'application/zip' }), name: `${pack.id}.dmc.zip` };
}

export type { Settings };
