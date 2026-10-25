import { shuffle, type Rng } from './rng';

export interface PoolItem {
  qid: string;
  timesSeen: number;
  lastWrong?: boolean;
  lastUnsure?: boolean;
}

/**
 * The pack's standard paper length: the most common paper question count.
 * Ties go to the longer length, so a pack of equal numbers of 30- and 40-question papers uses 40.
 */
export function standardLength(counts: number[]): number {
  const freq = new Map<number, number>();
  for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
  let best = 0;
  let bestF = 0;
  for (const [c, f] of freq) if (f > bestF || (f === bestF && c > best)) [best, bestF] = [c, f];
  return best;
}

/** Smart-random weight: previously wrong and Unsure questions are more likely within a tier. */
export function smartWeight(p: PoolItem): number {
  return 1 + (p.lastWrong ? 2 : 0) + (p.lastUnsure ? 1 : 0);
}

/** Weighted sampling without replacement (Efraimidis-Spirakis): key = u^(1/w), take the largest. */
function weightedPick(items: PoolItem[], k: number, rng: Rng): PoolItem[] {
  return items
    .map((p) => ({ p, key: Math.pow(Math.max(rng(), 1e-12), 1 / smartWeight(p)) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, k)
    .map((x) => x.p);
}

/**
 * Draws a random session. Takes the lowest-timesSeen tier first; when a tier is smaller than
 * what is still needed, all of it is taken and the next tier fills the rest. Questions in
 * `excluded` (locked by an in-progress or saved session) are never drawn. Result is shuffled.
 */
export function drawRandom(
  pool: PoolItem[],
  size: number,
  excluded: ReadonlySet<string>,
  rng: Rng,
  smart = false,
): string[] {
  const seen = new Set<string>();
  const available = pool.filter((p) => {
    if (excluded.has(p.qid) || seen.has(p.qid)) return false;
    seen.add(p.qid);
    return true;
  });
  const tiers = new Map<number, PoolItem[]>();
  for (const p of available) {
    const t = Math.max(0, Math.floor(p.timesSeen));
    const list = tiers.get(t);
    if (list) list.push(p);
    else tiers.set(t, [p]);
  }
  const out: string[] = [];
  for (const t of [...tiers.keys()].sort((a, b) => a - b)) {
    const need = size - out.length;
    if (need <= 0) break;
    const tier = tiers.get(t) ?? [];
    if (tier.length <= need) out.push(...tier.map((p) => p.qid));
    else {
      const picked = smart ? weightedPick(tier, need, rng) : shuffle(tier, rng).slice(0, need);
      out.push(...picked.map((p) => p.qid));
    }
  }
  return shuffle(out, rng);
}

/** Share of the pool that has never been answered in a submitted session. */
export function unseenShare(pool: PoolItem[]): number {
  if (!pool.length) return 0;
  return pool.filter((p) => p.timesSeen === 0).length / pool.length;
}
