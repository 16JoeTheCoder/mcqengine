import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { Countdown, crossedThreshold, formatClock, sanitizeTimer } from '../lib/engine/timer';
import { loadSessionQuestions, submitSession } from '../lib/engine/session';
import { acquireSessionLock, broadcastChange, finalWrite, setFinalWrite } from '../lib/tablock';
import { bump, href, navigate, settingsStore, toast, useStore } from '../lib/app-state';
import { LETTERS, type AnswerRecord, type Question, type SessionDetail, type SessionSummary } from '../lib/types';
import { Badge, Button, Modal, Seg } from '../ui/kit';
import { Icon } from '../ui/icons';
import { FigureView, OptionBody, QuestionImage, Rich } from '../ui/content';
import { FixQuestion } from './fix';
import { lazy } from '../ui/lazy';
import { isViewable } from '../lib/engine/session';
import { Presentation } from './presentation';
import { applyChoice, practiceState, practiceTally, unansweredAt } from '../lib/engine/answer';

const SnipImage = lazy(() => import('./pdf-tools').then((m) => m.SnipImage), <div class="skel" style={{ height: '200px' }} />);
const PdfPane = lazy(() => import('./pdf-tools').then((m) => m.PdfPane), <div class="skel" style={{ height: '50vh' }} />);
const PdfViewer = lazy(() => import('./pdf-tools').then((m) => m.PdfViewer));

const PRACTICE_STAY_CAP = 5 * 60_000;

/**
 * Timer bar colour: ink above half, then ink to warn (50% to 25%) and warn to bad (25% to 10%),
 * mixed in OKLCH. Ink is achromatic, so no hue sweeps through. Never orange: orange is the action.
 * The last 10% is bad plus stripes, a pulse and a "Low" word, so colour is never the only signal.
 */
export function timerColour(frac: number): string {
  if (frac > 0.5) return 'var(--ink)';
  if (frac <= 0.1) return 'var(--status-bad)';
  if (frac > 0.25) return `color-mix(in oklch, var(--status-warn) ${Math.round(((0.5 - frac) / 0.25) * 100)}%, var(--ink))`;
  return `color-mix(in oklch, var(--status-bad) ${Math.round(((0.25 - frac) / 0.15) * 100)}%, var(--status-warn))`;
}
const PERSIST_DEBOUNCE = 150;

interface Loaded {
  summary: SessionSummary;
  detail: SessionDetail;
  questions: Map<string, Question>;
}

export function SessionScreen({ id }: { id: string }) {
  const [state, setState] = useState<'loading' | 'locked' | 'missing' | 'ready'>('loading');
  const [data, setData] = useState<Loaded | null>(null);
  const release = useRef<(() => void) | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const rel = await acquireSessionLock();
      if (!live) return rel?.();
      if (!rel) return setState('locked');
      release.current = rel;
      const [summary, detail] = await Promise.all([store.getSession(id), store.getDetail(id)]);
      if (!summary || !detail) return setState('missing');
      if (summary.status === 'submitted' || summary.status === 'auto-submitted') return navigate(href.results(id), true);
      const questions = await loadSessionQuestions(detail);
      if (!live) return;
      // Re-derive the hard cap from the pack, so stored or restored timer data can never exceed it.
      if (detail.timer) {
        const pack = await store.getPack(summary.packId);
        const n = detail.questionIds.length;
        // Papers clamp to their current cap. Random and drill keep the cap fixed at creation.
        const capMin = summary.type === 'paper' ? pack?.papers.find((p) => p.id === summary.paperId)?.timeLimitMin : undefined;
        const c = sanitizeTimer(capMin ? { ...detail.timer.config, capMs: Math.min(detail.timer.config.capMs, capMin * 60_000) } : detail.timer.config, n);
        detail.timer = { ...detail.timer, config: c, remainingMs: Math.max(0, Math.min(detail.timer.remainingMs, c.totalMs)) };
      }
      setData({ summary: { ...summary, status: 'active' }, detail, questions });
      setState('ready');
    })();
    return () => {
      live = false;
      // Release the one-session lock only after the screen's final save has landed.
      // Child cleanups (the Runner's final save) run after this one, so wait a task first.
      const rel = release.current;
      setTimeout(() => void finalWrite.then(() => rel?.()), 0);
    };
  }, [id]);

  if (state === 'loading')
    return (
      <div class="qs" aria-busy="true">
        <div class="qs-head"><div class="bar-row"><div class="skel" style={{ height: '24px', width: '200px' }} /></div></div>
        <div class="qs-main"><div class="skel" style={{ height: '60vh' }} /></div>
        <div />
      </div>
    );
  if (state === 'locked' || state === 'missing')
    return (
      <main class="page" style={{ paddingTop: '96px' }}>
        <div class="notice notice--warn" role="alert">
          <Icon name="alert" />
          <div class="stack-s">
            <h2>{state === 'locked' ? 'This session is open in another tab' : 'Session not found'}</h2>
            <p class="muted">
              {state === 'locked'
                ? 'Only one tab can run a session at a time, so your answers cannot be overwritten. Close the other tab, then reload this one.'
                : 'It may have been discarded or submitted from another tab.'}
            </p>
            <div class="row">
              {state === 'locked' && <Button onClick={() => location.reload()}>Reload</Button>}
              <Button variant="primary" onClick={() => navigate(href.library())}>Go to library</Button>
            </div>
          </div>
        </div>
      </main>
    );
  return <Runner key={id} initial={data!} />;
}

