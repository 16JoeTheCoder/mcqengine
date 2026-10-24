import { useEffect, useState } from 'preact/hooks';
import type { Analytics } from '../lib/stats/dashboard';
import { trend } from '../lib/stats/dashboard';
import { paperScore, secPerQ } from '../lib/stats/core';
import { fmtMinSec } from '../lib/stats/kpi';
import * as store from '../lib/data/db';
import type { Pack, Paper, QuestionStat, SessionSummary } from '../lib/types';
import { TIME_BINS } from '../lib/types';
import { ActivityHeatmap, Bars, LineChart, QuestionHeat } from '../ui/charts';
import { fmtDate, pct } from '../ui/kit';

type Tab = 'trend' | 'pace' | 'papers' | 'questions' | 'calibration';

export function Insights({ pack, a, sessions, stats, calibration }: { pack: Pack; a: Analytics; sessions: SessionSummary[]; stats: QuestionStat[]; calibration: boolean }) {
  const tabs: [Tab, string][] = [
    ['trend', 'Trend'],
    ['pace', 'Pace'],
    ['papers', 'Papers'],
    ['questions', 'Questions'],
    ...(calibration ? ([['calibration', 'Calibration']] as [Tab, string][]) : []),
  ];
  const [tab, setTab] = useState<Tab>('trend');
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex(([t]) => t === tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]![0];
      setTab(next);
      requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
    }
  };
  return (
    <div>
      <div class="tabs" role="tablist" aria-label="Insights" onKeyDown={onKey}>
        {tabs.map(([t, l]) => (
          <button role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls={`panel-${t}`} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)} key={t}>
            {l}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'trend' && <TrendTab a={a} />}
        {tab === 'pace' && <PaceTab a={a} />}
        {tab === 'papers' && <PapersTab a={a} />}
        {tab === 'questions' && <QuestionsTab pack={pack} a={a} stats={stats} />}
        {tab === 'calibration' && <CalibrationTab a={a} />}
      </div>
      <p class="small subtle" style={{ marginTop: 'var(--space-4)' }}>
        {sessions.length} session{sessions.length === 1 ? '' : 's'} stored for this pack. Charts use qualifying sessions unless stated.
      </p>
    </div>
  );
}

