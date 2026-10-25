import { useMemo, useState } from 'preact/hooks';
import { paperComplete } from '../lib/format/merge';
import type { PaperMeta } from '../lib/types';
import { Badge, relDay, Ring } from '../ui/kit';
import { Icon } from '../ui/icons';

export interface LadderRow {
  paper: PaperMeta;
  attempts: number;
  best: number | null;
  latest: number | null;
  lastAt?: number;
}

type Filter = 'not-started' | 'in-progress' | 'done' | 'weak' | 'incomplete';
const FILTERS: [Filter, string][] = [
  ['not-started', 'Not started'],
  ['in-progress', 'In progress'],
  ['done', 'Done'],
  ['weak', 'Weak'],
  ['incomplete', 'Incomplete'],
];
/** A paper is weak when its latest complete attempt scored under 60%. */
export const WEAK = 0.6;

interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  papers: LadderRow[];
}
const count = (n: Node): number => n.papers.length + [...n.children.values()].reduce((a, c) => a + count(c), 0);
const byName = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

export function PapersBrowser({ rows, inProgress, onPick }: { rows: LadderRow[]; inProgress: Set<string>; onPick: (p: PaperMeta) => void }) {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [sort, setSort] = useState<'order' | 'best' | 'recent'>('order');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const match = (r: LadderRow) => {
    if (q.trim() && !`${r.paper.title} ${r.paper.group.join(' ')} ${r.paper.id}`.toLowerCase().includes(q.trim().toLowerCase())) return false;
    if (!filters.size) return true;
    const ready = paperComplete(r.paper);
    return [...filters].some((f) =>
      f === 'not-started' ? ready && !r.attempts && !inProgress.has(r.paper.id) : f === 'in-progress' ? inProgress.has(r.paper.id) : f === 'done' ? r.attempts > 0 : f === 'weak' ? r.latest !== null && r.latest < WEAK : !ready,
    );
  };

  const tree = useMemo(() => {
    const root: Node = { name: '', path: '', children: new Map(), papers: [] };
    const sorted = rows.filter(match).sort((a, b) =>
      sort === 'best'
          ? (a.best ?? -1) - (b.best ?? -1)
          : sort === 'recent'
            ? (b.lastAt ?? 0) - (a.lastAt ?? 0)
            : a.paper.title.localeCompare(b.paper.title, undefined, { numeric: true }),
    );
    for (const r of sorted) {
      let node = root;
      let path = '';
      for (const g of r.paper.group) {
        path = path ? `${path} > ${g}` : g;
        let next = node.children.get(g);
        if (!next) {
          next = { name: g, path, children: new Map(), papers: [] };
          node.children.set(g, next);
        }
        node = next;
      }
      node.papers.push(r);
    }
    return root;
  }, [rows, q, filters, sort, inProgress]);

  // Most recent group expanded by default (the first in descending order, down one branch).
  const defaults = useMemo(() => {
    const d = new Set<string>();
    let node: Node | undefined = tree;
    while (node && node.children.size) {
      node = [...node.children.values()].sort((a, b) => byName(a.name, b.name))[0];
      if (node) d.add(node.path);
    }
    return d;
  }, [tree]);
  const isOpen = (p: string) => (q.trim() || filters.size ? true : open[p] ?? defaults.has(p));

  const toggleFilter = (f: Filter) => {
    const s = new Set(filters);
    if (s.has(f)) s.delete(f);
    else s.add(f);
    setFilters(s);
  };

  const card = (r: LadderRow) => {
    const p = r.paper;
    return (
      <button type="button" class="jy-panel jy-panel--link paper-card" key={p.id} onClick={() => onPick(p)}>
        <span class="t">{p.title}</span>
        <Ring value={r.best} size={44} stroke={4} label={r.best === null ? 'No attempts yet' : `Best ${Math.round(r.best * 100)}%`} />
        <span class="m meta1">
          <span><span class="num">{p.questionCount}</span> Q</span>
          <span><span class="num">{p.timeLimitMin}</span> min</span>
          <span><span class="num">{r.attempts}</span> attempt{r.attempts === 1 ? '' : 's'}</span>
          {r.lastAt && <span>{relDay(r.lastAt)}</span>}
        </span>
        <span class="m">
          {inProgress.has(p.id) && <Badge status="ink">In progress</Badge>}
          {p.present < p.questionCount && <Badge status="warn">{p.present}/{p.questionCount} questions</Badge>}
          {p.present >= p.questionCount && p.keyed < p.questionCount && <Badge status="warn">No key: Exam only</Badge>}
          {p.figuresNeeded > 0 && <Badge status="warn">{p.figuresNeeded} need figure</Badge>}
          {r.latest !== null && r.latest < WEAK && <Badge status="bad">Weak</Badge>}
        </span>
      </button>
    );
  };

  const renderNode = (node: Node, depth: number) => (
    <>
      {node.papers.length > 0 && <div class="paper-grid">{node.papers.map(card)}</div>}
      {[...node.children.values()]
        .sort((a, b) => byName(a.name, b.name))
        .map((c) => (
          <div class="group" key={c.path} style={{ marginLeft: depth ? 0 : undefined }}>
            <button type="button" aria-expanded={isOpen(c.path)} onClick={() => setOpen({ ...open, [c.path]: !isOpen(c.path) })}>
              <Icon name="down" size={18} />
              {c.name} <span class="count">{count(c)}</span>
            </button>
            {isOpen(c.path) && <div class="group-body">{renderNode(c, depth + 1)}</div>}
          </div>
        ))}
    </>
  );

  const total = count(tree);
  return (
    <div>
      <div class="papers-tools">
        <label class="sr-only" for="paper-search">Search papers</label>
        <input id="paper-search" class="input" type="search" placeholder="Search papers" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <div class="chips" role="group" aria-label="Filter papers">
          {FILTERS.map(([f, l]) => (
            <button type="button" class="chip" aria-pressed={filters.has(f)} onClick={() => toggleFilter(f)} key={f}>
              {l}
            </button>
          ))}
        </div>
        <span class="spacer" />
        <label class="sr-only" for="paper-sort">Sort papers</label>
        <select id="paper-sort" class="select" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as never)}>
          <option value="order">Title</option>
          <option value="recent">Last practised</option>
          <option value="best">Lowest best score</option>
        </select>
      </div>
      {total === 0 ? <p class="muted">No papers match. Clear the search or filters.</p> : renderNode(tree, 0)}
    </div>
  );
}