function Runner({ initial }: { initial: Loaded }) {
  const settings = useStore(settingsStore);
  const [summary] = useState(initial.summary);
  const [questions, setQuestions] = useState(initial.questions);
  const detailRef = useRef<SessionDetail>(structuredClone(initial.detail));
  const [, force] = useState(0);
  const rerender = () => force((x) => x + 1);
  const d = detailRef.current;
  const n = d.questionIds.length;
  const cur = d.current;
  const qid = d.questionIds[cur] as string;
  const q = questions.get(qid);
  const a = d.answers[cur] as AnswerRecord;
  const exam = summary.mode === 'exam';
  const pdfMode = d.view === 'pdf';
  const timer = d.timer ? { ...d.timer, config: sanitizeTimer(d.timer.config, n) } : undefined;
  const strict = !!(timer?.config.kind === 'perq' && timer.config.strict);
  const ended = useRef(false);
  const [endOpen, setEndOpen] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [qAnnounce, setQAnnounce] = useState('');
  const [pdfPage, setPdfPage] = useState(q?.page ?? 1);
  const [viewPdf, setViewPdf] = useState(false);
  const [board, setBoard] = useState(false);
  const [wide, setWide] = useState(() => matchMedia('(min-width: 900px)').matches);
  const [eliminating, setEliminating] = useState(false);
  const [eliminated, setEliminated] = useState<Record<string, number[]>>({});
  const [jump, setJump] = useState('');
  const [saveStatus, setSaveStatus] = useState('Saved locally');
  const crossOut = (option: number) => setEliminated((prev) => {
    const values = prev[qid] ?? [];
    return { ...prev, [qid]: values.includes(option) ? values.filter((i) => i !== option) : [...values, option] };
  });
  useEffect(() => {
    const media = matchMedia('(min-width: 900px)');
    const change = () => { setWide(media.matches); if (!media.matches) setBoard(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (q?.page) setPdfPage(q.page);
  }, [q?.id]);

  // ----- timing -----
  const countdown = useRef<Countdown | null>(null);
  const qCountdown = useRef<Countdown | null>(null);
  const [remaining, setRemaining] = useState(timer?.remainingMs ?? 0);
  const [qRemaining, setQRemaining] = useState(a.qRemainingMs ?? 0);
  const stayStart = useRef(Date.now());

  const attribute = useCallback(() => {
    const now = Date.now();
    let dt = Math.max(0, now - stayStart.current);
    if (!exam) dt = Math.min(dt, PRACTICE_STAY_CAP);
    const rec = detailRef.current.answers[detailRef.current.current];
    if (rec) rec.timeMs += dt;
    stayStart.current = now;
  }, [exam]);

  // ----- persistence: answers on every change (debounced < 200 ms) -----
  const pending = useRef<number | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  /**
   * Writes are serialised so a late autosave can never land after Save or Submit. Once the
   * session has ended only the final write (final = true) goes through.
   */
  const lastOk = useRef(true);
  const autoFailed = useRef(false);
  const refused = useRef(false);
  const timeUp = useRef(false);
  const persist = useCallback(
    (status: SessionSummary['status'] = 'active', final = false): Promise<void> => {
      if (ended.current && !final) return chain.current;
      chain.current = chain.current.then(() => write(status));
      setFinalWrite(chain.current);
      return chain.current;
    },
    [],
  );
  const write = async (status: SessionSummary['status']) => {
      const det = detailRef.current;
      if (countdown.current && det.timer) {
        const r = countdown.current.remaining(Date.now(), performance.now());
        det.timer = { ...det.timer, remainingMs: r, ...(status === 'active' ? { endAt: countdown.current.endAt } : { endAt: undefined }) };
      }
      if (qCountdown.current) {
        const rec = det.answers[det.current];
        if (rec) rec.qRemainingMs = qCountdown.current.remaining(Date.now(), performance.now());
      }
      const s: SessionSummary = { ...summary, status, answered: det.answers.filter((x) => x.choice !== null).length, updatedAt: Date.now() };
      try {
        // Refused if the session was submitted or discarded elsewhere (another tab, the paper set page).
        if (!(await store.persistOpenSession(s, structuredClone(det)))) {
          // Finished or discarded elsewhere (another tab, the paper set page): leave instead of going dead.
          ended.current = true;
          if (!refused.current) {
            refused.current = true;
            const now = await store.getSession(summary.id);
            toast(now ? 'This session was submitted from another tab.' : 'This session was discarded from another tab.');
            navigate(now ? href.results(summary.id) : href.pack(summary.packId), true);
          }
          return;
        }
        lastOk.current = true;
        setSaveStatus('Saved locally');
      } catch {
        // Same wording as the global storage-full notice, so the two merge into one toast.
        if (lastOk.current) toast('Storage is full. Export a backup and delete paper sets you no longer need.', undefined, 10_000);
        lastOk.current = false;
        setSaveStatus('Save failed');
      }
  };
  const schedule = useCallback(() => {
    setSaveStatus('Saving locally…');
    if (pending.current) clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      void persist();
    }, PERSIST_DEBOUNCE);
  }, [persist]);
  const flush = useCallback(async () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    attribute();
    await persist();
  }, [persist, attribute]);

  // ----- end of session -----
  const finish = useCallback(
    async (auto: boolean) => {
      if (ended.current) return;
      ended.current = true;
      setBusy(true);
      attribute();
      try {
        await persist('active', true);
        if (refused.current) return;
        if (!lastOk.current) throw new Error('not saved');
        // After time zero every submit is the automatic one, even if it had to be retried by hand.
        const r = await submitSession(summary.id, auto || timeUp.current);
        bump();
        broadcastChange();
        dispatchEvent(new CustomEvent('dmc:submitted'));
        if (auto) toast('Time is up. Your paper was submitted automatically.');
        navigate(href.results(r?.summary.id ?? summary.id), true);
      } catch {
        ended.current = false;
        setBusy(false);
        // An automatic submit is not retried every tick; the user can press Submit.
        if (auto) autoFailed.current = true;
        toast(lastOk.current ? 'Could not submit. Your answers are saved; try again, or save the session for later.' : 'Could not submit: storage is full. Free some space (export a backup and delete unused paper sets), then submit again.', undefined, 10_000);
      }
    },
    [attribute, persist, summary.id],
  );

  const saveForLater = useCallback(async () => {
    if (ended.current) return;
    ended.current = true;
    attribute();
    await persist('saved', true);
    if (refused.current) return;
    if (!lastOk.current) {
      ended.current = false;
      toast('Could not save the session: storage is full. Free some space (export a backup and delete unused paper sets), then try again.', undefined, 12_000);
      return;
    }
    bump();
    broadcastChange();
    toast('Session saved. Resume it from the paper set page or when you next open DMC.');
    navigate(href.pack(summary.packId), true);
  }, [attribute, persist, summary.packId]);

  // Start timers.
  useEffect(() => {
    if (!timer) return;
    countdown.current = new Countdown(timer.remainingMs, Date.now(), performance.now());
    void persist();
  }, []);

  useEffect(() => {
    if (!strict) return;
    const rec = detailRef.current.answers[cur];
    qCountdown.current = new Countdown(rec?.qRemainingMs ?? timer?.config.perQMs ?? 0, Date.now(), performance.now());
    setQRemaining(rec?.qRemainingMs ?? 0);
  }, [cur, strict]);

  const goto = useCallback(
    (i: number) => {
      const det = detailRef.current;
      if (i < 0 || i >= n || i === det.current) return;
      if (strict && i < det.current) return;
      attribute();
      if (strict) {
        const rec = det.answers[det.current];
        if (rec) {
          rec.locked = true;
          rec.qRemainingMs = qCountdown.current?.remaining(Date.now(), performance.now()) ?? 0;
        }
      }
      det.current = i;
      setQAnnounce(`Question ${i + 1} of ${n}`);
      rerender();
      schedule();
    },
    [attribute, n, schedule, strict],
  );

  // Tick.
  useEffect(() => {
    if (!timer) return;
    let prev = timer.remainingMs;
    const tick = () => {
      if (ended.current || !countdown.current) return;
      const r = countdown.current.remaining(Date.now(), performance.now());
      const msg = crossedThreshold(prev, r, timer.config.totalMs);
      if (msg) setAnnounce(msg);
      prev = r;
      setRemaining(r);
      if (r <= 0) {
        timeUp.current = true;
        if (!autoFailed.current) void finish(true);
        return;
      }
      if (strict && qCountdown.current) {
        const qr = qCountdown.current.remaining(Date.now(), performance.now());
        setQRemaining(qr);
        if (qr <= 0) {
          const det = detailRef.current;
          if (det.current >= n - 1) return void finish(true);
          goto(det.current + 1);
        }
      }
    };
    tick();
    const iv = setInterval(tick, 250);
    const persistIv = setInterval(() => void persist(), 2000);
    const vis = () => (document.visibilityState === 'hidden' ? void flush() : tick());
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(iv);
      clearInterval(persistIv);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [timer?.config.totalMs, strict, finish, persist, flush, goto, n]);

  // Leaving the screen without ending (back button, closing the tab): save, never lose answers.
  useEffect(() => {
    const onHide = () => {
      attribute();
      void persist();
    };
    addEventListener('pagehide', onHide);
    return () => {
      removeEventListener('pagehide', onHide);
      if (!ended.current) {
        ended.current = true;
        attribute();
        void persist('saved', true).then(() => {
          bump();
          toast('Session saved. Resume it from the paper set page.');
        });
      }
    };
  }, [attribute, persist]);

  // ----- actions -----
  const locked = a.locked || a.checked;
  const choose = useCallback(
    (i: number) => {
      if (board) return;
      if (eliminating) { crossOut(i); return; }
      const rec = detailRef.current.answers[detailRef.current.current];
      if (!rec || timeUp.current || !q) return;
      const r = applyChoice(rec, i, q.optionCount, exam);
      if (r === 'ignored') return;
      if (!exam) attribute();
      if (r === 'cleared') setAnnounce('Answer cleared');
      rerender();
      schedule();
    },
    [q, exam, schedule, attribute, board, eliminating, qid],
  );
  /** PDF mode: answer any row of the sheet; the row becomes the current question (for timing). */
  const answerAt = useCallback(
    (j: number, i: number) => {
      const det = detailRef.current;
      if (j !== det.current) goto(j);
      if (det.current !== j) return;
      const rec = det.answers[j];
      const qq = questions.get(det.questionIds[j] as string);
      if (!rec || timeUp.current || !qq) return;
      const r = applyChoice(rec, i, qq.optionCount, exam);
      if (r === 'ignored') return;
      if (!exam) attribute();
      if (r === 'cleared') setAnnounce(`Question ${qq.n}: answer cleared`);
      rerender();
      schedule();
      return r;
    },
    [questions, exam, schedule, attribute, goto],
  );
  /** PDF mode: flag any row of the sheet. */
  const flagAt = useCallback(
    (j: number) => {
      const rec = detailRef.current.answers[j];
      if (!rec) return;
      rec.flagged = !rec.flagged;
      rerender();
      schedule();
    },
    [schedule],
  );
  const toggle = useCallback(
    (k: 'flagged' | 'unsure') => {
      const rec = detailRef.current.answers[detailRef.current.current];
      if (!rec || (k === 'unsure' && rec.checked)) return;
      rec[k] = !rec[k];
      rerender();
      schedule();
    },
    [schedule],
  );

  // Keyboard (layout effect: listening from the first paint).
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (endOpen || gridOpen || fixOpen || document.querySelector('.backdrop')) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const letter = 'abcde'.indexOf(k);
      const digit = '12345'.indexOf(k);
      if (letter >= 0 || digit >= 0) {
        e.preventDefault();
        choose(letter >= 0 ? letter : digit);
      } else if (k === 'arrowright' || (k === 'enter' && t.tagName !== 'BUTTON')) {
        e.preventDefault();
        if (detailRef.current.current >= n - 1) setEndOpen(true);
        else goto(detailRef.current.current + 1);
      } else if (k === 'arrowleft') {
        e.preventDefault();
        goto(detailRef.current.current - 1);
      } else if (k === 'f') toggle('flagged');
      else if (k === 'u') toggle('unsure');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [choose, goto, toggle, n, endOpen, gridOpen, fixOpen]);

  const answered = d.answers.filter((x) => x.choice !== null).length;
  const unanswered = n - answered;
  const flaggedCount = d.answers.filter((x) => x.flagged).length;
  const keyAt = (qid: string) => questions.get(qid)?.answer;
  const tally = exam ? null : practiceTally(d.answers, keyAt);
  const blanks = unansweredAt(d.answers);
  const frac = timer ? Math.max(0, Math.min(1, remaining / timer.config.totalMs)) : 1;
  const low = frac <= 0.1;
  const colour = timerColour(frac);
  const perQ = timer?.config.kind === 'perq' && !strict ? timer.config.perQMs ?? 0 : 0;
  const used = timer ? timer.config.totalMs - remaining : 0;
  const aheadMs = perQ ? cur * perQ - used : 0;
  const shortOpts = !!q?.options && !q.table && q.options.every((o) => !o.figure && (o.text?.length ?? 0) <= 28);

  const grid = (
    <div class="stack-s">
      <div class="qgrid" role="group" aria-label="Questions">
        {d.answers.map((r, i) => (
          <button
            type="button"
            key={r.qid}
            class={[r.choice !== null ? 'answered' : '', practiceState(r, keyAt(r.qid)) ? `is-${practiceState(r, keyAt(r.qid))}` : ''].join(' ').trim()}
            aria-current={i === cur ? 'true' : undefined}
            disabled={strict && i !== cur}
            onClick={() => {
              goto(i);
              setGridOpen(false);
            }}
            aria-label={`Question ${i + 1}${r.choice !== null ? ', answered' : ''}${practiceState(r, keyAt(r.qid)) === 'right' ? ', right' : practiceState(r, keyAt(r.qid)) === 'wrong' ? ', wrong' : ''}${r.flagged ? ', flagged' : ''}${r.unsure ? ', unsure' : ''}`}
          >
            {i + 1}
            {r.flagged && <span class="fl" aria-hidden="true" />}
            {r.unsure && <span class="un" aria-hidden="true" />}
          </button>
        ))}
      </div>
      {tally && <PracticeTally tally={tally} />}
      <div class="legend" aria-hidden="true">
        <span class="jy-badge jy-badge--ink">Answered: filled</span>
        <span class="jy-badge jy-badge--ink jy-badge--flag">Flag: top right</span>
        <span class="jy-badge jy-badge--warn">Unsure: top left</span>
        {tally && <span class="jy-badge jy-badge--ink">Right: green, wrong: red</span>}
      </div>
    </div>
  );

  const revisit = () => {
    const indices = d.answers.flatMap((answer, i) => answer.flagged ? [i] : []);
    const next = indices.find((i) => i > cur) ?? indices[0];
    if (next !== undefined) goto(next);
  };
  if (board && wide) return <Presentation question={q} position={cur} count={n} flagged={a.flagged} flaggedCount={flaggedCount} eliminated={eliminated[qid] ?? []} onEliminate={crossOut} onFlag={() => toggle('flagged')} onRevisit={revisit} onJump={goto} onExit={() => setBoard(false)} strict={strict} />;

  return (
    <div class="qs">
      <header class="qs-head">
        <div class="bar-row">
          <div class="qs-title">
            <div class="t">{summary.title}</div>
            <div class="s">
              Question <span class="num">{cur + 1}</span> of <span class="num">{n}</span>
              <span class="hide-sm">
                {' '}· <span class="num">{answered}</span> answered · {exam ? 'Exam' : 'Practice'}
              </span>
            </div>
          </div>
          {perQ > 0 && (
            <span class="small muted num" aria-label={`Pace: ${aheadMs >= 0 ? 'ahead' : 'behind'} by ${formatClock(Math.abs(aheadMs))}`}>
              {Math.abs(aheadMs) < 5000 ? 'On pace' : `${aheadMs > 0 ? 'Ahead' : 'Behind'} ${formatClock(Math.abs(aheadMs))}`}
            </span>
          )}
          {strict && <span class="small num" aria-label="Time left on this question">Q {formatClock(qRemaining)}</span>}
          {timer && low && <span class="jy-badge jy-badge--bad">Low: {remaining >= 60_000 ? `${Math.ceil(remaining / 60_000)} min` : `${Math.ceil(remaining / 1000)} s`} left</span>}
          {timer && (
            <span class={`clock${low ? ' low' : ''}`} role="timer" aria-label={`Time remaining ${formatClock(remaining)}`}>
              {formatClock(remaining)}
            </span>
          )}
          {wide && <Button onClick={() => setBoard(true)}>Board mode</Button>}
          <Button variant="default" onClick={() => setEndOpen(true)} aria-label="End session">
            <span>
              End<span class="hide-sm"> session</span>
            </span>
          </Button>
        </div>
        {timer && (
          <div class={`timer${low ? ' low' : ''}`} style={{ '--timer-colour': colour }} aria-hidden="true">
            <div class="fill" style={{ transform: `scaleX(${frac})` }} />
            {perQ > 0 && <div class="pace" style={{ left: `${Math.min(100, (cur / n) * 100)}%` }} />}
          </div>
        )}
        <div class="sr-only" aria-live="polite">{announce}</div>
        <div class="sr-only" aria-live="polite" aria-atomic="true">{qAnnounce}</div>
      </header>

      {pdfMode ? (
        <PdfSession
          pdfId={questions.get(d.questionIds[0] as string)?.pdfId}
          ids={d.questionIds}
          questions={questions}
          answers={d.answers}
          current={cur}
          exam={exam}
          page={pdfPage}
          onPage={setPdfPage}
          onAnswer={answerAt}
          onFlag={flagAt}
          tally={tally}
        />
      ) : (
      <main class="qs-main" id="main" tabIndex={-1}>
        <div class="qs-col">
          <section class="jy-panel qcard" aria-labelledby="qhead">
            <div class="qnum">
              <h1 id="qhead" class="h3" style={{ fontSize: '18px', lineHeight: '26px' }}>Question {cur + 1}</h1>
              {a.flagged && <span class="jy-badge jy-badge--ink jy-badge--flag">Flagged</span>}
              {a.unsure && <Badge status="warn">Unsure</Badge>}
              {a.locked && <Badge status="neutral">Locked</Badge>}
              <span class="spacer" />
              {q?.pdfId && isViewable(q) && (
                <Button variant="ghost" size="sm" onClick={() => setViewPdf(true)}>
                  <Icon name="file" size={16} /> View in PDF
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setFixOpen(true)}>
                <Icon name="pencil" size={16} /> Fix this question
              </Button>
            </div>
            <div class="session-tools">
              <Button size="sm" aria-pressed={eliminating} onClick={() => setEliminating((value) => !value)}>{eliminating ? 'Finish eliminating' : 'Eliminate options'}</Button>
              <form onSubmit={(e) => { e.preventDefault(); const i = Number(jump); if (Number.isInteger(i) && i >= 1 && i <= n) { goto(i - 1); setJump(''); } }}>
                <label class="sr-only" for="session-jump">Question number</label>
                <input class="input" id="session-jump" type="number" min={1} max={n} value={jump} placeholder="No." required disabled={strict} onInput={(e) => setJump(e.currentTarget.value)} />
                <Button type="submit" size="sm" disabled={strict}>Jump</Button>
              </form>
              <Button size="sm" onClick={revisit} disabled={strict || !flaggedCount}>Revisit ({flaggedCount})</Button>
              <span class="small muted" role="status">{saveStatus}</span>
            </div>
            {eliminating && <p class="small muted">Select options to cross them out for this session. This does not submit an answer.</p>}
            {!q ? (
              <p class="muted">This question could not be loaded. It may have been deleted from the pack.</p>
            ) : (
              <>
                {q.image && <QuestionImage imageId={q.image} n={q.n} />}
                {q.snip && !q.image && <SnipImage snip={q.snip} label={`Question ${q.n} as printed`} />}
                {!isViewable(q) && q.pdfId && <PdfPane pdfId={q.pdfId} page={pdfPage} onPage={setPdfPage} />}
                {q.stem && (
                  <div class="qtext">
                    <Rich text={q.stem} />
                  </div>
                )}
                {q.figure && <FigureView figure={q.figure} onAttach={() => setFixOpen(true)} />}
                {q.table && q.table.columns.some(Boolean) && (
                  <div class="opt" style={{ border: 0, background: 'none', minHeight: 0, padding: '0 12px', pointerEvents: 'none' }} aria-hidden="true">
                    <span />
                    <span style={{ display: 'grid', gridTemplateColumns: `repeat(${q.table.columns.length}, minmax(0, 1fr))`, gap: '12px' }} class="small muted">
                      {q.table.columns.map((c, k) => (
                        <span key={k}><Rich text={c} /></span>
                      ))}
                    </span>
                    <span />
                  </div>
                )}
                <div
                  class={!q.options && !q.table ? 'opts-letters' : `options${shortOpts ? ' cols-2' : ''}`}
                  role={eliminating ? 'group' : 'radiogroup'}
                  aria-labelledby="qhead"
                  onKeyDown={(e) => {
                    // Up/Down move focus between options (Space or Enter selects); Left/Right stay question navigation.
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                    const opts = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('.opt:not(:disabled)')];
                    const i = opts.indexOf(document.activeElement as HTMLButtonElement);
                    const next = opts[(i + (e.key === 'ArrowDown' ? 1 : opts.length - 1) + (i < 0 ? 1 : 0)) % opts.length];
                    if (next) {
                      e.preventDefault();
                      next.focus();
                    }
                  }}
                >
                  {Array.from({ length: q.optionCount }, (_, i) => {
                    const chosen = a.choice === i;
                    const showKey = a.checked && q.answer !== null;
                    const cls = showKey ? (i === q.answer ? 'correct' : chosen ? 'wrong' : '') : '';
                    return (
                      <button
                        type="button"
                        key={i}
                        role={eliminating ? 'button' : 'radio'}
                        aria-checked={eliminating ? undefined : chosen}
                        aria-pressed={eliminating ? (eliminated[qid] ?? []).includes(i) : undefined}
                        tabIndex={eliminating || chosen || (a.choice === null && i === 0) ? 0 : -1}
                        class={`opt ${cls}${(eliminated[qid] ?? []).includes(i) ? ' option-eliminated' : ''}`}
                        disabled={!eliminating && locked && !chosen}
                        onClick={() => choose(i)}
                      >
                        <span class="l" aria-hidden="true">{LETTERS[i]}</span>
                        <span class="ot">
                          <span class="sr-only">Option {LETTERS[i]}: </span>
                          <OptionBody q={q} i={i} />
                        </span>
                        <span>
                          {showKey && i === q.answer && <Badge status="ok">Correct</Badge>}
                          {showKey && chosen && i !== q.answer && <Badge status="bad">Your answer</Badge>}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {a.checked && q.answer !== null && (
                  <div class={`feedback ${a.choice === q.answer ? 'notice--ok' : 'notice--bad'}`} role="status">
                    <Badge status={a.choice === q.answer ? 'ok' : 'bad'}>{a.choice === q.answer ? 'Correct' : `Incorrect. The answer is ${LETTERS[q.answer]}`}</Badge>
                    {q.explanation && (
                      <span class="small" style={{ flexBasis: '100%' }}>
                        <Rich text={q.explanation} />
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
          <div class="qs-ctrl">
            <Button aria-pressed={a.flagged} onClick={() => toggle('flagged')}>
              <Icon name="flag" size={18} /> {a.flagged ? 'Flagged' : 'Flag'} {settings.keyHints && <span class="kbd">F</span>}
            </Button>
            <Button class={a.unsure ? 'unsure-on' : ''} aria-pressed={a.unsure} disabled={a.checked} onClick={() => toggle('unsure')}>
              <span aria-hidden="true" style={{ display: 'inline-block', width: '10px', height: '9px', background: 'var(--status-warn)', clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' }} />
              Unsure {settings.keyHints && <span class="kbd">U</span>}
            </Button>
            <span class="spacer" />
            <Button onClick={() => goto(cur - 1)} disabled={cur === 0 || strict} aria-label="Previous question">
              <Icon name="left" /> <span class="hide-sm">Previous</span>
            </Button>
            {cur < n - 1 ? (
              <Button class="jy-btn--inverse" onClick={() => goto(cur + 1)}>
                Next <Icon name="right" />
              </Button>
            ) : (
              <Button class="jy-btn--inverse" onClick={() => (!settings.confirmSubmit && unanswered === 0 ? void finish(false) : setEndOpen(true))}>
                Finish
              </Button>
            )}
          </div>
        </div>
        <aside class="qs-side" aria-label="Question navigator">
          <div class="label">Questions</div>
          {grid}
          {settings.keyHints && (
            <p class="small subtle">
              Keys: <span class="kbd">A</span>–<span class="kbd">{LETTERS[(q?.optionCount ?? 4) - 1]}</span> answer, <span class="kbd">←</span> <span class="kbd">→</span> move, <span class="kbd">F</span> flag, <span class="kbd">U</span> unsure.
            </p>
          )}
        </aside>
      </main>
      )}

      {!pdfMode && <footer class="qs-foot show-sm">
        <Button onClick={() => setGridOpen(true)}>
          <Icon name="grid" size={18} /> Questions
        </Button>
        <span class="small muted">{flaggedCount ? `${flaggedCount} flagged` : ''}</span>
      </footer>}

      {viewPdf && q?.pdfId && <PdfViewer pdfId={q.snip?.pdfId ?? q.pdfId} page={q.snip?.page ?? q.page ?? 1} title={`Question ${q.n} in the paper`} onClose={() => setViewPdf(false)} />}
      {gridOpen && (
        <Modal title="Questions" onClose={() => setGridOpen(false)}>
          {grid}
        </Modal>
      )}
      {fixOpen && q && (
        <FixQuestion
          packId={summary.packId}
          question={q}
          allowAnswer={!exam || a.checked}
          onClose={() => setFixOpen(false)}
          onSaved={async () => {
            setQuestions(await loadSessionQuestions(detailRef.current));
          }}
        />
      )}
      {endOpen && (
        <Modal
          title="End session"
          onClose={() => setEndOpen(false)}
          footer={
            <>
              <Button onClick={() => setEndOpen(false)} autoFocus>Keep going</Button>
              <Button onClick={saveForLater} disabled={busy}>
                <Icon name="save" size={18} /> Save for later
              </Button>
              <Button variant="accent" onClick={() => finish(false)} disabled={busy || answered === 0}>
                Submit
              </Button>
            </>
          }
        >
          <div class="stack">
            <p>
              <span class="num">{answered}</span> of <span class="num">{n}</span> answered
              {flaggedCount > 0 && (
                <>
                  , <span class="num">{flaggedCount}</span> flagged
                </>
              )}
              .
            </p>
            {blanks.length > 0 && (
              <div class="stack-s">
                <p class="small"><b>Not answered:</b> question{blanks.length === 1 ? '' : 's'}</p>
                <div class="chips" role="group" aria-label="Unanswered questions">
                  {blanks.slice(0, 40).map((i) => (
                    <Button key={i} size="sm" disabled={strict} onClick={() => { setEndOpen(false); goto(i); if (pdfMode) requestAnimationFrame(() => document.getElementById(`sheet-${i}`)?.scrollIntoView({ block: 'center' })); }}>{i + 1}</Button>
                  ))}
                  {blanks.length > 40 && <span class="small muted">and {blanks.length - 40} more</span>}
                </div>
              </div>
            )}
            {unanswered > 0 && answered > 0 && (
              <div class="notice notice--warn">
                <Badge status="warn">Partial</Badge>
                <div class="small">
                  Submitting grades only your {answered} answered question{answered === 1 ? '' : 's'}. The {unanswered} unanswered go back to the unseen pool, and this session is marked partial, so it stays out of your trend.
                </div>
              </div>
            )}
            {answered === 0 && <p class="small muted">Answer at least one question to submit, or save the session for later.</p>}
            <p class="small muted">
              <b>Save for later</b> keeps your answers{timer ? ' and freezes the timer' : ''} so you can resume exactly here.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}


/**
 * PDF mode: the printed paper on the left and an A–D (or A–E) answer sheet on the right; on
 * narrow screens they stack, with a switch between them. Same question IDs, grading and stats
 * as typed questions.
 */
const FOLLOW_KEY = 'dmc-sheet-follow';
const readFollow = () => { try { return localStorage.getItem(FOLLOW_KEY) === '1'; } catch { return false; } };

/** Running right/wrong count and accuracy in practice. */
function PracticeTally({ tally }: { tally: ReturnType<typeof practiceTally> }) {
  return (
    <p class="tally small" role="status">
      <span class="num">{tally.pct === null ? '–' : `${tally.pct}%`}</span> accuracy · <span class="tally-right"><Icon name="check" size={14} /> <span class="num">{tally.right}</span> right</span> · <span class="tally-wrong"><Icon name="x" size={14} /> <span class="num">{tally.wrong}</span> wrong</span>
    </p>
  );
}

function PdfSession({ pdfId, ids, questions, answers, current, exam, page, onPage, onAnswer, onFlag, tally }: {
  pdfId: string | undefined;
  ids: string[];
  questions: Map<string, Question>;
  answers: AnswerRecord[];
  current: number;
  exam: boolean;
  page: number;
  onPage: (p: number) => void;
  onAnswer: (j: number, i: number) => 'set' | 'cleared' | 'ignored' | undefined;
  onFlag: (j: number) => void;
  tally: ReturnType<typeof practiceTally> | null;
}) {
  const [show, setShow] = useState<'paper' | 'sheet'>('paper');
  const [follow, setFollow] = useState(readFollow);
  const sheetRef = useRef<HTMLOListElement>(null);
  const toggleFollow = () => setFollow((f) => { try { localStorage.setItem(FOLLOW_KEY, f ? '0' : '1'); } catch { /* private mode */ } return !f; });
  // Follow: answering row j brings row j+1 to the middle of the sheet; only the sheet scrolls.
  const answer = (j: number, i: number) => {
    const r = onAnswer(j, i);
    if (!follow || r !== 'set' || j + 1 >= ids.length) return;
    const row = sheetRef.current?.children[j + 1] as HTMLElement | undefined;
    const box = row?.closest('.pdf-split-sheet') as HTMLElement | null;
    if (!row || !box) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top = row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
  };
  const answered = answers.filter((x) => x.choice !== null).length;
  return (
    <main class="qs-main pdf-mode" id="main" tabIndex={-1}>
      <div class="pdf-switch show-sm">
        <Seg label="Show" value={show} onChange={setShow} options={[{ value: 'paper', label: 'Paper' }, { value: 'sheet', label: `Answer sheet (${answered}/${ids.length})` }]} />
      </div>
      <div class="pdf-split" data-show={show}>
        <section class="pdf-split-paper" aria-label="Question paper">
          {pdfId ? <PdfPane pdfId={pdfId} page={page} onPage={onPage} /> : <p class="muted">The question paper PDF is not on this device. Download the set again, or attach the PDF from the paper's details.</p>}
        </section>
        <section class="pdf-split-sheet jy-panel" aria-labelledby="sheet-head">
          <div class="sheet-head">
            <h1 id="sheet-head" class="h3">Answer sheet <span class="small muted num">{answered} of {ids.length}</span></h1>
            <Button size="sm" aria-pressed={follow} onClick={toggleFollow} title="After each answer, move the next question to the middle of the sheet">
              {follow ? 'Follow on' : 'Follow off'}
            </Button>
          </div>
          {tally && <PracticeTally tally={tally} />}
          <ol class="sheet" ref={sheetRef}>
            {ids.map((id, j) => {
              const q = questions.get(id);
              const a = answers[j]!;
              const count = q?.optionCount ?? 4;
              const showKey = !exam && a.checked && q?.answer !== null && q?.answer !== undefined;
              const st = practiceState(a, q?.answer);
              return (
                <li key={id} class={`sheet-row${j === current ? ' is-current' : ''}${st ? ` is-${st}` : ''}`}>
                  <span class="sheet-n num" id={`sheet-${j}`}>{q?.n ?? j + 1}</span>
                  <div class="sheet-opts" role="radiogroup" aria-label={`Question ${q?.n ?? j + 1}`}>
                    {Array.from({ length: count }, (_, i) => {
                      const chosen = a.choice === i;
                      const state = showKey ? (i === q!.answer ? 'correct' : chosen ? 'wrong' : '') : '';
                      return (
                        <button key={i} type="button" role="radio" aria-checked={chosen} disabled={a.locked || (a.checked && !chosen)} class={`sheet-opt${chosen ? ' is-chosen' : ''}${state ? ` is-${state}` : ''}`} onClick={() => answer(j, i)} aria-label={`${LETTERS[i]}${state === 'correct' ? ', correct answer' : state === 'wrong' ? ', wrong' : ''}`}>
                          {LETTERS[i]}
                        </button>
                      );
                    })}
                  </div>
                  <span class="sheet-mark small">
                    {showKey && (a.choice === q!.answer ? <Badge status="ok">Right</Badge> : <Badge status="bad">{LETTERS[q!.answer!]}</Badge>)}
                    <button type="button" class={`sheet-flag${a.flagged ? ' is-on' : ''}`} aria-pressed={a.flagged} aria-label={`Flag question ${q?.n ?? j + 1}`} onClick={() => onFlag(j)}>
                      <Icon name="flag" size={16} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </main>
  );
}
