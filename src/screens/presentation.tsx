import { useEffect, useRef, useState } from 'preact/hooks';
import type { Question } from '../lib/types';
import { LETTERS } from '../lib/types';
import { settingsStore, toast, updateSettings, useStore } from '../lib/app-state';
import { Button } from '../ui/kit';
import { FigureView, OptionBody, QuestionImage, Rich } from '../ui/content';
import { lazy } from '../ui/lazy';
import './presentation.css';

const SnipImage = lazy(() => import('./pdf-tools').then((m) => m.SnipImage));
const PdfPane = lazy(() => import('./pdf-tools').then((m) => m.PdfPane));
const PdfViewer = lazy(() => import('./pdf-tools').then((m) => m.PdfViewer));

export interface PresentationProps {
  question?: Question;
  position: number;
  count: number;
  flagged: boolean;
  flaggedCount: number;
  eliminated: number[];
  onEliminate: (option: number) => void;
  onFlag: () => void;
  onRevisit: () => void;
  onJump: (position: number) => void;
  onExit: () => void;
  strict: boolean;
}

/** Layout only: the empty half belongs to the school's external whiteboard tools. */
export function Presentation(props: PresentationProps) {
  const settings = useStore(settingsStore);
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => {
    try { const s = localStorage.getItem('dmc-presentation-size'); return ['24', '30', '36'].includes(s ?? '') ? s! : '30'; }
    catch { return '30'; }
  });
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const change = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', change);
    return () => { document.removeEventListener('fullscreenchange', change); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); };
  }, []);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (root.current?.requestFullscreen) await root.current.requestFullscreen();
      else toast('Fullscreen is unavailable in this browser. Use its presentation or fullscreen command.');
    } catch { toast('Fullscreen was refused by the browser. Try its fullscreen command.'); }
  };
  return (
    <div ref={root} class="board" style={{ '--presentation-size': `${size}px` }}>
      <div class="board-question-pane">
        <header class="board-controls">
          <div class="row">
            <strong>Question {props.position + 1} / {props.count}</strong>
            <span class="spacer" />
            <Button onClick={props.onExit}>Exit board mode</Button>
          </div>
          <div class="row">
            <Button onClick={() => void toggleFullscreen()}>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</Button>
            <label class="board-select">Theme
              <select class="input" aria-label="Theme" value={settings.theme} onChange={(e) => void updateSettings({ theme: e.currentTarget.value as 'light' | 'dark' | 'system' })}>
                <option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option>
              </select>
            </label>
            <label class="board-select">Text size
              <select class="input" aria-label="Text size" value={size} onChange={(e) => { const next = e.currentTarget.value; setSize(next); try { localStorage.setItem('dmc-presentation-size', next); } catch { /* Optional device preference. */ } }}>
                <option value="24">Large</option><option value="30">Larger</option><option value="36">Largest</option>
              </select>
            </label>
          </div>
          <PresentationNavigation {...props} />
        </header>
        <main class="board-content" id="main" tabIndex={-1}>
          <PresentedQuestion key={props.question?.id ?? props.position} question={props.question} eliminated={props.eliminated} onEliminate={props.onEliminate} />
        </main>
      </div>
      <div class="board-blank" data-testid="board-blank" aria-hidden="true" />
    </div>
  );
}

