import { useEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import * as store from '../lib/data/db';
import { attachPdf, isPdf, storePdf } from '../lib/data/pdfs';
import { parseMarkScheme } from '../lib/format/markscheme';
import { cropPage, openPdf, pdfText, renderPage, type Rect } from '../lib/pdf/pdf';
import { bump, toast } from '../lib/app-state';
import type { Paper, Snip } from '../lib/types';
import { Button, Modal } from '../ui/kit';
import { Icon } from '../ui/icons';

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Opens a stored PDF by id, closing it on unmount. */
export function usePdf(pdfId: string | undefined): PDFDocumentProxy | null | 'error' {
  const [doc, setDoc] = useState<PDFDocumentProxy | null | 'error'>(null);
  useEffect(() => {
    if (!pdfId) return;
    let live = true;
    let opened: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        const rec = await store.getPdf(pdfId);
        if (!rec) throw new Error('missing');
        opened = await openPdf(rec.blob);
        if (live) setDoc(opened);
      } catch {
        if (live) setDoc('error');
      }
    })();
    return () => {
      live = false;
      void opened?.loadingTask.destroy();
    };
  }, [pdfId]);
  return doc;
}

/** Renders one page into a canvas that fills its container's width. */
export function PdfPage({ doc, page, onSize }: { doc: PDFDocumentProxy; page: number; onSize?: (s: { width: number; height: number }) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!w || !ref.current) return;
    void renderPage(doc, page, ref.current, w).then((s) => onSize?.(s)).catch(() => {});
  }, [doc, page, w]);
  return (
    <div ref={box} class="pdf-page paper">
      <canvas ref={ref} role="img" aria-label={`Page ${page} of the PDF`} />
    </div>
  );
}

/** "View in PDF": the stored question paper at the question's page. */
export function PdfViewer({ pdfId, page = 1, title, onClose }: { pdfId: string; page?: number; title: string; onClose: () => void }) {
  const doc = usePdf(pdfId);
  const [p, setP] = useState(page);
  const n = doc && doc !== 'error' ? doc.numPages : 0;
  return (
    <Modal title={title} size="full" onClose={onClose}>
      {doc === 'error' ? (
        <p class="muted">This PDF could not be opened. It may have been removed from this device.</p>
      ) : !doc ? (
        <div class="skel" style={{ height: '60vh' }} aria-busy="true" />
      ) : (
        <div class="stack-s">
          <div class="row">
            <Button onClick={() => setP(Math.max(1, p - 1))} disabled={p <= 1} aria-label="Previous page"><Icon name="left" /></Button>
            <span class="small num" aria-live="polite">Page {p} of {n}</span>
            <Button onClick={() => setP(Math.min(n, p + 1))} disabled={p >= n} aria-label="Next page"><Icon name="right" /></Button>
          </div>
          <PdfPage doc={doc} page={p} />
        </div>
      )}
    </Modal>
  );
}

/**
 * Reads a key from the paper's mark scheme PDF. The result is never trusted: it goes back to the
 * letter grid for the student to check before saving.
 */
