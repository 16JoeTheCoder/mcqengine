import { useEffect, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { setPaperBoundaries, setPaperKey } from '../lib/data/keys';
import { parseImport } from '../lib/data/importer';
import { parseKey } from '../lib/format/validate';
import { bump, toast } from '../lib/app-state';
import { broadcastChange } from '../lib/tablock';
import { LETTERS, type GradeBoundary, type Paper } from '../lib/types';
import { Button, Field, Modal, Seg } from '../ui/kit';
import { Icon } from '../ui/icons';
import { lazy } from '../ui/lazy';

const MarkSchemeReader = lazy(() => import('./pdf-tools').then((m) => m.MarkSchemeReader));
const PdfViewer = lazy(() => import('./pdf-tools').then((m) => m.PdfViewer));

type Tab = 'key' | 'grades' | 'pdfs';

/** Reads a key from pasted text or a JSON/TXT file: a DMC answers document, or any letter string. */
export function keyFromText(text: string, paperId: string, count: number): (number | null)[] | null {
  const parsed = parseImport(text);
  if (parsed.ok) {
    const a = parsed.result.doc.answers.find((x) => x.paper === paperId) ?? (parsed.result.doc.answers.length === 1 ? parsed.result.doc.answers[0] : undefined);
    if (a) return a.key;
    const p = parsed.result.doc.papers.find((x) => x.id === paperId);
    if (p) return Array.from({ length: count }, (_, i) => p.questions.find((q) => q.n === i + 1)?.answer ?? null);
  }
  return parseKey(text.trim(), new Set()) ?? null;
}

/**
 * Answer key and grade boundaries for one paper. The key is always shown as a letter grid to
 * confirm, whatever it came from (typed, file, mark scheme PDF, or the student's own answers).
 */
export function PaperDialog({ packId, paperId, onClose, mine, initialTab = 'key' }: { packId: string; paperId: string; onClose: () => void; mine?: (number | null)[]; initialTab?: Tab }) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [key, setKey] = useState<(number | null)[]>([]);
  const [text, setText] = useState('');
  const [bounds, setBounds] = useState<GradeBoundary[]>([]);
  const [busy, setBusy] = useState(false);
  const [msOpen, setMsOpen] = useState(false);

  useEffect(() => {
    void store.getPaper(`${packId}::${paperId}`).then((p) => {
      if (!p) return;
      setPaper(p);
      setKey(Array.from({ length: p.questionCount }, (_, i) => p.questions.find((q) => q.n === i + 1)?.answer ?? null));
      setBounds(p.boundaries ?? []);
    });
  }, [packId, paperId]);

  if (!paper) return null;
  const n = paper.questionCount;
  const filled = key.filter((k) => k !== null).length;

  const fill = (k: (number | null)[] | null, source: string) => {
    if (!k) return toast(`Could not read a key from ${source}.`);
    if (k.length !== n) return toast(`That key has ${k.length} answers; this paper has ${n}. Check it and try again.`);
    if (k.some((x) => x !== null && x >= paper.optionCount)) return toast(`That key uses letters beyond ${LETTERS[paper.optionCount - 1]}.`);
    setKey(k);
    toast('Key filled in. Check it against the mark scheme, then save.');
  };

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.txt,application/json,text/plain';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 1_000_000) return toast('That file is too large for an answer key.');
      fill(keyFromText(await f.text(), paperId, n), f.name);
    };
    input.click();
  };

  const saveKey = async () => {
    setBusy(true);
    try {
      const regraded = await setPaperKey(packId, paperId, key);
      bump();
      broadcastChange();
      toast(regraded ? `Key saved. Regraded ${regraded} session${regraded === 1 ? '' : 's'}.` : 'Key saved.');
      onClose();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  const saveBounds = async () => {
    const clean = bounds.filter((b) => b.grade.trim()).map((b) => ({ grade: b.grade.trim().slice(0, 8), min: Math.min(n, Math.max(0, Math.round(b.min) || 0)) }));
    await setPaperBoundaries(packId, paperId, clean);
    bump();
    broadcastChange();
    toast(clean.length ? 'Grade boundaries saved.' : 'Grade boundaries removed.');
    onClose();
  };

  return (
    <Modal
      title={`${paper.title}: key and details`}
      size="wide"
      onClose={onClose}
      footer={
        tab === 'pdfs' ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : tab === 'key' ? (
          <>
            <span class="small muted" style={{ marginRight: 'auto' }}>
              <span class="num">{filled}</span> of <span class="num">{n}</span> keyed
            </span>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={saveKey} disabled={busy || !filled}>Save key</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={saveBounds}>Save boundaries</Button>
          </>
        )
      }
    >
      <div class="stack">
        <Seg label="Section" value={tab} onChange={setTab} options={[{ value: 'key', label: 'Answer key' }, { value: 'grades', label: 'Grade boundaries' }, { value: 'pdfs', label: 'PDFs' }]} />
        {tab === 'pdfs' ? (
          <PaperPdfs paper={paper} onChange={() => void store.getPaper(`${packId}::${paperId}`).then((p) => p && setPaper(p))} />
        ) : tab === 'key' ? (
          <>
            <div class="row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 260px' }}>
                <Field label="Type or paste the key" hint="Letters in order (ACDB…), or 1A 2C 3D. Use ? for unknown.">
                  <input class="input num" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && fill(keyFromText(text, paperId, n), 'that text')} />
                </Field>
              </div>
              <Button onClick={() => fill(keyFromText(text, paperId, n), 'that text')} disabled={!text.trim()}>Fill grid</Button>
            </div>
            <div class="row">
              <Button onClick={pickFile}><Icon name="file" size={18} /> JSON or TXT file</Button>
              <Button onClick={() => setMsOpen(true)}><Icon name="upload" size={18} /> Mark scheme PDF</Button>
              {mine && (
                <Button onClick={() => { setKey(mine.map((m, i) => m ?? key[i] ?? null)); toast('Your answers are in the grid. Change the ones the mark scheme says are wrong, then save.'); }}>
                  <Icon name="check" size={18} /> Mark it myself
                </Button>
              )}
            </div>
            <KeyGrid optionCount={paper.optionCount} value={key} onChange={setKey} mine={mine} />
            <p class="small subtle">Saving makes this the paper's key. Every session graded with the old key, or waiting for one, is regraded.</p>
          </>
        ) : (
          <div class="stack-s">
            <p class="small muted">Minimum raw marks out of <span class="num">{n}</span> for each grade. Results then show how far you are from the next grade.</p>
            {bounds.map((b, i) => (
              <div class="row" key={i}>
                <Field label="Grade"><input class="input" style={{ width: '96px' }} value={b.grade} maxLength={8} onInput={(e) => setBounds(bounds.map((x, k) => (k === i ? { ...x, grade: (e.target as HTMLInputElement).value } : x)))} /></Field>
                <Field label="Minimum marks"><input class="input num" style={{ width: '120px' }} inputMode="numeric" value={String(b.min)} onInput={(e) => setBounds(bounds.map((x, k) => (k === i ? { ...x, min: Number((e.target as HTMLInputElement).value) } : x)))} /></Field>
                <Button variant="ghost" icon aria-label={`Remove grade ${b.grade || i + 1}`} onClick={() => setBounds(bounds.filter((_, k) => k !== i))} style={{ alignSelf: 'flex-end' }}><Icon name="x" /></Button>
              </div>
            ))}
            <div><Button onClick={() => setBounds([...bounds, { grade: '', min: 0 }])}><Icon name="plus" size={18} /> Add grade</Button></div>
          </div>
        )}
      </div>
      {msOpen && <MarkSchemeReader paper={paper} onClose={() => setMsOpen(false)} onKey={(k) => { setMsOpen(false); fill(k, 'the mark scheme'); }} />}
    </Modal>
  );
}

