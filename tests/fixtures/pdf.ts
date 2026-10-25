// Synthetic PDFs for tests: plain Helvetica text pages, hand-written so no dependency is needed.
// Never real exam content.
export function makePdf(pages: string[][]): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s) - 1 + 1;
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + 1 + pages.length * 2;
  const kids: number[] = [];
  for (const lines of pages) {
    const body = lines.map((l, i) => `BT /F1 12 Tf 56 ${780 - i * 18} Td (${l.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A synthetic question paper: one question per line, several per page. */
export function questionPaperPdf(count: number, perPage = 10): Uint8Array {
  const pages: string[][] = [];
  for (let n = 1; n <= count; n += perPage)
    pages.push(Array.from({ length: Math.min(perPage, count - n + 1) }, (_, i) => `${n + i}  Synthetic question ${n + i}: a body of mass ${n + i}.0 kg moves at ${n + i} m/s.`));
  return makePdf(pages);
}

/** A synthetic mark scheme in the Cambridge layout: "question answer marks" rows. */
export function markSchemePdf(key: string): Uint8Array {
  const rows = [...key].map((l, i) => `${i + 1}   ${l}   1`);
  return makePdf([['Synthetic Mark Scheme  Page 2 of 2', 'Question  Answer  Marks', ...rows]]);
}
