import { useEffect, useState } from 'preact/hooks';
import { bareImport, defaultMinutes } from '../lib/data/bare';
import { commitImport, parseImport, planImport } from '../lib/data/importer';
import { pairFiles } from '../lib/format/filename';
import { parseMarkScheme } from '../lib/format/markscheme';
import { slugify } from '../lib/format/validate';
import { openPdf, pdfText } from '../lib/pdf/pdf';
import { bump, href, navigate, toast } from '../lib/app-state';
import { broadcastChange } from '../lib/tablock';
import type { Pack } from '../lib/types';
import { Badge, Button, Field, Modal } from '../ui/kit';
import { KeyGrid, keyFromText } from './paper-dialog';

interface Row {
  qp: File;
  ms?: File;
  id: string;
  title: string;
  group: string[];
  count: number;
  minutes: number;
  /** Read from the mark scheme; a suggestion until the student confirms it. */
  suggested?: (number | null)[];
  key?: (number | null)[];
}

async function readKey(ms: File): Promise<(number | null)[] | undefined> {
  try {
    const doc = await openPdf(ms);
    const text = (await pdfText(doc)).join('\n');
    void doc.loadingTask.destroy();
    const wide = parseMarkScheme(text, 120);
    let last = 0;
    wide.key.forEach((k, i) => k !== null && (last = i + 1));
    if (!last) return undefined;
    return wide.key.slice(0, last);
  } catch {
    return undefined;
  }
}

/**
 * The lighter path: question paper PDFs plus a key. Questions are practised from the PDF and can be
 * snipped later. Everything detectable comes from the file names and the mark scheme text.
 */
