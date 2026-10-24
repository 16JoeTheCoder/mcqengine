import { useEffect, useMemo, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { loadSessionQuestions } from '../lib/engine/session';
import { gradeSession } from '../lib/engine/grade';
import { formatClock } from '../lib/engine/timer';
import { detectRushed, type RushedReport } from '../lib/stats/rushed';
import { median } from '../lib/stats/core';
import { href, navigate, settingsStore, updateSettings, useStore } from '../lib/app-state';
import { LETTERS, type Question, type SessionDetail, type SessionSummary } from '../lib/types';
import { Badge, Button, fmtDate, Ring, Skeleton } from '../ui/kit';
import { Icon } from '../ui/icons';
import { FigureView, OptionBody, QuestionImage, Rich } from '../ui/content';
import { doBackup } from './data';

type Filter = 'all' | 'wrong' | 'flagged' | 'slow' | 'unsure';

export function Results({ id }: { id: string }) {
  const settings = useStore(settingsStore);
  const [data, setData] = useState<{ s: SessionSummary; d: SessionDetail; q: Map<string, Question>; history: SessionSummary[]; completed: number } | null | 'missing'>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    void (async () => {
      const [s, d] = await Promise.all([store.getSession(id), store.getDetail(id)]);
      if (!s || !d) return setData('missing');
      if (s.status === 'active' || s.status === 'saved') return navigate(href.session(id), true);
      const [q, history, all] = await Promise.all([loadSessionQuestions(d), store.getSessions(s.packId), store.getAllSessions()]);
      setData({ s, d, q, history, completed: all.filter((x) => x.status === 'submitted' || x.status === 'auto-submitted').length });
      window.scrollTo(0, 0);
    })();
  }, [id]);

  const derived = useMemo(() => {
    if (!data || data === 'missing') return null;
    const g = gradeSession(data.d.answers, (qid) => keyAt(data.d, data.q, qid), data.s.status === 'auto-submitted');
    const times = data.d.answers.filter((a) => a.choice !== null).map((a) => a.timeMs);
    const med = median(times);
    let rushed: RushedReport | null = null;
    if (settings.rushedAlert && data.s.mode === 'exam' && !data.s.partial && data.s.type !== 'drill') rushed = detectRushed({ current: data.s, items: g.items, history: data.history });
    return { g, med, rushed };
  }, [data, settings.rushedAlert]);

  if (data === 'missing')
    return (
      <main class="page" style={{ paddingTop: '96px' }}>
        <h1>Results not found</h1>
        <div style={{ marginTop: '24px' }}><Button variant="primary" onClick={() => navigate(href.library())}>Go to library</Button></div>
      </main>
    );
  if (!data || !derived)
    return (
      <main class="page" aria-busy="true">
        <div class="score-hero"><Skeleton h={160} /></div>
      </main>
    );

  const { s, d, q } = data;
  const score = s.total ? s.correct / s.total : 0;
  const acc = s.answered ? s.correct / s.answered : 0;
  const keyOf = (qid: string) => keyAt(d, q, qid);
  const items = d.answers.map((a, i) => ({ a, i, q: q.get(a.qid) }));
  const slowCut = Math.max(derived.med * 1.5, 1);
  const shown = items.filter(({ a }) => {
    const k = keyOf(a.qid);
    if (filter === 'wrong') return a.choice !== null && a.choice !== k;
    if (filter === 'flagged') return a.flagged;
    if (filter === 'unsure') return a.unsure;
    if (filter === 'slow') return a.choice !== null && a.timeMs >= slowCut;
    return true;
  });
  const wrong = items.filter(({ a }) => a.choice !== null && a.choice !== keyOf(a.qid)).length;
  const r = derived.rushed;
  const remind = settings.backupReminder && data.completed - settings.lastBackupAtCount >= settings.backupEvery;

  return (
    <main class="page" id="main">
      <section class="score-hero">
        <Ring value={score} size={168} stroke={12} label={`Paper score ${Math.round(score * 100)}%`} />
        <div class="stack-s">
          <span class="label">{s.type === 'paper' ? 'Paper' : s.type === 'random' ? 'Random session' : 'Mistakes drill'} · {s.mode === 'exam' ? 'Exam' : 'Practice'} · {fmtDate(s.endedAt)}</span>
          <h1 class="display" style={{ overflowWrap: 'anywhere' }}>{s.title}</h1>
          <div class="row" style={{ gap: 'var(--space-5)' }}>
            <span><b class="num" style={{ fontSize: '24px' }}>{s.correct}/{s.total}</b> <span class="muted">paper score</span></span>
            <span><b class="num" style={{ fontSize: '24px' }}>{Math.round(acc * 100)}%</b> <span class="muted">accuracy on {s.answered} answered</span></span>
            <span><b class="num" style={{ fontSize: '24px' }}>{formatClock(s.timeMs)}</b> <span class="muted">time</span></span>
          </div>
          <div class="row">
            {s.partial && <Badge status="warn">Partial: {s.total - s.answered} unanswered not graded</Badge>}
            {s.status === 'auto-submitted' && <Badge status="warn">Submitted at time zero</Badge>}
            {!s.partial && s.mode === 'exam' && s.type !== 'drill' && <Badge status="ok">Counts toward your trend</Badge>}
          </div>
        </div>
      </section>

      {remind && (
        <div class="notice" style={{ marginBottom: 'var(--space-5)' }}>
          <Icon name="save" />
          <div class="row" style={{ justifyContent: 'space-between' }}>
            <span>You have completed {data.completed} sessions. Back up your progress so a cleared browser cannot erase it.</span>
            <div class="row">
              <Button variant="ghost" onClick={() => void updateSettings({ lastBackupAtCount: data.completed })}>Later</Button>
              <Button onClick={() => void doBackup('everything')}><Icon name="download" size={18} /> Back up now</Button>
            </div>
          </div>
        </div>
      )}

      {r?.triggered && (
        <section class="alert" aria-labelledby="rushed-h" style={{ marginBottom: 'var(--space-6)' }}>
          <div class="row">
            <Badge status="warn">Pace check</Badge>
          </div>
          <h2 id="rushed-h">You may be going too fast</h2>
          <p class="muted prose">This paper was quicker than usual and scored lower than your typical result. It may be worth slowing down a little next time. Based on your last {r.baselineCount} completed exam sessions.</p>
          <div class="alert-stats">
            <Stat label="Per question" value={`${r.secLessPerQ.toFixed(0)} s`} ctx="less than your median" />
            <Stat label="On the paper" value={`${r.minLessOnPaper.toFixed(1)} min`} ctx="less than your median" />
            <Stat label="Your typical pace" value={`${r.trimmedMeanT.toFixed(0)} s/q`} ctx={r.baselineCount >= 5 ? 'trimmed mean' : 'mean'} />
            <Stat label="Finishing time" value={formatClock(r.finishMs)} ctx={`median ${formatClock(r.medianT * 1000 * s.total)}`} />
            <Stat label="Accuracy drop" value={`${r.dropQuestions.toFixed(1)} Q`} ctx={`${r.dropPoints.toFixed(1)} points below median`} />
          </div>
          {r.rushedErrors.length > 0 && (
            <div class="stack-s">
              <div class="label">Rushed errors (wrong, under half your usual time)</div>
              <div class="chips">
                {r.rushedErrors.map((e) => (
                  <a class="chip" href={`#q-${e.index}`} key={e.qid} onClick={() => setFilter('all')}>
                    Q{e.index + 1} · {Math.round(e.timeMs / 1000)} s
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <div class="row" style={{ marginBottom: 'var(--space-5)' }}>
        <Button variant="primary" onClick={() => navigate(href.pack(s.packId))}>
          <Icon name="left" size={18} /> Back to pack
        </Button>
        {wrong > 0 && (
          <Button onClick={() => navigate(href.pack(s.packId, 'start'))}>
            <Icon name="target" size={18} /> Drill mistakes
          </Button>
        )}
      </div>

      <section aria-labelledby="review-h">
        <div class="section-head">
          <h2 id="review-h">Review</h2>
          <div class="chips" role="group" aria-label="Filter questions">
            {(
              [
                ['all', `All ${items.length}`],
                ['wrong', `Wrong ${wrong}`],
                ['flagged', `Flagged ${items.filter((x) => x.a.flagged).length}`],
                ['slow', 'Slow'],
                ['unsure', `Unsure ${items.filter((x) => x.a.unsure).length}`],
              ] as [Filter, string][]
            ).map(([f, l]) => (
              <button type="button" class="chip" aria-pressed={filter === f} onClick={() => setFilter(f)} key={f}>
                {l}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 && <p class="muted">Nothing here.</p>}
        {shown.map(({ a, i, q: qq }) => {
          const k = keyOf(a.qid);
          const status = a.choice === null ? 'neutral' : a.choice === k ? 'ok' : 'bad';
          return (
            <article class="review-item" id={`q-${i}`} key={a.qid}>
              <div class="row" style={{ gap: 'var(--space-3)' }}>
                <b class="num" style={{ color: 'var(--ink)' }}>Q{i + 1}</b>
                <Badge status={status}>{a.choice === null ? 'Not answered' : a.choice === k ? 'Correct' : 'Wrong'}</Badge>
                <span>Your answer <b class="num">{a.choice === null ? '—' : LETTERS[a.choice]}</b></span>
                <span>Key <b class="num">{k === null ? '—' : LETTERS[k]}</b></span>
                <span class="num">{Math.round(a.timeMs / 1000)} s</span>
                {a.changes > 0 && <span>changed {a.changes}×</span>}
                {a.flagged && <Badge status="ink">Flagged</Badge>}
                {a.unsure && <Badge status="warn">Unsure</Badge>}
                {r?.rushedErrors.some((e) => e.qid === a.qid) && <Badge status="warn">Rushed</Badge>}
              </div>
              {qq && (
                <details open={status === 'bad'}>
                  <summary class="small muted" style={{ cursor: 'pointer', minHeight: '32px' }}>Show question</summary>
                  <div class="stack-s" style={{ marginTop: 'var(--space-3)' }}>
                    {qq.image && <QuestionImage imageId={qq.image} n={qq.n} />}
                    {qq.stem && <div style={{ maxWidth: '72ch' }}><Rich text={qq.stem} /></div>}
                    {qq.figure && <FigureView figure={qq.figure} />}
                    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '6px' }}>
                      {Array.from({ length: qq.optionCount }, (_, oi) => (
                        <li key={oi} style={{ display: 'flex', gap: '12px', alignItems: 'baseline', padding: '6px 10px', borderRadius: '10px', border: `1px solid ${oi === k ? 'var(--status-ok)' : oi === a.choice ? 'var(--status-bad)' : 'var(--line)'}` }}>
                          <b class="num">{LETTERS[oi]}</b>
                          <span style={{ flex: 1 }}><OptionBody q={qq} i={oi} /></span>
                          {oi === k && <Badge status="ok">Key</Badge>}
                          {oi === a.choice && oi !== k && <Badge status="bad">Yours</Badge>}
                        </li>
                      ))}
                    </ol>
                    {qq.explanation && <p class="small"><Rich text={qq.explanation} /></p>}
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}

/** The key the session was graded with (snapshot at submit), falling back to the current key. */
function keyAt(d: SessionDetail, q: Map<string, Question>, qid: string): number | null {
  const i = d.questionIds.indexOf(qid);
  if (d.key && i >= 0 && d.key[i] !== undefined) return d.key[i] ?? null;
  return q.get(qid)?.answer ?? null;
}

function Stat({ label, value, ctx }: { label: string; value: string; ctx: string }) {
  return (
    <div class="jy-stat">
      <span class="label">{label}</span>
      <span class="num" style={{ fontSize: '24px', lineHeight: '32px', fontWeight: 500 }}>{value}</span>
      <span class="ctx">{ctx}</span>
    </div>
  );
}
