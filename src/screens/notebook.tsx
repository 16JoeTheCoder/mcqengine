import { useEffect, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { loadPackContent } from '../lib/engine/session';
import { href, navigate } from '../lib/app-state';
import { CAUSES, LETTERS, type Cause, type Pack, type Question, type QuestionStat } from '../lib/types';
import { Badge, Button, fmtDate, Skeleton, focusMainIfLost } from '../ui/kit';
import { Icon } from '../ui/icons';
import { FigureView, OptionBody, QuestionImage, Rich } from '../ui/content';
import { Signature } from '../ui/brand';
import { lazy } from '../ui/lazy';

const SnipImage = lazy(() => import('./pdf-tools').then((m) => m.SnipImage));

interface Entry {
  q: Question;
  paper: string;
  stat: QuestionStat;
  cause?: Cause;
}

/**
 * The mistakes notebook: every question in the bank with its key, how often it was missed and
 * why. Printed, it follows the study-sheet rules: low ink, single column, outlines not fills,
 * body at 11 pt or more, the signature in the footer.
 */
export function Notebook({ packId }: { packId: string }) {
  const [data, setData] = useState<{ pack: Pack; entries: Entry[] } | null | 'missing'>(null);
  useEffect(() => {
    void (async () => {
      const pack = await store.getPack(packId);
      if (!pack) return setData('missing');
      const [{ papers }, stats, sessions] = await Promise.all([loadPackContent(packId), store.getStats(packId), store.getSessions(packId)]);
      const causes = new Map<string, Cause>();
      for (const s of sessions.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))) for (const [qid, c] of Object.entries(s.causes ?? {})) causes.set(qid, c);
      const byQ = new Map(stats.map((s) => [s.qid, s] as const));
      const entries: Entry[] = [];
      for (const p of papers)
        for (const q of p.questions) {
          const stat = byQ.get(q.id);
          if (stat?.inBank) entries.push({ q, paper: p.title, stat, ...(causes.has(q.id) ? { cause: causes.get(q.id)! } : {}) });
        }
      setData({ pack, entries });
      focusMainIfLost();
    })();
  }, [packId]);

  if (data === 'missing')
    return (
      <main class="page" style={{ paddingTop: '96px' }}>
        <h1>Pack not found</h1>
      </main>
    );
  if (!data)
    return (
      <main class="page" aria-busy="true">
        <div class="hero"><Skeleton h={64} /></div>
        <Skeleton h={240} />
      </main>
    );
  const { pack, entries } = data;
  return (
    <main class="page notebook" id="main" tabIndex={-1}>
      <section class="hero" style={{ paddingBottom: 'var(--space-5)' }}>
        <span class="label">{pack.title}</span>
        <h1 class="display"><span class="light">Mistakes</span> notebook</h1>
        <p class="muted">{entries.length} question{entries.length === 1 ? '' : 's'} in your mistakes bank, as of {fmtDate(Date.now())}.</p>
        <div class="row no-print">
          <Button onClick={() => navigate(href.pack(packId))}><Icon name="left" size={18} /> Back to pack</Button>
          <Button variant="primary" onClick={() => print()} disabled={!entries.length}>Print</Button>
        </div>
      </section>
      {!entries.length ? (
        <div class="locked" style={{ minHeight: '160px' }}>
          <b>Your mistakes bank is empty</b>
          <span class="small">Wrong answers, and right answers you marked Unsure, appear here until you get them right twice in a row.</span>
        </div>
      ) : (
        <ol class="nb-list">
          {entries.map(({ q, paper, stat, cause }) => (
            <li class="nb-item" key={q.id}>
              <div class="nb-head">
                <b>{paper} · Q{q.n}</b>
                <span class="small muted">Missed {stat.missed}× · last seen {fmtDate(stat.lastAnsweredAt)}{cause ? ` · ${CAUSES.find((c) => c.value === cause)?.label}` : ''}</span>
              </div>
              {q.image && <QuestionImage imageId={q.image} n={q.n} />}
              {q.snip && !q.image && <SnipImage snip={q.snip} label={`Question ${q.n} as printed`} />}
              {q.stem && <div class="nb-stem"><Rich text={q.stem} /></div>}
              {q.figure && <FigureView figure={q.figure} />}
              {(q.options || q.table) && (
                <ol class="nb-opts">
                  {Array.from({ length: q.optionCount }, (_, i) => (
                    <li key={i} class={i === q.answer ? 'key' : ''}>
                      <b class="num">{LETTERS[i]}</b> <span><OptionBody q={q} i={i} /></span>
                      {i === q.answer && <Badge status="ok">Answer</Badge>}
                    </li>
                  ))}
                </ol>
              )}
              {!q.options && !q.table && q.answer !== null && <p>Answer: <b class="num">{LETTERS[q.answer]}</b></p>}
              {q.explanation && <p class="small"><Rich text={q.explanation} /></p>}
            </li>
          ))}
        </ol>
      )}
      <footer class="nb-sign print-only">
        <Signature height={28} kind="outline" />
        <span class="small">DMC mistakes notebook · {pack.title} · {fmtDate(Date.now())}</span>
      </footer>
    </main>
  );
}
