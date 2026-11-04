import type { PDFDocumentProxy } from 'pdfjs-dist';
import { cropPage } from '../pdf/pdf';

import { validateAiBatch, type AiPage, type AiBatch, type AiConfig } from '../../../shared/ai-protocol';
export type { AiPage, AiQuestion, AiBatch, AiConfig } from '../../../shared/ai-protocol';

/** Explicit page selection prevents accidentally sending a whole paper. */
export function selectedPages(value: string, total: number, limit: number): number[] {
  const out = new Set<number>();
  if (!value.trim()) throw new Error('Enter the pages to process, for example 2-5, 8.');
  for (const part of value.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) throw new Error('Use page numbers or ranges separated by commas.');
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (a < 1 || b < a || b > total || b - a >= limit) throw new Error(`Choose at most ${limit} pages between 1 and ${total}.`);
    for (let n = a; n <= b; n++) out.add(n);
    if (out.size > limit) throw new Error(`Choose at most ${limit} pages for this import.`);
  }
  return [...out].sort((a, b) => a - b);
}

/** A second trust boundary before model output enters the established pack validator. */
export function checkBatch(raw: unknown, pages: number[], keyed: boolean): AiBatch {
  return validateAiBatch(raw, pages, keyed);
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Only transient failures retry. No provider key or endpoint is accepted from the browser. */
export async function extractBatch(pages: AiPage[], hasMarkScheme: boolean, token: string, signal: AbortSignal, request = fetch): Promise<AiBatch> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await request('/api/ai/extract', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pages, hasMarkScheme }), signal, cache: 'no-store' });
    } catch (error) {
      if (signal.aborted || attempt === 2) throw error;
      await abortableDelay(1000 * 2 ** attempt, signal);
      continue;
    }
    signal.throwIfAborted();
    if (response.ok) return checkBatch(await response.json(), pages.filter(p => p.role === 'question').map(p => p.page), hasMarkScheme);
    let message = `AI request failed (${response.status}). Your completed pages are saved locally.`;
    try { const data = await response.json() as { error?: string }; if (typeof data.error === 'string') message = data.error.slice(0, 500); } catch { /* Use a safe status message. */ }
    const retry = response.headers.get('Retry-After');
    const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 1000 * 2 ** attempt;
    if (attempt === 2 || ![408,429,500,502,503,504].includes(response.status) || retryMs > 60_000) throw new Error(message);
    await abortableDelay(Number.isFinite(retryMs) ? retryMs : 1000 * 2 ** attempt, signal);
  }
  throw new Error('The AI request failed. Retry the failed page.');
}

export async function preparePage(doc: PDFDocumentProxy, pageNo: number, role: AiPage['role'], images: boolean, config: AiConfig): Promise<AiPage> {
  const page = await doc.getPage(pageNo);
  const content = await page.getTextContent();
  const text = content.items.map(it => 'str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '').join('');
  if (text.length > config.maxTextChars) throw new Error(`Page ${pageNo} exceeds the text limit. Use manual import for this page.`);
  let image: string | undefined;
  if (images || text.trim().length < 80) {
    // This canvas only renders bounded PDF source images; it is never a drawing surface.
    const viewport = page.getViewport({ scale: 1 });
    const rendered = page.getViewport({ scale: Math.min(1.5, 1000 / Math.max(viewport.width, viewport.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(rendered.width); canvas.height = Math.ceil(rendered.height);
    await page.render({ canvas, viewport: rendered }).promise;
    image = canvas.toDataURL('image/jpeg', 0.8);
    if (image.length * 0.75 > config.maxImageBytes) throw new Error(`Page ${pageNo} exceeds the image limit. Use manual import for this page.`);
    canvas.width = canvas.height = 0;
  }
  return { page: pageNo, role, text, ...(image ? { image } : {}) };
}

export async function makePack(batches: AiBatch[], doc: PDFDocumentProxy, title: string, keyed: boolean): Promise<{ text: string; files: Map<string, Blob>; summary: { extracted: number; unkeyed: number; missingFigures: number; needsReview: number }; warnings: string[] }> {
  const all = batches.flatMap(b => b.questions).sort((a,b) => a.n - b.n || a.page - b.page);
  const duplicate = all.filter((q,i) => all.some((other,j) => j !== i && q.n === other.n));
  const warnings = batches.flatMap(b => b.warnings);
  if (duplicate.length) warnings.push(`Duplicate question numbers: ${[...new Set(duplicate.map(q => q.n))].join(', ')}. Merge continuation content and remove duplicates before review.`);
  const missing = all.length ? Array.from({length: all[all.length-1]!.n},(_,i)=>i+1).filter(n => !all.some(q => q.n === n)) : [];
  if (missing.length) warnings.push(`Question numbers not extracted: ${missing.join(', ')}. Check that the selected pages cover the intended paper.`);
  const files = new Map<string, Blob>();
  const questions = [];
  for (const q of all) {
    let figure: { file: string } | { needed: true; note: string } | undefined;
    if (q.crop) {
      const path = `images/q${q.n}-page${q.page}.png`;
      files.set(path, await cropPage(doc, q.page, q.crop, 700));
      figure = { file: path };
    } else if (q.figureNeeded) figure = { needed: true, note: 'Source figure needs checking. Open the original PDF page.' };
    questions.push({ n:q.n, page:q.page, stem:q.stem, options:q.options, answer:keyed ? q.answer : null, ...(figure ? {figure} : {}), ...(q.table ? {table:q.table} : {}), ...(q.explanation ? {explanation:q.explanation} : {}), uncertain: [q.uncertain, 'AI extraction: compare with the original page before confirming.'].filter(Boolean).join(' ') });
  }
  const optionCount = questions[0]?.options.length ?? 4;
  const text = JSON.stringify({format:'dmc-pack/1',pack:{title},papers:[{id:'ai-paper', title, questionCount:Math.max(1,...questions.map(q=>q.n)),optionCount,timeLimitMinutes:60,pdf:{questionPaper:'pdfs/question.pdf',...(keyed ? {markScheme:'pdfs/markscheme.pdf'} : {})},questions}]},null,2);
  return {text,files,summary:{extracted:questions.length,unkeyed:questions.filter(q=>q.answer===null).length,missingFigures:questions.filter(q=>'needed' in (q.figure??{})).length,needsReview:questions.length},warnings};
}