export function MarkSchemeReader({ paper, onClose, onKey }: { paper: Paper; onClose: () => void; onKey: (k: (number | null)[]) => void }) {
  const [busy, setBusy] = useState(false);
  const read = async (pdfId: string) => {
    setBusy(true);
    try {
      const rec = await store.getPdf(pdfId);
      if (!rec) throw new Error('missing');
      const doc = await openPdf(rec.blob);
      const text = (await pdfText(doc)).join('\n');
      void doc.loadingTask.destroy();
      const { key, found } = parseMarkScheme(text, paper.questionCount, paper.optionCount);
      if (!found) {
        toast('No answers found in that PDF. It may be scanned; type the key instead.');
        setBusy(false);
        return;
      }
      toast(`Read ${found} of ${paper.questionCount} answers. Check every row against the mark scheme.`);
      onKey(key);
    } catch {
      toast('Could not read that PDF.');
      setBusy(false);
    }
  };
  const choose = async () => {
    const f = await pickFile('application/pdf,.pdf');
    if (!f) return;
    if (!isPdf(f)) return toast('Choose a PDF file.');
    try {
      const id = await storePdf(f, f.name);
      await attachPdf(paper.packId, paper.id, 'ms', id);
      bump();
      await read(id);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <Modal title="Read the mark scheme" onClose={onClose}>
      <div class="stack">
        <p class="small muted">DMC reads the answer column from a text PDF and fills the grid. You confirm every letter before it is saved. Scanned PDFs have no text to read.</p>
        <div class="row">
          {paper.pdf?.ms && <Button variant="primary" onClick={() => void read(paper.pdf!.ms!)} disabled={busy}>Read stored mark scheme</Button>}
          <Button onClick={() => void choose()} disabled={busy}><Icon name="upload" size={18} /> Choose PDF</Button>
        </div>
        {busy && <p class="small muted" aria-live="polite">Reading…</p>}
      </div>
    </Modal>
  );
}

const crops = new Map<string, Promise<string>>();

/** A snipped question, cropped from its PDF page at runtime (the crop is cached for the page's life). */
export function SnipImage({ snip, label }: { snip: Snip; label: string }) {
  const [url, setUrl] = useState<string | null | 'error'>(null);
  const k = `${snip.pdfId}|${snip.page}|${snip.x}|${snip.y}|${snip.w}|${snip.h}`;
  useEffect(() => {
    let live = true;
    if (!crops.has(k))
      crops.set(
        k,
        (async () => {
          const rec = await store.getPdf(snip.pdfId);
          if (!rec) throw new Error('missing');
          const doc = await openPdf(rec.blob);
          const blob = await cropPage(doc, snip.page, snip);
          void doc.loadingTask.destroy();
          return URL.createObjectURL(blob);
        })(),
      );
    crops.get(k)!.then((u) => live && setUrl(u)).catch(() => {
      crops.delete(k);
      if (live) setUrl('error');
    });
    return () => {
      live = false;
    };
  }, [k]);
  if (url === 'error') return <p class="muted small">This snip's PDF is missing on this device.</p>;
  return <div class="paper qimage snip-img">{url ? <img src={url} alt={label} /> : <span class="small">Loading question…</span>}</div>;
}

/** Bare papers: the PDF beside the answer buttons, with page controls. */
export function PdfPane({ pdfId, page, onPage }: { pdfId: string; page: number; onPage: (p: number) => void }) {
  const doc = usePdf(pdfId);
  if (doc === 'error') return <p class="muted">The PDF for this paper is missing on this device.</p>;
  if (!doc) return <div class="skel" style={{ height: '50vh' }} aria-busy="true" />;
  const n = doc.numPages;
  const p = Math.min(Math.max(1, page), n);
  return (
    <div class="stack-s pdf-pane">
      <div class="row">
        <Button size="sm" onClick={() => onPage(p - 1)} disabled={p <= 1} aria-label="Previous page"><Icon name="left" size={16} /></Button>
        <span class="small num">Page {p} of {n}</span>
        <Button size="sm" onClick={() => onPage(p + 1)} disabled={p >= n} aria-label="Next page"><Icon name="right" size={16} /></Button>
      </div>
      <PdfPage doc={doc} page={p} />
    </div>
  );
}

/**
 * Snip questions: drag a rectangle on a page, then save it as a question number. Coordinates are
 * stored as fractions of the page and the crop is rendered at runtime, so nothing is duplicated.
 * Keyboard users can snip the whole page or either half.
 */
export function SnipEditor({ packId, paperId, onClose }: { packId: string; paperId: string; onClose: () => void }) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [snips, setSnips] = useState<Snip[]>([]);
  const [page, setPage] = useState(1);
  const [rect, setRect] = useState<Rect | null>(null);
  const [qn, setQn] = useState(1);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const doc = usePdf(paper?.pdf?.qp);

  const load = async () => {
    const p = await store.getPaper(`${packId}::${paperId}`);
    const all = (await store.getSnips(packId)).filter((s) => s.qid.startsWith(`${paperId}#`));
    setPaper(p ?? null);
    setSnips(all);
    if (p) {
      const done = new Set(all.map((s) => Number(s.qid.split('#')[1])));
      let next = 1;
      while (done.has(next) && next < p.questionCount) next++;
      setQn(next);
    }
  };
  useEffect(() => void load(), [packId, paperId]);

  const at = (e: PointerEvent) => {
    const r = overlay.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = at(e);
    setRect(null);
  };
  const move = (e: PointerEvent) => {
    if (!drag.current) return;
    const p = at(e);
    const s = drag.current;
    setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const up = () => {
    drag.current = null;
    setRect((r) => (r && r.w > 0.02 && r.h > 0.01 ? r : null));
  };

  const save = async () => {
    if (!paper?.pdf?.qp || !rect) return;
    const qid = `${paperId}#${qn}`;
    await store.putSnip({ key: `${packId}::${qid}`, packId, qid, pdfId: paper.pdf.qp, page, ...rect, updatedAt: Date.now() });
    bump();
    setRect(null);
    toast(`Saved question ${qn}.`);
    await load();
  };
  const remove = async (s: Snip) => {
    await store.deleteSnip(s.key);
    bump();
    await load();
  };

  if (!paper) return null;
  const onPage = snips.filter((s) => s.page === page);
  const n = doc && doc !== 'error' ? doc.numPages : 1;
  return (
    <Modal title={`Snip questions · ${paper.title}`} size="full" onClose={onClose}>
      {!paper.pdf?.qp ? (
        <p class="muted">This paper has no question paper PDF on this device.</p>
      ) : doc === 'error' ? (
        <p class="muted">The PDF could not be opened.</p>
      ) : !doc ? (
        <div class="skel" style={{ height: '60vh' }} aria-busy="true" />
      ) : (
        <div class="snip-layout">
          <div class="stack-s">
            <div class="row">
              <Button size="sm" onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} aria-label="Previous page"><Icon name="left" size={16} /></Button>
              <span class="small num">Page {page} of {n}</span>
              <Button size="sm" onClick={() => setPage(Math.min(n, page + 1))} disabled={page >= n} aria-label="Next page"><Icon name="right" size={16} /></Button>
              <span class="small muted">Drag around one question.</span>
            </div>
            <div class="snip-stage">
              <PdfPage doc={doc} page={page} />
              <div ref={overlay} class="snip-overlay" onPointerDown={down} onPointerMove={move} onPointerUp={up} aria-hidden="true">
                {onPage.map((s) => (
                  <div class="snip-box snip-box--saved" key={s.key} style={box(s)}><span class="num">{s.qid.split('#')[1]}</span></div>
                ))}
                {rect && <div class="snip-box" style={box(rect)} />}
              </div>
            </div>
          </div>
          <div class="stack sticky-col">
            <label class="jy-field">
              <span>Question number</span>
              <input class="input num" inputMode="numeric" value={String(qn)} onInput={(e) => setQn(Math.min(paper.questionCount, Math.max(1, Number((e.target as HTMLInputElement).value) || 1)))} />
            </label>
            <div class="row">
              <Button size="sm" onClick={() => setRect({ x: 0, y: 0, w: 1, h: 1 })}>Whole page</Button>
              <Button size="sm" onClick={() => setRect({ x: 0, y: 0, w: 1, h: 0.5 })}>Top half</Button>
              <Button size="sm" onClick={() => setRect({ x: 0, y: 0.5, w: 1, h: 0.5 })}>Bottom half</Button>
            </div>
            <Button variant="primary" onClick={() => void save()} disabled={!rect}>Save as question {qn}</Button>
            <p class="small muted"><span class="num">{snips.length}</span> of <span class="num">{paper.questionCount}</span> snipped. A fully snipped paper joins Random; snipped questions appear in drills and Daily 10.</p>
            <ul class="snip-list small">
              {snips
                .slice()
                .sort((a, b) => Number(a.qid.split('#')[1]) - Number(b.qid.split('#')[1]))
                .map((s) => (
                  <li key={s.key}>
                    <button type="button" class="jy-btn jy-btn--ghost jy-btn--sm" onClick={() => setPage(s.page)}>Q{s.qid.split('#')[1]} · page {s.page}</button>
                    <Button variant="ghost" size="sm" icon aria-label={`Remove snip for question ${s.qid.split('#')[1]}`} onClick={() => void remove(s)}><Icon name="trash" size={16} /></Button>
                  </li>
                ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

const box = (r: Rect) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
