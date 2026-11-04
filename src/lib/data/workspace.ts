import { deleteDB, openDB } from 'idb';
import { db, STORES, useDbName, type DmcSchema } from './db';
import { validRow } from './backup';

// The original database remains an explicitly adoptable guest/legacy workspace.
export const workspaceName = (account: string | null) => account ? `dmc-account-${encodeURIComponent(account)}` : 'dmc-guest';
export function selectWorkspace(account: string | null) { useDbName(workspaceName(account)); }
export async function removeWorkspace(account: string) { await deleteDB(workspaceName(account)); }

/** Explicit copy, never a move. Existing account records win; sync metadata never crosses. */
export async function adoptGuest(sourceName = workspaceName(null)): Promise<number> {
  const target = await db();
  if (target.name === workspaceName(null) && sourceName === workspaceName(null)) throw new Error('Sign in before importing guest data');
  const guest = await openDB<DmcSchema>(sourceName);
  if (!guest.objectStoreNames.contains('packs')) { guest.close(); return 0; }
  try {
    const rows = new Map<string, unknown[]>();
    for (const name of STORES) {
      if (name === 'meta' || name === 'questionStats' || name === 'bankEvents' || !guest.objectStoreNames.contains(name)) continue;
      rows.set(name, await guest.getAll(name));
    }
    const tx = target.transaction(STORES, 'readwrite');
    await tx.objectStore('meta').delete('sessionRevisions');
    let count = 0;
    for (const [name, values] of rows) {
      const store = tx.objectStore(name as Exclude<typeof STORES[number], 'meta'>);
      for (const value of values) {
        const row = value as Record<string, unknown>;
        if (name === 'images' || name === 'pdfs') {
          if (typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) || !(row.blob instanceof Blob) || row.blob.size > (name === 'images' ? 5_000_000 : 60_000_000)) continue;
        } else if (!validRow(name as typeof STORES[number], row)) continue;
        const key = ['papers', 'snips', 'overrides', 'questionStats'].includes(name) ? row.key : row.id;
        if (typeof key !== 'string' || await store.get(key)) continue;
        await store.put(value as never); count++;
      }
    }
    await tx.done;
    const { rebuildStats } = await import('../engine/regrade');
    for (const pack of await target.getAll('packs')) await rebuildStats(pack.id);
    return count;
  } finally { guest.close(); }
}

/** Original mixed-account caches stay quarantined until their known owner explicitly imports. */
export async function adoptLegacy(account: string | null): Promise<number> {
  const legacy = await openDB<DmcSchema>('dmc');
  let owner: string | undefined;
  try {
    if (legacy.objectStoreNames.contains('meta')) owner = ((await legacy.get('meta', 'sync')) as {account?: string} | undefined)?.account;
  } finally { legacy.close(); }
  if (owner && owner !== account) throw new Error('The legacy cache belongs to another account. Sign in with that account to recover it.');
  return adoptGuest('dmc');
}