function TrendTab({ a }: { a: Analytics }) {
  const t = a.q.length >= 3 ? trend(a.q, 'score') : null;
  const recent = a.q.slice(-8).reverse();
  return (
    <div class="stack" style={{ gap: 'var(--space-5)' }}>
      <div class="jy-panel">
        <h3 style={{ marginBottom: 'var(--space-3)' }}>Paper score, true scale</h3>
        <div style={{ height: '300px' }}>
          {t ? (
            <LineChart label="Paper score trend, 0 to 100%" series={[{ label: 'session', kind: 'raw', points: t.raw }, { label: 'avg of 3', kind: 'main', points: t.rolling }]} band={t.band} yFormat={(x) => `${Math.round(x * 100)}`} xLabel="session (n)" yLabel="score (%)" trueScale height={300} />
          ) : (
            <div class="locked"><b>Complete 3 sessions to unlock your trend</b></div>
          )}
        </div>
        <p class="chart-sentence">On the full 0 to 100% scale, small changes look as small as they are.</p>
      </div>
      <div class="grid-even">
        <div class="jy-panel">
          <h3 style={{ marginBottom: 'var(--space-3)' }}>Activity</h3>
          <ActivityHeatmap days={a.activity} label="Sessions per day, last 18 weeks" />
          <p class="chart-sentence">Sessions per day over the last 18 weeks. Darker means more.</p>
        </div>
        <div class="jy-panel">
          <h3 style={{ marginBottom: 'var(--space-3)' }}>Recent sessions</h3>
          {recent.length ? (
            <div class="table-wrap">
              <table class="jy-table">
                <thead><tr><th>Date</th><th>Session</th><th class="n">Score</th><th class="n">s/q</th></tr></thead>
                <tbody>
                  {recent.map((s) => (
                    <tr key={s.id}>
                      <td class="num">{fmtDate(s.endedAt)}</td>
                      <td><a href={`#/results/${s.id}`}>{s.title}</a></td>
                      <td class="n">{pct(paperScore(s))}%</td>
                      <td class="n">{Math.round(secPerQ(s))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="small muted">No qualifying sessions yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PaceTab({ a }: { a: Analytics }) {
  const vsBudget = a.q.slice(-12).map((s, i) => ({ label: `${a.q.length - Math.min(12, a.q.length) + i + 1}`, value: secPerQ(s) }));
  const binLabels = [...TIME_BINS.map((b, i) => `${i ? TIME_BINS[i - 1] : 0}–${b}`), `${TIME_BINS[TIME_BINS.length - 1]}+`];
  const slow = a.slowVsRest.slow.acc;
  const rest = a.slowVsRest.rest.acc;
  return (
    <div class="stack" style={{ gap: 'var(--space-5)' }}>
      <div class="grid-even">
        <div class="jy-panel">
          <h3 style={{ marginBottom: 'var(--space-3)' }}>Time per question vs budget</h3>
          {vsBudget.length ? (
            <>
              <Bars label="Seconds per question by session" bars={vsBudget} yMax={Math.max(a.budget, ...vsBudget.map((b) => b.value)) * 1.1} format={(x) => `${Math.round(x)}`} height={200} xLabel="session (n)" highlight={vsBudget.length - 1} />
              <p class="chart-sentence">Budget is {fmtMinSec(a.budget)} per question ({Math.round(a.budget)} s). {vsBudget[vsBudget.length - 1]!.value > a.budget ? 'Your latest session ran over budget.' : 'Your latest session was within budget.'}</p>
            </>
          ) : (
            <p class="small muted">No qualifying sessions yet.</p>
          )}
        </div>
        <div class="jy-panel">
          <h3 style={{ marginBottom: 'var(--space-3)' }}>Time per question</h3>
          {a.hist.some((x) => x > 0) ? (
            <>
              <Bars label="Histogram of seconds per question" bars={a.hist.map((v, i) => ({ label: binLabels[i]!, value: v }))} format={(x) => `${Math.round(x)}`} height={200} xLabel="time per question (s)" />
              <p class="chart-sentence">How long you spend on each question across qualifying sessions.</p>
            </>
          ) : (
            <p class="small muted">No data yet.</p>
          )}
        </div>
      </div>
      <div class="grid-even">
        <div class="jy-panel">
          <h3 style={{ marginBottom: 'var(--space-3)' }}>Accuracy by third</h3>
          <Bars label="Accuracy by third of the paper" bars={a.thirds.map((x, i) => ({ label: ['First', 'Middle', 'Last'][i]!, value: x.acc }))} yMax={1} format={(x) => `${Math.round(x * 100)}%`} height={200} />
        </div>
        <div class="jy-panel stack-s">
          <h3>Are your slowest questions the wrong ones?</h3>
          {slow !== null && rest !== null ? (
            <>
              <Bars label="Accuracy on slowest quarter vs the rest" bars={[{ label: 'Slowest 25%', value: slow }, { label: 'The rest', value: rest }]} yMax={1} format={(x) => `${Math.round(x * 100)}%`} height={170} highlight={0} />
              <p class="chart-sentence">
                {slow < rest - 0.1
                  ? `Yes: ${Math.round((rest - slow) * 100)} points lower on your slowest questions. Consider moving on sooner and coming back.`
                  : 'No strong link: your slow questions are about as accurate as the rest.'}
              </p>
            </>
          ) : (
            <p class="small muted">No data yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PapersTab({ a }: { a: Analytics }) {
  const rows = a.ladder.filter((r) => r.attempts > 0);
  if (!rows.length) return <p class="muted">Complete a full paper to see its ladder of first, latest and best scores.</p>;
  return (
    <div class="jy-panel jy-panel--flush table-wrap">
      <table class="jy-table">
        <thead>
          <tr><th>Paper</th><th class="n">Attempts</th><th class="n">First</th><th class="n">Latest</th><th class="n">Best</th><th class="n">Change</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ch = r.latest !== null && r.first !== null ? r.latest - r.first : null;
            return (
              <tr key={r.paper.id}>
                <td>{r.paper.title}<div class="small subtle">{r.paper.group.join(' › ')}</div></td>
                <td class="n">{r.attempts}</td>
                <td class="n">{pct(r.first)}%</td>
                <td class="n">{pct(r.latest)}%</td>
                <td class="n">{pct(r.best)}%</td>
                <td class="n" style={{ color: ch === null || Math.abs(ch) < 0.005 ? undefined : ch > 0 ? 'var(--status-ok)' : 'var(--status-bad)' }}>
                  {ch === null || r.attempts < 2 ? '—' : `${ch > 0 ? '+' : ''}${Math.round(ch * 100)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QuestionsTab({ pack, a, stats }: { pack: Pack; a: Analytics; stats: QuestionStat[] }) {
  const [paperId, setPaperId] = useState(pack.papers[0]?.id ?? '');
  const [paper, setPaper] = useState<Paper | null>(null);
  useEffect(() => {
    if (!paperId) return;
    void store.getPaper(`${pack.id}::${paperId}`).then((p) => setPaper(p ?? null));
  }, [paperId, pack.id]);
  const byQ = new Map(stats.map((s) => [s.qid, s] as const));
  const total = a.changes.helped + a.changes.hurt + a.changes.neutral;
  return (
    <div class="stack" style={{ gap: 'var(--space-5)' }}>
      <div class="jy-panel stack-s">
        <div class="panel-head" style={{ marginBottom: 0 }}>
          <h3>Question heat grid</h3>
          <label class="sr-only" for="heat-paper">Paper</label>
          <select id="heat-paper" class="select" style={{ width: 'auto', maxWidth: '100%' }} value={paperId} onChange={(e) => setPaperId((e.target as HTMLSelectElement).value)}>
            {pack.papers.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </div>
        {paper ? (
          <QuestionHeat
            label={`Wrong-answer rate per question for ${paper.title}`}
            cells={paper.questions.map((q) => {
              const s = byQ.get(q.id);
              return { id: q.id, label: `Q${q.n}`, wrong: s?.missed ?? 0, attempts: s?.attempts ?? 0 };
            })}
          />
        ) : (
          <p class="small muted">Choose a paper.</p>
        )}
        <p class="chart-sentence">Darker cells were answered wrong more often. Dashed cells have not been attempted.</p>
      </div>
      <div class="grid-even">
        <div class="jy-panel">
          <h3 style={{ marginBottom: 'var(--space-3)' }}>Mistakes bank over time</h3>
          <div style={{ height: '220px' }}>
            {a.bankSeries.length >= 2 ? (
              <LineChart label="Mistakes bank size over time" series={[{ label: 'bank', kind: 'main', points: a.bankSeries }]} yFormat={(x) => `${Math.round(x)}`} xLabel="day" yLabel="questions (n)" yMax={Math.max(4, ...a.bankSeries.map((p) => p.y)) * 1.1} height={220} />
            ) : (
              <div class="locked"><span class="small">Appears once questions enter and leave the bank.</span></div>
            )}
          </div>
          <p class="chart-sentence">Now {a.bankSize} question{a.bankSize === 1 ? '' : 's'}. Each leaves after two correct, sure answers in a row.</p>
        </div>
        <div class="jy-panel stack-s">
          <h3>Changing answers</h3>
          {total ? (
            <>
              <Bars label="Outcome of answer changes" bars={[{ label: 'Helped', value: a.changes.helped }, { label: 'Hurt', value: a.changes.hurt }, { label: 'No effect', value: a.changes.neutral }]} format={(x) => `${Math.round(x)}`} height={170} highlight={a.changes.hurt > a.changes.helped ? 1 : 0} />
              <p class="chart-sentence">
                {a.changes.helped > a.changes.hurt
                  ? `Changing your answer helped ${a.changes.helped} times and hurt ${a.changes.hurt}. Your second thoughts are usually right.`
                  : a.changes.hurt > a.changes.helped
                    ? `Changing your answer hurt ${a.changes.hurt} times and helped ${a.changes.helped}. Trust your first answer unless you find a clear error.`
                    : 'Changing answers has helped and hurt equally so far.'}
              </p>
            </>
          ) : (
            <p class="small muted">No changed answers recorded yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function CalibrationTab({ a }: { a: Analytics }) {
  const { sure, unsure } = a.calibration;
  return (
    <div class="grid-even">
      <div class="jy-panel">
        <h3 style={{ marginBottom: 'var(--space-3)' }}>Accuracy when sure vs unsure</h3>
        {sure.n + unsure.n ? (
          <>
            <Bars label="Accuracy by confidence" bars={[{ label: `Sure (${sure.n})`, value: sure.acc }, { label: `Unsure (${unsure.n})`, value: unsure.acc }]} yMax={1} format={(x) => `${Math.round(x * 100)}%`} height={200} highlight={0} />
            <p class="chart-sentence">
              {sure.acc !== null && unsure.acc !== null
                ? sure.acc > unsure.acc + 0.1
                  ? 'Well calibrated: you are noticeably more accurate when sure. Use Unsure honestly; those questions feed your drills.'
                  : 'Your Unsure answers are nearly as accurate as your sure ones. You may know more than you think.'
                : 'Mark questions Unsure during sessions to see this.'}
            </p>
          </>
        ) : (
          <p class="small muted">No answers yet.</p>
        )}
      </div>
      <div class="jy-panel prose small stack-s">
        <h3>Why this matters</h3>
        <p>Correct answers you marked Unsure are shaky: they go into your mistakes bank until you get them right, and sure, twice in a row.</p>
        <p>Calibration uses every finished session, including practice and drills.</p>
      </div>
    </div>
  );
}
