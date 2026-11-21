import { fingerprintOf } from '../../../shared/fingerprint';

/** What DMC reads from a question paper to identify it: cover text and a text fingerprint. */
export interface PaperText { cover: string; fingerprint: string | null }

/** Reads the first four pages of each PDF (lazily loads pdf.js). Missing on failure or in tests. */
export async function readPaperTexts(pdfs: ReadonlyMap<string, Blob>): Promise<Map<string, PaperText>> {
  const out = new Map<string, PaperText>();
  if (typeof document === 'undefined' || !pdfs.size) return out;
  try {
    const { openPdf, pdfText } = await import('./pdf');
    for (const [path, blob] of pdfs) {
      try {
        const doc = await openPdf(blob);
        const pages = await pdfText(doc, 4);
        out.set(path, { cover: pages[0] ?? '', fingerprint: fingerprintOf(pages.join('\n')) });
        await doc.cleanup?.();
      } catch { /* this file is matched by its bytes only */ }
    }
  } catch { /* pdf.js unavailable */ }
  return out;
}
