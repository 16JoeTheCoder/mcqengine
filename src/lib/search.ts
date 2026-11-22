import type { Pack, Paper } from './types';

/**
 * Search everything on this device: paper sets, papers and question text. The index is built on
 * demand from IndexedDB and searched in memory; Library sets and people come from the server
 * (GET /api/search), which applies the same access rules as their own pages.
 */
export type LocalKind = 'set' | 'paper' | 'question';
export interface LocalItem { kind: LocalKind; id: string; title: string; sub: string; packId: string; text: string }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
/** Question stems keep their first 400 characters: enough to find a question by its wording. */
const STEM = 400;

export function buildLocalIndex(packs: Pack[], papers: Paper[]): LocalItem[] {
  const out: LocalItem[] = [];
  const byPack = new Map(packs.map((p) => [p.id, p] as const));
  for (const p of packs) out.push({ kind: 'set', id: p.id, title: p.title, sub: p.subject || 'Paper set', packId: p.id, text: norm(`${p.title} ${p.subject} ${p.description ?? ''}`) });
  for (const paper of papers) {
    const pack = byPack.get(paper.packId);
    if (!pack) continue;
    out.push({ kind: 'paper', id: paper.key, title: paper.title, sub: pack.title, packId: pack.id, text: norm(`${paper.title} ${paper.group.join(' ')} ${paper.paperKey ?? ''}`) });
    for (const q of paper.questions) {
      const words = [q.stem ?? '', ...(q.options ?? []).map((o) => o.text ?? '')].join(' ').slice(0, STEM);
      if (!words.trim()) continue;
      out.push({ kind: 'question', id: `${paper.key}#${q.n}`, title: `Q${q.n} · ${paper.title}`, sub: words.replace(/\s+/g, ' ').slice(0, 120), packId: pack.id, text: norm(words) });
    }
  }
  return out;
}

/**
 * Every query word must match the start of a word in the item (prefix search). Ranked: title
 * matches first, then sets before papers before questions, then shorter titles.
 */
export function searchLocal(index: readonly LocalItem[], q: string, limit = 20): LocalItem[] {
  const words = norm(q).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return [];
  const re = words.map((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
  const rank = { set: 0, paper: 1, question: 2 } as const;
  return index
    .filter((it) => re.every((r) => r.test(it.text)))
    .map((it) => ({ it, score: (re.every((r) => r.test(norm(it.title))) ? 0 : 10) + rank[it.kind] }))
    .sort((a, b) => a.score - b.score || a.it.title.length - b.it.title.length)
    .slice(0, limit)
    .map((x) => x.it);
}
