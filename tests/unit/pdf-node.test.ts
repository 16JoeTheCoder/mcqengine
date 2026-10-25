import { describe, expect, it } from 'vitest';
import { markSchemePdf, questionPaperPdf } from '../fixtures/pdf';
import { parseMarkScheme } from '../../src/lib/format/markscheme';

// pdf.js legacy build runs in Node without a worker; used only to prove the synthetic fixtures and
// the mark scheme reader work on real extracted text.
async function text(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false, useSystemFonts: false, verbosity: 0 } as never).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    out += tc.items.map((i) => ('str' in i ? `${i.str}${i.hasEOL ? '\n' : ' '}` : '')).join('') + '\n';
  }
  return out;
}

describe('synthetic PDFs through pdf.js', () => {
  it('a mark scheme PDF yields the key', async () => {
    const key = 'BDACCABDDCABCDABCDABCDABCDABCDABCDABCDAB';
    const r = parseMarkScheme(await text(markSchemePdf(key)), 40);
    expect(r.found).toBe(40);
    expect(r.key.map((k) => 'ABCD'[k!]).join('')).toBe(key);
  }, 30_000);
  it('a question paper PDF has the question text', async () => {
    expect(await text(questionPaperPdf(12))).toMatch(/Synthetic question 12: a body of mass 12\.0 kg/);
  }, 30_000);
});
