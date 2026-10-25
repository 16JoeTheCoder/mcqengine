import { useEffect, useMemo, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { papersDone } from '../lib/stats/kpi';
import { dataVersion, href, useStore } from '../lib/app-state';
import type { Pack, SessionSummary } from '../lib/types';
import { Badge, Button, plural, relDay, Ring, Skeleton } from '../ui/kit';
import { Icon } from '../ui/icons';

export function Library({ onPrompt, onImport }: { onPrompt: () => void; onImport: () => void }) {
  const v = useStore(dataVersion);
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'recent' | 'name' | 'progress'>('recent');

  useEffect(() => {
    void Promise.all([store.getPacks(), store.getAllSessions()]).then(([p, s]) => {
      setPacks(p);
      setSessions(s);
    });
  }, [v]);

  const rows = useMemo(() => {
    if (!packs) return [];
    const byPack = new Map<string, SessionSummary[]>();
    for (const s of sessions) byPack.set(s.packId, [...(byPack.get(s.packId) ?? []), s]);
    return packs
      .map((p) => {
        const ss = byPack.get(p.id) ?? [];
        const done = papersDone(ss);
        return {
          p,
          done: p.papers.filter((x) => done.has(x.id)).length,
          questions: p.papers.reduce((a, x) => a + x.present, 0),
          saved: ss.some((s) => s.status === 'saved' || s.status === 'active'),
          unkeyed: p.papers.filter((x) => x.keyed < x.questionCount || x.present < x.questionCount).length,
          next: p.papers.find((x) => !done.has(x.id) && x.keyed >= x.questionCount && x.present >= x.questionCount)?.title,
        };
      })
      .filter(({ p }) => !q.trim() || `${p.title} ${p.subject}`.toLowerCase().includes(q.trim().toLowerCase()))
      .sort((a, b) =>
        sort === 'name'
          ? a.p.title.localeCompare(b.p.title)
          : sort === 'progress'
            ? b.done / Math.max(1, b.p.papers.length) - a.done / Math.max(1, a.p.papers.length)
            : (b.p.lastPractisedAt ?? b.p.updatedAt) - (a.p.lastPractisedAt ?? a.p.updatedAt),
      );
  }, [packs, sessions, q, sort]);

  if (!packs)
    return (
      <main class="page" aria-busy="true">
        <div class="hero"><Skeleton h={48} /></div>
        <div class="cards"><Skeleton h={208} /><Skeleton h={208} /><Skeleton h={208} /></div>
      </main>
    );

  if (!packs.length)
    return (
      <main class="page" id="main" tabIndex={-1}>
        <section class="onboard">
          <div class="stack" style={{ gap: 'var(--space-5)' }}>
            <h1 class="display">
              <span class="light">Practise like it is</span> the real paper.
            </h1>
            <p class="lead">DMC turns your past papers into timed, exam-realistic practice and shows honest progress. Everything stays on this device.</p>
            <div class="row">
              <Button variant="accent" size="lg" onClick={onPrompt}>
                <Icon name="sparkles" size={18} /> Make a pack with AI
              </Button>
              <Button size="lg" onClick={onImport}>
                <Icon name="upload" size={18} /> Import a pack file
              </Button>
            </div>
          </div>
          <div class="jy-panel stack">
            <div class="label">How it works</div>
            <ol class="steps">
              <li><span><b>Make a prompt.</b> Tell DMC about your paper; it writes a precise prompt for any AI chat.</span></li>
              <li><span><b>Transcribe.</b> Attach the PDF in the AI chat and paste the prompt. It replies with JSON.</span></li>
              <li><span><b>Import and practise.</b> DMC checks every question, then you practise full papers, random sets or your mistakes.</span></li>
            </ol>
          </div>
        </section>
      </main>
    );

  return (
    <main class="page" id="main" tabIndex={-1}>
      <section class="hero" style={{ paddingBottom: 'var(--space-6)' }}>
        <div class="row" style={{ alignItems: 'flex-end', gap: 'var(--space-5)' }}>
          <div class="stack-s" style={{ flex: 1, minWidth: '240px' }}>
            <h1 class="display"><span class="light">Your</span> packs</h1>
            <p class="muted">{packs.length} pack{packs.length === 1 ? '' : 's'} on this device.</p>
          </div>
          <Button variant="accent" size="lg" onClick={onPrompt}>
            <Icon name="sparkles" size={18} /> Make a pack with AI
          </Button>
        </div>
      </section>
      {packs.length > 3 && (
        <div class="lib-tools">
          <label class="sr-only" for="pack-search">Search packs</label>
          <input id="pack-search" class="input" type="search" placeholder="Search packs" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          <label class="sr-only" for="pack-sort">Sort packs</label>
          <select id="pack-sort" class="select" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as never)}>
            <option value="recent">Recently practised</option>
            <option value="name">Name</option>
            <option value="progress">Progress</option>
          </select>
        </div>
      )}
      <div class="cards">
        {rows.map(({ p, done, questions, saved, unkeyed, next }) => (
          <a class="jy-panel jy-panel--link pack-card" href={href.pack(p.id)} key={p.id}>
            <div class="top">
              <div class="stack-s" style={{ minWidth: 0 }}>
                <span class="label">{p.subject || 'Pack'}</span>
                <h2 style={{ fontSize: '22px', lineHeight: '28px', overflowWrap: 'anywhere' }}>{p.title}</h2>
              </div>
              <Ring size={64} value={p.papers.length ? done / p.papers.length : 0} text={`${done}/${p.papers.length}`} label={`${done} of ${p.papers.length} papers done`} />
            </div>
            <div class="row status small" style={{ gap: 'var(--space-3)' }}>
              {saved ? <Badge status="ink">Saved session</Badge> : next ? <span>Next: <b>{next}</b></span> : p.papers.length ? <span class="muted">Every paper done once</span> : <span class="muted">No papers yet</span>}
              {unkeyed > 0 && <Badge status="warn">{unkeyed} incomplete</Badge>}
            </div>
            <div>
              <div class="meta">
                <span class="num">{plural(p.papers.length, 'paper')}</span>
                <span class="num">{plural(questions, 'question')}</span>
                <span>{relDay(p.lastPractisedAt)}</span>
              </div>
            </div>
          </a>
        ))}
        <button type="button" class="jy-panel jy-panel--link add-card" onClick={onImport}>
          <Icon name="plus" size={28} />
          <b>Add pack</b>
          <span class="small muted">Import JSON, a zip or a folder</span>
        </button>
      </div>
    </main>
  );
}
