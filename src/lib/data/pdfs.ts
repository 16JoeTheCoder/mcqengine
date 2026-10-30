import { MAX_PDF_BYTES } from '../pdf/pdf';
import type { Paper } from '../types';
import * as store from './db';
import { sha256Hex } from './files';

export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** Stores a PDF once by content hash. Checks the PDF signature, not just the file name. */
export async function storePdf(file: Blob, name: string): Promise<string> {
  if (file.size > MAX_PDF_BYTES) throw new Error(`${name} is larger than 60 MB`);
  const buf = await file.arrayBuffer();
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
  if (!head.includes('%PDF-')) throw new Error(`${name} is not a PDF`);
  const id = await sha256Hex(buf);
  if (!(await store.getPdf(id))) await store.putPdf({ id, name: name.slice(0, 200), size: file.size, blob: new Blob([buf], { type: 'application/pdf' }), addedAt: Date.now() });
  return id;
}

/** Links a stored PDF to a paper as its question paper or mark scheme. */
export async function attachPdf(packId: string, paperId: string, role: 'qp' | 'ms', pdfId: string) {
  await store.write(async () => {
    const tx = (await store.db()).transaction(['packs', 'papers'], 'readwrite');
    const paper = (await tx.objectStore('papers').get(`${packId}::${paperId}`)) as Paper | undefined;
    const pack = await tx.objectStore('packs').get(packId);
    if (!paper || !pack) throw new Error('Paper not found');
    const pdf = { ...paper.pdf, [role]: pdfId };
    await tx.objectStore('papers').put({ ...paper, pdf });
    await tx.objectStore('packs').put({ ...pack, papers: pack.papers.map((m) => (m.id === paperId ? { ...m, pdf } : m)), updatedAt: Date.now() });
    await tx.done;
  });
}
