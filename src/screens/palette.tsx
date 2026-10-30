import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { href, navigate } from '../lib/app-state';
import type { Pack } from '../lib/types';
import { Modal } from '../ui/kit';
import { startDaily } from './daily';
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

/** Ctrl+K / Cmd+K: jump anywhere or run an action, by keyboard. */
export function CommandPalette({ onClose, actions }: { onClose: () => void; actions: Command[] }) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => void store.getPacks().then((p) => setPacks(p.sort((a, b) => (b.lastPractisedAt ?? b.updatedAt) - (a.lastPractisedAt ?? a.updatedAt)))), []);

  const all = useMemo<Command[]>(
    () => [
      ...actions,
      ...packs.map((p) => ({ id: `pack:${p.id}`, label: `Open ${p.title}`, hint: p.subject, run: () => navigate(href.pack(p.id)) })),
      ...packs.map((p) => ({ id: `daily:${p.id}`, label: `Daily 10 in ${p.title}`, hint: 'mistakes due today', run: () => void startDaily(p) })),
      ...packs.map((p) => ({ id: `ins:${p.id}`, label: `Insights for ${p.title}`, run: () => navigate(href.pack(p.id, 'insights')) })),
      { id: 'home', label: 'Go home', hint: 'your packs', run: () => navigate(href.library()) },
      { id: 'school', label: 'School Library', hint: 'shared paper sets', run: () => navigate(href.school()) },
      { id: 'settings', label: 'Settings', run: () => navigate(href.settings()) },
      { id: 'backup', label: 'Export everything', hint: 'backup', run: () => void doBackup('everything') },
    ],
    [packs, actions],
  );
  const shown = filterCommands(all, q).slice(0, 12);
  const pick = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <Modal title="Go to" onClose={onClose}>
      <input
        ref={input}
        class="input"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[i] ? `${listId}-${i}` : undefined}
        aria-label="Search commands and packs"
        placeholder="Type a pack or an action"
        value={q}
        autoFocus
        onInput={(e) => {
          setQ((e.target as HTMLInputElement).value);
          setI(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setI((x) => (x + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % Math.max(1, shown.length));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(shown[i]);
          }
        }}
      />
      <ul class="palette" role="listbox" id={listId} aria-label="Results">
        {shown.map((c, k) => (
          <li key={c.id} id={`${listId}-${k}`} role="option" aria-selected={k === i} onMouseEnter={() => setI(k)} onClick={() => pick(c)}>
            <span>{c.label}</span>
            {c.hint && <span class="small subtle">{c.hint}</span>}
          </li>
        ))}
        {!shown.length && <li class="small muted" role="option" aria-disabled="true" aria-selected="false">Nothing matches.</li>}
      </ul>
    </Modal>
  );
}