/** One row per question, one choice per option. `mine` shows the student's own answer as a hint. */
export function KeyGrid({ optionCount, value, onChange, mine }: { optionCount: number; value: (number | null)[]; onChange: (k: (number | null)[]) => void; mine?: (number | null)[] }) {
  return (
    <div class="key-grid" role="group" aria-label="Answer key">
      {value.map((k, i) => (
        <div class="key-row" key={i}>
          <span class="num kq">{i + 1}</span>
          <div class="seg" role="radiogroup" aria-label={`Question ${i + 1}`}>
            {Array.from({ length: optionCount }, (_, o) => (
              <button type="button" role="radio" aria-checked={k === o} key={o} onClick={() => onChange(value.map((x, j) => (j === i ? (x === o ? null : o) : x)))}>
                {LETTERS[o]}
              </button>
            ))}
          </div>
          {mine && <span class="small subtle num">{mine[i] === null || mine[i] === undefined ? '—' : `you ${LETTERS[mine[i] as number]}`}</span>}
        </div>
      ))}
    </div>
  );
}

/** Attach the question paper and mark scheme, so every question can open its page ("View in PDF"). */
function PaperPdfs({ paper, onChange }: { paper: Paper; onChange: () => void }) {
  const [view, setView] = useState<string | null>(null);
  const attach = async (role: 'qp' | 'ms') => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const { storePdf, attachPdf } = await import('../lib/data/pdfs');
        await attachPdf(paper.packId, paper.id, role, await storePdf(f, f.name));
        bump();
        broadcastChange();
        onChange();
        toast(role === 'qp' ? 'Question paper attached. Questions with a page number open it with View in PDF.' : 'Mark scheme attached.');
      } catch (e) {
        toast((e as Error).message);
      }
    };
    input.click();
  };
  const row = (role: 'qp' | 'ms', label: string) => (
    <div class="row" key={role}>
      <span style={{ flex: 1 }}>
        <b>{label}</b> <span class="small muted">{paper.pdf?.[role] ? 'attached' : 'not attached'}</span>
      </span>
      {paper.pdf?.[role] && <Button size="sm" onClick={() => setView(paper.pdf![role]!)}>View</Button>}
      <Button size="sm" onClick={() => void attach(role)}>{paper.pdf?.[role] ? 'Replace' : 'Attach'}</Button>
    </div>
  );
  return (
    <div class="stack">
      <p class="small muted">PDFs stay on this device and travel with Pack for friends. They never sync.</p>
      {row('qp', 'Question paper')}
      {row('ms', 'Mark scheme')}
      {view && <PdfViewer pdfId={view} title={paper.title} onClose={() => setView(null)} />}
    </div>
  );
}