function PresentationNavigation({ position, count, flagged, flaggedCount, strict, onJump, onFlag, onRevisit }: PresentationProps) {
  const [jump, setJump] = useState(String(position + 1));
  useEffect(() => setJump(String(position + 1)), [position]);
  return (
    <nav class="board-nav" aria-label="Presentation questions">
      <Button disabled={position === 0 || strict} onClick={() => onJump(position - 1)}>Previous</Button>
      <Button disabled={position === count - 1} onClick={() => onJump(position + 1)}>Next</Button>
      <form class="board-jump" onSubmit={(e) => { e.preventDefault(); const i = Number(jump); if (Number.isInteger(i) && i >= 1 && i <= count) onJump(i - 1); }}>
        <label class="sr-only" for="board-jump">Question number</label>
        <input id="board-jump" class="input" type="number" min={1} max={count} value={jump} onInput={(e) => setJump(e.currentTarget.value)} disabled={strict} required />
        <Button type="submit" disabled={strict}>Jump</Button>
      </form>
      <Button aria-pressed={flagged} onClick={onFlag}>{flagged ? 'Flagged for revisit' : 'Flag for revisit'}</Button>
      <Button disabled={!flaggedCount || strict} onClick={onRevisit}>Revisit ({flaggedCount})</Button>
    </nav>
  );
}

function PresentedQuestion({ question: q, eliminated, onEliminate }: { question?: Question; eliminated: number[]; onEliminate: (option: number) => void }) {
  const [reveal, setReveal] = useState<0 | 1 | 2>(0);
  const [viewPdf, setViewPdf] = useState(false);
  const [page, setPage] = useState(q?.page ?? 1);
  if (!q) return <p>This question could not be loaded. Exit board mode to check the pack.</p>;
  return (
    <article class="board-question">
      <h1 class="h2">Question {q.n}</h1>
      {q.pdfId && <Button onClick={() => setViewPdf(true)}>Open source PDF, page {q.page ?? 1}</Button>}
      {q.image && <QuestionImage imageId={q.image} n={q.n} />}
      {q.snip && !q.image && <SnipImage snip={q.snip} label={`Question ${q.n} as printed`} />}
      {!q.stem && !q.image && !q.snip && q.pdfId && <PdfPane pdfId={q.pdfId} page={page} onPage={setPage} />}
      {q.stem && <div class="board-stem"><Rich text={q.stem} /></div>}
      {q.figure && <FigureView figure={q.figure} />}
      {q.table && <div class="board-table-wrap"><table><thead><tr><th scope="col">Option</th>{q.table.columns.map((c, i) => <th key={i} scope="col"><Rich text={c} /></th>)}</tr></thead><tbody>{q.table.rows.map((row, i) => <tr key={i}><th scope="row">{LETTERS[i]}</th>{row.map((cell, k) => <td key={k}><Rich text={cell} /></td>)}</tr>)}</tbody></table></div>}
      <div class="board-options" role="group" aria-label="Options: select to cross out for this session">
        {Array.from({ length: q.optionCount }, (_, i) => <button type="button" key={i} class={`board-option${eliminated.includes(i) ? ' option-eliminated' : ''}${reveal && i === q.answer ? ' board-option--answer' : ''}`} aria-pressed={eliminated.includes(i)} aria-describedby={`board-option-${i}`} aria-label={`Cross out option ${LETTERS[i]}${eliminated.includes(i) ? ', crossed out' : ''}`} onClick={() => onEliminate(i)}><b>{LETTERS[i]}</b><span id={`board-option-${i}`}><OptionBody q={q} i={i} /></span></button>)}
      </div>
      <p class="small muted">Select an option to cross it out. This does not submit an answer.</p>
      <div class="row">
        {q.answer === null ? <p class="muted">No answer key supplied.</p> : <>
          <Button onClick={() => setReveal(reveal ? 0 : 1)}>{reveal ? 'Hide answer' : 'Reveal answer'}</Button>
          {reveal > 0 && <strong role="status">Answer: {LETTERS[q.answer]}</strong>}
          {reveal === 1 && q.explanation && <Button onClick={() => setReveal(2)}>Reveal explanation</Button>}
        </>}
      </div>
      {reveal === 2 && q.explanation && <div class="board-explanation"><Rich text={q.explanation} /></div>}
      {viewPdf && q.pdfId && <PdfViewer pdfId={q.snip?.pdfId ?? q.pdfId} page={q.snip?.page ?? q.page ?? 1} title={`Question ${q.n} in the paper`} onClose={() => setViewPdf(false)} />}
    </article>
  );
}