export function PdfImport({ files, pack, onClose }: { files: File[]; pack?: Pack; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [packTitle, setPackTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const { papers } = pairFiles(files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf'));
      const out: Row[] = [];
      for (const p of papers) {
        const suggested = p.ms ? await readKey(p.ms) : undefined;
        const count = suggested?.length ?? 40;
        out.push({
          qp: p.qp,
          ...(p.ms ? { ms: p.ms } : {}),
          id: p.parsed.id ?? slugify(p.parsed.title) ?? 'paper',
          title: p.parsed.title,
          group: p.parsed.group,
          count,
          minutes: defaultMinutes(p.parsed.code, p.parsed.paper, count),
          ...(suggested ? { suggested } : {}),
        });
      }
      const first = papers[0]?.parsed;
      setPackTitle(first?.subject && first.code ? `${first.subject} ${first.code}` : 'PDF papers');
      setSubject(first?.subject ?? '');
      setRows(out);
    })();
  }, [files]);

  const set = (i: number, patch: Partial<Row>) => setRows(rows!.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const commit = async () => {
    if (!rows?.length) return;
    setBusy(true);
    try {
      const { text, source } = bareImport(
        rows.map((r) => ({ id: r.id, title: r.title, group: r.group, questionCount: r.count, timeLimitMin: r.minutes, optionCount: 4, qp: r.qp, ...(r.ms ? { ms: r.ms } : {}), ...(r.key ? { key: r.key } : {}) })),
        pack ? undefined : { title: packTitle, subject },
      );
      const parsed = parseImport(text, new Set(source.pdfs.keys()));
      if (!parsed.ok) throw new Error(parsed.syntax);
      if (parsed.result.errors.length) throw new Error(parsed.result.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
      const target = { packId: pack?.id ?? null, newPack: { title: packTitle, subject } };
      const { merge, images } = await planImport(parsed.result.doc, target, source, {});
      if (merge.conflicts.length) throw new Error(merge.conflicts[0]!.message);
      const id = await commitImport(target, merge, images);
      bump();
      broadcastChange();
      toast(`Added ${rows.length} PDF paper${rows.length === 1 ? '' : 's'}. Snip questions any time to use them in drills and Daily 10.`);
      onClose();
      navigate(href.pack(id, 'papers'));
    } catch (e) {
      toast((e as Error).message || 'Could not add the PDFs.');
      setBusy(false);
    }
  };

  const edit = editing !== null ? rows?.[editing] : undefined;
  return (
    <Modal title="Add PDF papers" size="wide" onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void commit()} disabled={busy || !rows?.length}>Add {rows?.length ?? ''} paper{rows?.length === 1 ? '' : 's'}</Button>
      </>
    }>
      <div class="stack">
        <p class="small muted">Practise straight from the PDF and answer with letter buttons. Typed packs made with AI are the best-supported path; this is the quick one. Mark schemes named like the paper (9702_s23_ms_12 for 9702_s23_qp_12) are read for the key, which you confirm.</p>
        {!rows ? (
          <div class="skel" style={{ height: '160px' }} aria-busy="true" />
        ) : !rows.length ? (
          <p>No question paper PDFs found.</p>
        ) : (
          <>
            {!pack && (
              <div class="grid-even">
                <Field label="Pack name"><input class="input" value={packTitle} onInput={(e) => setPackTitle((e.target as HTMLInputElement).value)} /></Field>
                <Field label="Subject"><input class="input" value={subject} onInput={(e) => setSubject((e.target as HTMLInputElement).value)} /></Field>
              </div>
            )}
            <div class="table-wrap">
              <table class="jy-table review-table">
                <thead><tr><th>Paper</th><th class="n">Questions</th><th class="n">Minutes</th><th>Key</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.qp.name}>
                      <td data-label="Paper"><input class="input" aria-label={`Title of ${r.qp.name}`} value={r.title} onInput={(e) => set(i, { title: (e.target as HTMLInputElement).value })} /><span class="small subtle">{r.qp.name}{r.ms ? ` + ${r.ms.name}` : ''}</span></td>
                      <td data-label="Questions" class="n"><input class="input num" style={{ width: '80px' }} inputMode="numeric" aria-label="Questions" value={String(r.count)} onChange={(e) => set(i, { count: Math.min(200, Math.max(1, Number((e.target as HTMLInputElement).value) || 40)), key: undefined })} /></td>
                      <td data-label="Minutes" class="n"><input class="input num" style={{ width: '80px' }} inputMode="numeric" aria-label="Minutes" value={String(r.minutes)} onChange={(e) => set(i, { minutes: Math.min(600, Math.max(1, Number((e.target as HTMLInputElement).value) || 60)) })} /></td>
                      <td data-label="Key">
                        <div class="row">
                          {r.key ? <Badge status="ok">Key confirmed</Badge> : r.suggested ? <Badge status="warn">Read, not confirmed</Badge> : <Badge status="neutral">No key: Exam only</Badge>}
                          <Button size="sm" onClick={() => setEditing(i)}>{r.key ? 'Edit' : r.suggested ? 'Check key' : 'Add key'}</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {edit && editing !== null && <KeyConfirm row={edit} onClose={() => setEditing(null)} onSave={(key) => { set(editing, { key }); setEditing(null); }} />}
    </Modal>
  );
}

function KeyConfirm({ row, onClose, onSave }: { row: Row; onClose: () => void; onSave: (k: (number | null)[]) => void }) {
  const fit = (k?: (number | null)[]) => Array.from({ length: row.count }, (_, i) => k?.[i] ?? null);
  const [key, setKey] = useState(fit(row.key ?? row.suggested));
  const [text, setText] = useState('');
  return (
    <Modal title={`Key for ${row.title}`} size="wide" onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(key)} disabled={!key.some((k) => k !== null)}>Confirm key</Button>
      </>
    }>
      <div class="stack">
        {row.suggested && !row.key && <p class="small">Read from {row.ms?.name}. Check every row against the mark scheme before confirming.</p>}
        <div class="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}>
            <Field label="Type or paste the key"><input class="input num" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} /></Field>
          </div>
          <Button onClick={() => { const k = keyFromText(text, row.id, row.count); if (k && k.length === row.count) setKey(k); else toast(`The key needs ${row.count} letters.`); }} disabled={!text.trim()}>Fill grid</Button>
        </div>
        <KeyGrid optionCount={4} value={key} onChange={setKey} />
      </div>
    </Modal>
  );
}
