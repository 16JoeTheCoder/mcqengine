import { useEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import * as store from '../lib/data/db';
import { attachPdf, isPdf, storePdf } from '../lib/data/pdfs';
import { parseMarkScheme } from '../lib/format/markscheme';
import { openPdf, pdfText, renderPage } from '../lib/pdf/pdf';
import { bump, toast } from '../lib/app-state';
import type { Paper } from '../lib/types';
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
