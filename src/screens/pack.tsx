import { useEffect, useMemo, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { exportPackZip } from '../lib/data/backup';
import { downloadBlob } from '../lib/data/files';
import { paperComplete } from '../lib/format/merge';
import { dailyPlan, loadPackContent, packStandardLength, submitSession } from '../lib/engine/session';
import { startDaily } from './daily';
import { selectDrill } from '../lib/engine/mistakes';
import { packAnalytics, trend, type Filters, type Metric, type Range } from '../lib/stats/dashboard';
import { bump, dataVersion, href, navigate, settingsStore, toast, updateSettings, useStore } from '../lib/app-state';
import { broadcastChange, sessionLockHeld } from '../lib/tablock';
import type { BankEvent, Pack, PaperMeta, Question, QuestionOverride, QuestionStat, SessionSummary } from '../lib/types';
import { Badge, Button, CountUp, fmtDate, fmtInt, Modal, Popover, Ring, Seg, Skeleton } from '../ui/kit';
import { Icon } from '../ui/icons';
import { Bars, LineChart, Scatter } from '../ui/charts';
import { StartDialog, type StartRequest } from './start';
import { PapersBrowser } from './papers';
import { lazy } from '../ui/lazy';

const Insights = lazy(() => import('./insights').then((m) => m.Insights), <div class="skel" style={{ height: '400px' }} />);
import { BackupPanel } from './data';
import { FixQuestion } from './fix';

const SECTIONS = [
  ['overview', 'Overview'],
  ['start', 'Start'],
  ['papers', 'Papers'],
  ['insights', 'Insights'],
  ['data', 'Data'],
] as const;

interface PackData {
  pack: Pack;
  sessions: SessionSummary[];
  stats: QuestionStat[];
  events: BankEvent[];
  overrides: QuestionOverride[];
}

export function PackScreen({ id, section, onImport, onPrompt }: { id: string; section?: string; onImport: (p: Pack) => void; onPrompt: (p: Pack) => void }) {
  const v = useStore(dataVersion);
  const settings = useStore(settingsStore);
  const [data, setData] = useState<PackData | null | 'missing'>(null);
  const [start, setStart] = useState<StartRequest | null>(null);
  const [metric, setMetric] = useState<Metric>('score');
  const [range, setRange] = useState<Range>('all');
  const [trueScale, setTrueScale] = useState(false);
  const [includePractice, setIncludePractice] = useState(false);
  const [active, setActive] = useState('overview');
  const [tipHidden, setTipHidden] = useState(false);
  const [lockElsewhere, setLockElsewhere] = useState(false);
  const [daily, setDaily] = useState<{ due: number; size: number } | null>(null);
  useEffect(() => {
    void sessionLockHeld().then(setLockElsewhere);
  }, [v]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const pack = await store.getPack(id);
      if (!pack) return live && setData('missing');
      const [sessions, stats, events, overrides] = await Promise.all([store.getSessions(id), store.getStats(id), store.getBankEvents(id), store.getOverrides(id)]);
      if (live) setData({ pack, sessions, stats, events, overrides });
      const plan = await dailyPlan(pack);
      if (live) setDaily(plan);
    })();
    return () => {
      live = false;
    };
  }, [id, v]);

  // Scroll spy.
  useEffect(() => {
    if (!data || data === 'missing') return;
    const els = SECTIONS.map(([s]) => document.getElementById(s)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.id);
      },
      { rootMargin: '-120px 0px -55% 0px' },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [data]);

  useEffect(() => {
    if (section && data && data !== 'missing') requestAnimationFrame(() => goSection(section));
  }, [section, data !== null]);

  const filters: Filters = { includePractice, includePartial: settings.includePartialInTrend, range, group: '' };
  const a = useMemo(() => (data && data !== 'missing' ? packAnalytics(data.pack, data.sessions, data.stats, data.events, filters, Date.now(), settings.projection ? settings.examDate : undefined) : null), [data, includePractice, range, settings.includePartialInTrend, settings.projection, settings.examDate]);

  if (data === 'missing')
    return (
      <main class="page" style={{ paddingTop: '96px' }}>
        <h1>Pack not found</h1>
        <p class="muted" style={{ margin: '12px 0 24px' }}>It may have been deleted on this device.</p>
        <Button variant="primary" onClick={() => navigate(href.library())}>Go to library</Button>
      </main>
    );
  if (!data || !a)
    return (
      <main class="page" aria-busy="true">
        <div class="pack-hero"><Skeleton h={96} /></div>
        <div class="kpis"><Skeleton h={150} /><Skeleton h={150} /><Skeleton h={150} /><Skeleton h={150} /></div>
      </main>
    );

  const { pack, sessions, stats } = data;
  const open = sessions.filter((s) => s.status === 'saved' || s.status === 'active');
  const saved = open[0];
  const elsewhere = saved?.status === 'active' && lockElsewhere;
  const inProgress = new Set(open.map((s) => s.paperId).filter(Boolean) as string[]);
  const questions = pack.papers.reduce((x, p) => x + p.present, 0);
  const std = packStandardLength(pack);
  const randomSize = Math.min(std, a.coverage.keyedTotal);
  const drillSize = Math.min(std, selectDrill(stats, std, new Set(stats.map((s) => s.qid))).length);
  const allPapersDone = a.coverage.papersDone >= pack.papers.filter(paperComplete).length && pack.papers.length > 0;
  const showTip = !allPapersDone && !tipHidden && !settings.dismissedTips.includes(`random:${pack.id}`);
  const examDays = settings.examDate ? Math.ceil((Date.parse(settings.examDate) - Date.now()) / 86_400_000) : null;
  const qCount = a.q.length;

  const pick = (p: PaperMeta) => {
    if (!paperComplete(p)) {
      toast(`This paper has ${p.present} of ${p.questionCount} questions. Import the rest to start it.`);
      return;
    }
    setStart({ type: 'paper', paper: p });
  };

  const resolveSaved = async (action: 'resume' | 'submit' | 'discard') => {
    if (!saved) return;
    if (await sessionLockHeld()) {
      toast(action === 'resume' ? 'This session is open in another tab.' : 'A session is running in another tab. Finish it there first.');
      return;
    }
    if (action === 'resume') return navigate(href.session(saved.id));
    if (action === 'submit') {
      const r = await submitSession(saved.id, false);
      bump();
      broadcastChange();
      return navigate(href.results(r?.summary.id ?? saved.id));
    }
    if (confirm('Discard the saved session? Its answers will be lost.')) {
      await store.deleteSession(saved.id);
      bump();
      broadcastChange();
      toast('Saved session discarded.');
    }
  };

  const t = qCount >= 3 ? trend(a.q, metric) : null;
  const fmt = metric === 'pace' ? (x: number) => `${Math.round(x)}` : (x: number) => `${Math.round(x * 100)}`;
  const verdict = a.verdict;

  return (
    <>
      <nav class="secnav" aria-label="Pack sections">
        <div class="page">
          <ul>
            {SECTIONS.map(([s, l]) => (
              <li key={s}>
                <a href={`#${s}`} aria-current={active === s ? 'true' : undefined} onClick={(e) => { e.preventDefault(); goSection(s); }}>
                  {l}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <main class="page" id="main" tabIndex={-1}>
        <section id="overview" aria-label="Overview">
          <div class="pack-hero">
            <div class="stack-s">
              <span class="label">{pack.subject || 'Pack'}</span>
              <h1 class="display" style={{ overflowWrap: 'anywhere' }}>{pack.title}</h1>
              <div class="facts">
                <span><b class="num">{fmtInt(pack.papers.length)}</b> paper{pack.papers.length === 1 ? '' : 's'}</span>
                <span><b class="num">{fmtInt(questions)}</b> question{questions === 1 ? '' : 's'}</span>
                <span><b class="num">{a.coverage.papersDone}</b> done</span>
                {examDays !== null && examDays >= 0 && (
                  <span>
                    Exam in <b class="num">{examDays}</b> day{examDays === 1 ? '' : 's'} ({settings.examDate})
                  </span>
                )}
              </div>
            </div>
            <div class="row">
              <Button size="lg" onClick={() => onPrompt(pack)}>
                <Icon name="plus" size={18} /> Add papers
              </Button>
              <Button variant="accent" size="lg" onClick={() => goSection('start')}>
                <Icon name="play" size={16} /> Start session
              </Button>
            </div>
          </div>
          {saved && (
            <div class="notice" style={{ marginBottom: 'var(--space-4)' }}>
              <Icon name="clock" />
              <div class="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b>Saved session:</b> {saved.title} · <span class="num">{saved.answered}</span> of <span class="num">{saved.total}</span> answered
                </div>
                {elsewhere ? (
                  <span class="small muted">Running in another tab. Finish it there.</span>
                ) : (
                  <div class="row">
                    <Button variant="ghost" onClick={() => resolveSaved('discard')}>Discard</Button>
                    <Button onClick={() => resolveSaved('submit')}>Submit now</Button>
                    <Button variant="primary" onClick={() => resolveSaved('resume')}>Resume</Button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div class="kpis">
            <KpiTile label="Sessions done" k={a.kpis.sessions} format={(x) => `${Math.round(x)}`} deltaFmt={(d) => `${Math.abs(d)} vs previous 30 days`} />
            <KpiTile label="Paper score" k={a.kpis.score} format={(x) => (x * 100).toFixed(0)} unit="%" deltaFmt={(d) => `${Math.abs(d * 100).toFixed(1)} pts vs prior window`} />
            <KpiTile label="Pace" k={a.kpis.pace} format={(x) => `${Math.round(x)}`} unit="s/q" deltaFmt={(d) => `${Math.abs(d).toFixed(1)} s vs prior window`} />
            <KpiTile label="Mistakes bank" k={a.kpis.bank} format={(x) => `${Math.round(x)}`} deltaFmt={(d) => `${Math.abs(d)} vs a week ago`} />
          </div>

          <div class="grid-2" style={{ marginTop: 'var(--space-4)' }}>
            <div class="jy-panel">
              <div class="panel-head">
                <h3>Trend</h3>
                <Seg label="Metric" value={metric} onChange={setMetric} options={[{ value: 'score', label: 'Score' }, { value: 'pace', label: 'Pace' }, { value: 'accuracy', label: 'Accuracy' }]} />
              </div>
              <div class="row" style={{ marginBottom: 'var(--space-3)' }}>
                <div class="chips" role="group" aria-label="Range">
                  {(['all', '30d', '10'] as Range[]).map((r) => (
                    <button type="button" class="chip" aria-pressed={range === r} onClick={() => setRange(r)} key={r}>
                      {r === 'all' ? 'All' : r === '30d' ? '30 days' : 'Last 10'}
                    </button>
                  ))}
                </div>
                <span class="spacer" />
                <label class="check small">
                  <input type="checkbox" checked={includePractice} onChange={(e) => setIncludePractice((e.target as HTMLInputElement).checked)} /> Include practice
                </label>
                <label class="check small">
                  <input type="checkbox" checked={settings.includePartialInTrend} onChange={(e) => void updateSettings({ includePartialInTrend: (e.target as HTMLInputElement).checked })} /> Include partial
                </label>
                {metric !== 'pace' && (
                  <label class="check small">
                    <input type="checkbox" checked={trueScale} onChange={(e) => setTrueScale((e.target as HTMLInputElement).checked)} /> True scale
                  </label>
                )}
              </div>
              <div style={{ height: '260px' }}>
                {t ? (
                  <LineChart
                    label={`${metric} trend over ${qCount} sessions`}
                    series={[
                      { label: 'session', kind: 'raw', points: t.raw },
                      { label: 'avg of 3', kind: 'main', points: t.rolling },
                    ]}
                    band={t.band}
                    yFormat={fmt}
                    xLabel="session (n)"
                    yLabel={metric === 'pace' ? 'pace (s per question)' : `${metric} (%)`}
                    trueScale={metric !== 'pace' && trueScale}
                    yMax={metric === 'pace' ? Math.max(...t.raw.map((p) => p.y)) * 1.2 : 1}
                  />
                ) : (
                  <div class="locked">
                    <Icon name="target" size={28} />
                    <b>Complete 3 sessions to unlock your trend</b>
                    <span class="small">{3 - qCount} more qualifying exam session{3 - qCount === 1 ? '' : 's'} (full paper or random) to go.</span>
                  </div>
                )}
              </div>
              <p class="chart-sentence">
                {t
                  ? `Each dot is one qualifying session; the line is the average of the last three, with a shaded band for typical noise. ${metric === 'pace' ? 'Lower is faster.' : ''}`
                  : 'Practice sessions, drills and partial submissions do not count toward the trend.'}
              </p>
            </div>
            <div class="jy-panel stack">
              <div class="panel-head" style={{ marginBottom: 0 }}>
                <h3>Verdict</h3>
                <Popover label="How is this calculated?">
                  <p>The verdict compares the average paper score of your latest qualifying sessions with the same number before them (up to 3 each), and checks the straight-line slope over your last 10.</p>
                  <p>Small samples are noisy. With fewer than 6 sessions, noise is estimated from the binomial formula: the standard error of one session is √(p(1 − p) / N) for N questions. With 6 or more, it is the actual scatter of your scores around their trend line.</p>
                  <p>The standard error of a k-session average is that divided by √k, and of the difference between two averages, that times √2. A change of at least 2 standard errors is high confidence, at least 1 is medium, and less is within noise.</p>
                  <p>A verdict needs at least 4 qualifying sessions: completed full papers or random sessions in Exam mode.</p>
                </Popover>
              </div>
              {verdict.state === 'locked' ? (
                <div class="locked" style={{ minHeight: '160px' }}>
                  <b>{verdict.needed} more session{verdict.needed === 1 ? '' : 's'} for a verdict</b>
                  <span class="small">A verdict needs 4 qualifying sessions so noise is not mistaken for progress.</span>
                </div>
              ) : (
                <>
                  <div>
                    <div class="verdict-word">{verdict.label}</div>
                    <Badge status={verdict.confidence === 'High' ? 'ok' : verdict.confidence === 'Medium' ? 'ink' : 'neutral'}>{verdict.confidence} confidence</Badge>
                  </div>
                  <p class="small">{verdict.sentence}</p>
                </>
              )}
              {settings.projection && settings.examDate && (
                <div class="jy-panel jy-panel--sunken stack-s">
                  <div class="label">Projection for exam day (indicative)</div>
                  {a.projection ? (
                    <>
                      <div style={{ fontSize: '32px', lineHeight: '40px', fontWeight: 300 }}>
                        <span class="num">{Math.round(a.projection.value * 100)}</span>
                        <span class="muted" style={{ fontSize: '18px' }}>%</span>
                      </div>
                      <p class="small muted">
                        Likely range {Math.round(a.projection.lo * 100)}–{Math.round(a.projection.hi * 100)}%. A cautious, damped extrapolation of your trend, not a prediction.
                      </p>
                    </>
                  ) : (
                    <p class="small muted">Needs 5 qualifying sessions before the exam date.</p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div class="grid-3" style={{ marginTop: 'var(--space-4)' }}>
            <div class="jy-panel">
              <h3 style={{ marginBottom: 'var(--space-3)' }}>Pace by thirds</h3>
              {a.thirds.some((x) => x.n > 0) ? (
                <>
                  <Bars label="Accuracy by third of the paper" bars={a.thirds.map((x, i) => ({ label: ['First', 'Middle', 'Last'][i]!, value: x.acc }))} yMax={1} format={(x) => `${Math.round(x * 100)}%`} height={180} highlight={lowestIndex(a.thirds.map((x) => x.acc))} />
                  <p class="chart-sentence">{thirdsSentence(a.thirds.map((x) => x.acc))}</p>
                </>
              ) : (
                <Empty text="Accuracy across the first, middle and last third appears after your first exam session." />
              )}
            </div>
            <div class="jy-panel">
              <h3 style={{ marginBottom: 'var(--space-3)' }}>Speed vs score</h3>
              {a.speedScore.length >= 2 ? (
                <>
                  <Scatter label="Seconds per question against paper score" points={a.speedScore} xLabel="pace (s per question)" yLabel="score (%)" xFormat={(x) => `${Math.round(x)}`} yFormat={(y) => `${Math.round(y * 100)}`} height={180} />
                  <p class="chart-sentence">One dot per session; the orange dot is your latest.</p>
                </>
              ) : (
                <Empty text="Needs two qualifying sessions." />
              )}
            </div>
            <div class="jy-panel">
              <h3 style={{ marginBottom: 'var(--space-3)' }}>Coverage</h3>
              <div class="row" style={{ gap: 'var(--space-5)' }}>
                <Ring value={a.coverage.papers ? a.coverage.papersDone / a.coverage.papers : 0} size={120} stroke={10} text={`${a.coverage.papersDone}/${a.coverage.papers}`} label={`${a.coverage.papersDone} of ${a.coverage.papers} papers done`} />
                <div class="stack-s">
                  <div><b class="num">{a.coverage.papersDone}</b> <span class="muted">of</span> <b class="num">{a.coverage.papers}</b> <span class="muted">papers done</span></div>
                  <div><b class="num">{Math.round(a.coverage.unseen * 100)}%</b> <span class="muted">of the random pool unseen</span></div>
                </div>
              </div>
              <p class="chart-sentence">{a.coverage.papersDone < a.coverage.papers ? 'Finishing every paper once gives the fairest picture of where you stand.' : 'Every paper done at least once. Random and drills keep it fresh.'}</p>
            </div>
          </div>
        </section>

        <section id="start" class="section" aria-labelledby="start-h">
          <h2 id="start-h">Start</h2>
          <div class="start-types">
            <button type="button" class="jy-panel jy-panel--link choice" onClick={() => goSection('papers')}>
              <span class="label">Paper</span>
              <span class="big">Full paper</span>
              <span class="small muted">Pick a paper below. Always the whole paper, in order or shuffled.</span>
            </button>
            <button type="button" class="jy-panel jy-panel--link choice" disabled={!randomSize} onClick={() => setStart({ type: 'random', size: randomSize })}>
              <span class="label">Random</span>
              <span class="big"><span class="num">{Math.round(a.coverage.unseen * 100)}%</span> unseen</span>
              <span class="small muted">{randomSize ? `${randomSize} questions from across the pack, least-seen first. Once all are seen, questions repeat.` : 'Import keyed papers to use Random.'}</span>
            </button>
            <button type="button" class="jy-panel jy-panel--link choice" disabled={!daily?.due} onClick={() => void startDaily(pack)}>
              <span class="label">Daily 10</span>
              <span class="big"><span class="num">{daily?.due ?? 0}</span> due</span>
              <span class="small muted">{daily?.due ? `${daily.size} questions in ten minutes, with instant feedback. Mistakes return after 1, 3, 7 and 14 days.` : 'Nothing due today. Mistakes come back here 1, 3, 7 and 14 days after you last saw them.'}</span>
            </button>
            <button type="button" class="jy-panel jy-panel--link choice" disabled={!drillSize} onClick={() => setStart({ type: 'drill', size: drillSize })}>
              <span class="label">Mistakes drill</span>
              <span class="big"><span class="num">{a.bankSize}</span> in bank</span>
              <span class="small muted">{a.bankSize ? 'Wrong or shaky answers, most-missed first. Two sure, correct answers clear one.' : 'Empty for now. Wrong answers and correct-but-unsure ones land here.'}</span>
            </button>
          </div>
          {showTip && (
            <div class="notice" style={{ marginTop: 'var(--space-4)' }}>
              <Icon name="info" />
              <div class="small">Tip: finish every paper once as a full paper before leaning on Random. It gives your trend a fair baseline. You can still use Random any time.</div>
              <Button variant="ghost" icon onClick={() => { setTipHidden(true); void updateSettings({ dismissedTips: [...settings.dismissedTips, `random:${pack.id}`] }); }} aria-label="Dismiss tip">
                <Icon name="x" size={16} />
              </Button>
            </div>
          )}
        </section>

        <section id="papers" class="section" aria-labelledby="papers-h">
          <div class="section-head">
            <h2 id="papers-h">Papers</h2>
            <Button onClick={() => onImport(pack)}>
              <Icon name="upload" size={18} /> Import
            </Button>
          </div>
          {pack.papers.length ? (
            <PapersBrowser rows={a.ladder} inProgress={inProgress} onPick={pick} />
          ) : (
            <div class="locked" style={{ minHeight: '160px' }}>
              <b>No papers yet</b>
              <Button variant="primary" onClick={() => onPrompt(pack)}>Add papers</Button>
            </div>
          )}
        </section>

        <section id="insights" class="section" aria-labelledby="insights-h">
          <h2 id="insights-h">Insights</h2>
          <Insights pack={pack} a={a} sessions={sessions} stats={stats} calibration={settings.calibration} />
        </section>

        <section id="data" class="section" aria-labelledby="data-h">
          <h2 id="data-h">Data</h2>
          <DataSection data={data} />
        </section>
      </main>
      {start && <StartDialog pack={pack} req={start} blocked={!!saved} onClose={() => setStart(null)} />}
    </>
  );
}

/** Scrolls to a section and moves focus to its heading, so keyboard users land there too. */
function goSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  const h = el.querySelector<HTMLElement>('h2') ?? el;
  h.tabIndex = -1;
  h.focus({ preventScroll: true });
}

function lowestIndex(xs: (number | null)[]): number | undefined {
  let best: number | undefined;
  xs.forEach((x, i) => {
    if (x !== null && (best === undefined || x < (xs[best] as number))) best = i;
  });
  return best;
}
function thirdsSentence(xs: (number | null)[]): string {
  const [f, , l] = xs;
  if (f == null || l == null) return 'Accuracy by position in the paper.';
  const d = (l - f) * 100;
  if (Math.abs(d) < 5) return 'Your accuracy holds steady from start to finish.';
  return d < 0 ? `You drop ${Math.round(-d)} points in the last third. Check pacing near the end.` : `You finish ${Math.round(d)} points stronger than you start. Warm up before the first questions.`;
}

function Empty({ text }: { text: string }) {
  return (
    <div class="locked" style={{ height: '180px' }}>
      <span class="small">{text}</span>
    </div>
  );
}

function KpiTile({ label, k, format, unit, deltaFmt }: { label: string; k: { value: number | null; delta: number | null; good: boolean | null; context: string }; format: (v: number) => string; unit?: string; deltaFmt: (d: number) => string }) {
  return (
    <div class="jy-panel jy-stat">
      <span class="label">{label}</span>
      <span class="value">
        {k.value === null ? '—' : <CountUp value={k.value} format={format} />}
        {k.value !== null && unit && <span class="unit">{unit}</span>}
      </span>
      <span class={`delta ${k.good === null ? 'flat' : k.good ? 'good' : 'bad'}`}>
        {k.delta === null ? (
          <span class="subtle">No comparison yet</span>
        ) : k.delta === 0 ? (
          <>— no change</>
        ) : (
          <>
            <Icon name={k.delta > 0 ? 'up' : 'dn'} size={14} />
            <span class="sr-only">{k.good ? 'Improved' : 'Worse'}:</span> {deltaFmt(k.delta)}
          </>
        )}
      </span>
      <span class="ctx">{k.context}</span>
    </div>
  );
}

function DataSection({ data }: { data: PackData }) {
  const { pack, overrides } = data;
  const [fix, setFix] = useState<{ qid: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState('');
  const reported = overrides.filter((o) => o.reported);
  const needsFig = pack.papers.filter((p) => p.figuresNeeded > 0);
  const [fixQ, setFixQ] = useState<Question | null>(null);

  useEffect(() => {
    if (!fix) return setFixQ(null);
    void loadPackContent(pack.id).then(({ papers }) => {
      for (const p of papers) for (const q of p.questions) if (q.id === fix.qid) setFixQ(q);
    });
  }, [fix, pack.id]);

  const exportPack = async () => {
    try {
      const [papers, ovs, snips] = await Promise.all([store.getPapers(pack.id), store.getOverrides(pack.id), store.getSnips(pack.id)]);
      const { blob, name } = await exportPackZip(pack, papers, ovs, snips);
      downloadBlob(blob, name);
      toast(`Exported ${name}. Anyone can import it into DMC.`);
    } catch (e) {
      toast((e as Error).message || 'Could not export the pack.');
    }
  };
  const del = async () => {
    if (await sessionLockHeld()) {
      toast('A session is running in another tab. Finish it before deleting the pack.');
      return;
    }
    await store.deletePack(pack.id);
    bump();
    broadcastChange();
    toast(`Deleted ${pack.title}.`);
    navigate(href.library());
  };

  return (
    <div class="stack" style={{ gap: 'var(--space-5)' }}>
      <div class="notice">
        <Icon name="info" />
        <div class="small prose">
          Your packs and progress live only in this browser on this device. Clearing site data, private browsing or reinstalling the browser can erase them. Export a full backup regularly and keep it in cloud storage.
        </div>
      </div>
      <div class="grid-even">
        <div class="jy-panel stack-s">
          <h3>Pack for friends</h3>
          {pack.origin?.kind === 'library' ? (
            <p class="small muted">This pack came from the school Library, so it is shared through the Library only. Friends at school can download it there.</p>
          ) : (
            <>
              <p class="small muted">A zip with papers, keys, typed questions, PDFs and snips, with your fixes applied. Never your sessions or progress.</p>
              <div><Button onClick={exportPack}><Icon name="download" size={18} /> Export pack</Button></div>
            </>
          )}
        </div>
        <div class="jy-panel stack-s">
          <h3>Reported questions</h3>
          {reported.length ? (
            <ul class="small" style={{ margin: 0, paddingLeft: '18px' }}>
              {reported.map((o) => (
                <li key={o.key}>
                  <button type="button" class="jy-btn jy-btn--ghost jy-btn--sm" onClick={() => setFix({ qid: o.qid })}>
                    <span class="num">{o.qid}</span>
                  </button>{' '}
                  {o.note ?? 'No note'} <span class="subtle">· {fmtDate(o.updatedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p class="small muted">No reports. Use "Fix this question" during a session to correct or report one.</p>
          )}
          {needsFig.length > 0 && (
            <p class="small"><Badge status="warn">Needs figure</Badge> {needsFig.reduce((x, p) => x + p.figuresNeeded, 0)} questions need a figure: {needsFig.map((p) => `${p.title} (${p.figuresNeeded})`).join(', ')}. Attach them from the question screen.</p>
          )}
        </div>
      </div>
      <div>
        <h3 style={{ marginBottom: 'var(--space-3)' }}>Back up everything</h3>
        <BackupPanel />
      </div>
      <div class="jy-panel stack-s" style={{ borderColor: 'var(--status-bad)' }}>
        <h3>Delete pack</h3>
        <p class="small muted">Removes this pack, its papers and all its progress from this device.</p>
        <div><Button variant="danger" onClick={() => setConfirmDelete(true)}><Icon name="trash" size={18} /> Delete pack</Button></div>
      </div>
      {confirmDelete && (
        <Modal
          title="Delete pack"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button variant="danger" disabled={typed.trim() !== 'DELETE'} onClick={del}>Delete forever</Button>
            </>
          }
        >
          <form class="stack" onSubmit={(e) => { e.preventDefault(); if (typed.trim() === 'DELETE') void del(); }}>
            <p>This deletes <b>{pack.title}</b> and its progress. It cannot be undone unless you have a backup.</p>
            <label class="jy-field">
              <span>Type DELETE to confirm</span>
              <input class="input" value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} autoFocus />
            </label>
          </form>
        </Modal>
      )}
      {fixQ && <FixQuestion packId={pack.id} question={fixQ} onClose={() => setFix(null)} />}
    </div>
  );
}
