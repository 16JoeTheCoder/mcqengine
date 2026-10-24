import { FORMAT_ID } from '../format/validate';
import { LETTERS, type Figure, type Pack, type Paper, type QuestionOverride, type Settings } from '../types';
import { applyOverride } from '../format/merge';
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
  if ((await sha256Hex(data)) !== manifest.checksum) throw new BackupError('Checksum mismatch: the backup is corrupted or was edited');
  const dump = JSON.parse(data) as Dump;
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
    if (b && /^[0-9a-f]{64}$/.test(id)) imgs.push({ id, type, blob: new Blob([b], { type }) });
  }
  await store.write(async () => {
    const tx = d.transaction(store.STORES, 'readwrite');
    const winners = new Set<string>(); // packs/sessions whose incoming copy won
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
      for (const r of rows) {
        if (existingEvents) {
          if (!existingEvents.has(keyOf(name, r))) await os.put(r);
          continue;
        }
        const k = name === 'packs' || name === 'sessions' || name === 'sessionDetail' ? r.id : r.key;
        const have = await os.get(k);
        let take = !have || stamp(name, r) > stamp(name, have);
        if (name === 'papers') take = !have || winners.has(`pack:${r.packId}`);
        if (name === 'sessionDetail') take = !have || winners.has(`session:${r.id}`);
        if (take) {
          await os.put(r);
          if (name === 'packs') winners.add(`pack:${r.id}`);
          if (name === 'sessions') winners.add(`session:${r.id}`);
        }
      }
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
