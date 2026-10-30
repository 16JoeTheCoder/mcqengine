import type { PDFDocumentProxy } from 'pdfjs-dist';

/** pdf.js, loaded on first use only (it is large), with its worker bundled as a local file. */
let lib: Promise<typeof import('pdfjs-dist')> | null = null;
function pdfjs() {
  lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([m, w]) => {
    m.GlobalWorkerOptions.workerSrc = w.default;
    return m;
  });
  return lib;
}

export const MAX_PDF_BYTES = 60_000_000;

/** Opens a PDF. Scripts, eval and remote resources stay off: PDFs are untrusted input. */
export async function openPdf(data: Blob | ArrayBuffer): Promise<PDFDocumentProxy> {
  const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data.slice(0));
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('PDF is larger than 60 MB');
  const m = await pdfjs();
  return m.getDocument({ data: bytes, useWasm: false, enableXfa: false, useSystemFonts: true, stopAtErrors: false }).promise;
}

/** Plain text of every page, items separated by spaces, lines by newlines. */
export async function pdfText(doc: PDFDocumentProxy, maxPages = 60): Promise<string[]> {
  const out: string[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out.push(tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join(''));
  }
  return out;
}

/** Renders a page to a canvas at a width in CSS pixels (sharp on high-DPI screens). */
export async function renderPage(doc: PDFDocumentProxy, pageNo: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<{ width: number; height: number }> {
  const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
  canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
  await page.render({ canvas, viewport: vp }).promise;
  return { width: vp.width / dpr, height: vp.height / dpr };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Renders a normalised rectangle (0-1 of the page) of a page to a PNG blob. */
export async function cropPage(doc: PDFDocumentProxy, pageNo: number, r: Rect, cssWidth = 900): Promise<Blob> {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / (base.width * Math.max(0.05, r.w));
  const vp = page.getViewport({ scale: Math.min(scale, 4) });
  const full = document.createElement('canvas');
  full.width = Math.floor(vp.width);
  full.height = Math.floor(vp.height);
  await page.render({ canvas: full, viewport: vp }).promise;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.w * full.width));
  out.height = Math.max(1, Math.round(r.h * full.height));
  out.getContext('2d')!.drawImage(full, r.x * full.width, r.y * full.height, out.width, out.height, 0, 0, out.width, out.height);
  return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Could not crop'))), 'image/png'));
}
