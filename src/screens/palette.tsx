import { Fragment } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { href, navigate, useStore } from '../lib/app-state';
import { authStore, backend } from '../lib/backend';
import type { SearchResults } from '../lib/backend/types';
import { buildLocalIndex, searchLocal, type LocalItem } from '../lib/search';
import type { Pack } from '../lib/types';
import { Modal } from '../ui/kit';
import { doBackup } from './data';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Ranks by word-prefix match first, then substring; empty query keeps the given order. */
export function filterCommands(cmds: Command[], q: string): Command[] {
  const t = q.trim().toLowerCase();
  if (!t) return cmds;
  const score = (c: Command) => {
    const l = `${c.label} ${c.hint ?? ''}`.toLowerCase();
    if (l.startsWith(t)) return 0;
    if (l.split(/\s+/).some((w) => w.startsWith(t))) return 1;
    return l.includes(t) ? 2 : 3;
  };
  return cmds.map((c) => [c, score(c)] as const).filter(([, s]) => s < 3).sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

type Row = { id: string; group: string; label: string; hint?: string; run: () => void };

/**
 * Search everything (top bar, or Ctrl+K / Cmd+K): actions, the paper sets, papers and questions
 * on this device, and, for school accounts, Library sets and people (only what the server lets
 * this account see). Keyboard: arrows move, Enter opens, Escape closes.
 */
export function CommandPalette({ onClose, actions }: { onClose: () => void; actions: Command[] }) {
  const [index, setIndex] = useState<LocalItem[] | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [remote, setRemote] = useState<SearchResults | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const auth = useStore(authStore);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void (async () => {
      const ps = (await store.getPacks()).sort((a, b) => (b.lastPractisedAt ?? b.updatedAt) - (a.lastPractisedAt ?? a.updatedAt));
      setPacks(ps);
      const papers = (await Promise.all(ps.map((p) => store.getPapers(p.id)))).flat();
      setIndex(buildLocalIndex(ps, papers));
    })();
  }, []);
  // Library sets and people: debounced, cancelled when the query changes.
  useEffect(() => {
    setRemote(null);
    if (!backend || !auth.status.member || q.trim().length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setRemoteBusy(true);
      backend!.search(q.trim(), ctl.signal).then(setRemote).catch(() => undefined).finally(() => setRemoteBusy(false));
    }, 200);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, auth.status.member]);

  const commands = useMemo<Command[]>(
    () => [
      ...actions,
      { id: 'home', label: 'Go home', hint: 'your paper sets', run: () => navigate(href.library()) },
      { id: 'school', label: 'School Library', hint: 'shared paper sets', run: () => navigate(href.school()) },
      ...(auth.account?.handle ? [{ id: 'me', label: 'Your profile', run: () => navigate(href.profile(auth.account!.handle!)) }] : []),
      ...(auth.status.admin ? [{ id: 'admin', label: 'Admin dashboard', run: () => navigate(href.admin()) }] : []),
      { id: 'settings', label: 'Settings', run: () => navigate(href.settings()) },
      { id: 'backup', label: 'Export everything', hint: 'backup', run: () => void doBackup('everything') },
      ...packs.map((p) => ({ id: `ins:${p.id}`, label: `Insights for ${p.title}`, run: () => navigate(href.pack(p.id, 'insights')) })),
      ...packs.map((p) => ({ id: `nb:${p.id}`, label: `Notebook for ${p.title}`, run: () => navigate(href.notebook(p.id)) })),
    ],
    [packs, actions, auth],
  );
  const KIND = { set: 'Paper sets on this device', paper: 'Papers', question: 'Questions' } as const;
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (!q.trim()) {
      for (const p of packs.slice(0, 6)) out.push({ id: `pack:${p.id}`, group: 'Recent paper sets', label: p.title, hint: p.subject, run: () => navigate(href.pack(p.id)) });
      for (const c of commands.slice(0, 8)) out.push({ id: c.id, group: 'Go to', label: c.label, ...(c.hint ? { hint: c.hint } : {}), run: c.run });
      return out;
    }
    for (const it of searchLocal(index ?? [], q, 24)) out.push({ id: `${it.kind}:${it.id}`, group: KIND[it.kind], label: it.title, hint: it.kind === 'set' ? it.sub : it.kind === 'paper' ? it.sub : it.sub, run: () => navigate(it.kind === 'set' ? href.pack(it.packId) : href.pack(it.packId, 'papers')) });
    for (const s of remote?.sets ?? []) out.push({ id: `lib:${s.id}`, group: 'School Library', label: s.title, hint: `${s.ownerName}${s.subject ? ` · ${s.subject}` : ''}`, run: () => navigate(href.school(s.title)) });
    for (const p of remote?.people ?? []) out.push({ id: `u:${p.handle}`, group: 'People', label: p.name, hint: p.headline || `@${p.handle}`, run: () => navigate(href.profile(p.handle)) });
    for (const c of filterCommands(commands, q).slice(0, 6)) out.push({ id: c.id, group: 'Actions', label: c.label, ...(c.hint ? { hint: c.hint } : {}), run: c.run });
    return out;
  }, [q, index, remote, commands, packs]);
  const pick = (r?: Row) => {
    if (!r) return;
    onClose();
    r.run();
  };

  return (
    <Modal title="Search" onClose={onClose}>
      <input
        ref={input}
        class="input search-input"
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={rows[i] ? `${listId}-${i}` : undefined}
        aria-label="Search everything"
        placeholder="Sets, questions, people"
        value={q}
        autoFocus
        onInput={(e) => {
          setQ((e.target as HTMLInputElement).value);
          setI(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setI((x) => (x + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % Math.max(1, rows.length));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(rows[i]);
          }
        }}
      />
      <ul class="palette" role="listbox" id={listId} aria-label="Results">
        {rows.map((r, k) => (
          <Fragment key={r.id}>
            {(k === 0 || rows[k - 1]!.group !== r.group) && <li class="palette-group label" role="presentation">{r.group}</li>}
            <li id={`${listId}-${k}`} role="option" aria-selected={k === i} onMouseEnter={() => setI(k)} onClick={() => pick(r)}>
              <span>{r.label}</span>
              {r.hint && <span class="small subtle">{r.hint}</span>}
            </li>
          </Fragment>
        ))}
        {q.trim() && !rows.length && <li class="small muted" role="option" aria-disabled="true" aria-selected="false">{index ? 'Nothing matches.' : 'Reading this device…'}</li>}
      </ul>
      <p class="small subtle" aria-live="polite">{remoteBusy ? 'Searching the School Library…' : backend && !auth.status.member && q.trim() ? 'The School Library and people are searched for school accounts.' : ''}</p>
    </Modal>
  );
}
