import { AI_PROTOCOL_VERSION, validateAiBatch } from '../../shared/ai-protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { authStore, backend } from '../lib/backend';
import { useStore } from '../lib/app-state';
import { db } from '../lib/data/db';
import { sha256Hex, type ImportSource } from '../lib/data/files';
import { openPdf } from '../lib/pdf/pdf';
import { extractBatch, makePack, preparePage, selectedPages, type AiBatch, type AiConfig } from '../lib/ai/import';
import { Badge, Button, Field, Modal } from '../ui/kit';

interface ChosenPdf { file: File; doc: PDFDocumentProxy; hash: string }
interface Recovery { batches: Record<string, AiBatch> }

/** AI drafts enter the same editable, validated review and conflict pipeline as manual packs. */
export function AiImport({ onBack, onReady }: { onBack: () => void; onReady: (source: ImportSource) => void }) {
  const auth = useStore(authStore);
  const account = auth.account?.id;
  const [qp, setQp] = useState<ChosenPdf | null>(null);
  const [ms, setMs] = useState<ChosenPdf | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  useEffect(() => {
    if (!qp) return;
    const url = URL.createObjectURL(qp.file); setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [qp]);
  const [pages, setPages] = useState('');
  const [msPages, setMsPages] = useState('');
  const [title, setTitle] = useState('');
  const [images, setImages] = useState(true);
  const [consent, setConsent] = useState(false);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof makePack>> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const documents = useRef(new Set<PDFDocumentProxy>());
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; controller.current?.abort(); for (const doc of documents.current) void doc.loadingTask.destroy(); };
  }, []);
  useEffect(() => {
    controller.current?.abort();
    setConfig(null); setDraft(null);
    if (!account || !backend) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const token = await backend.accessToken();
        if (!token) throw new Error('Sign in again before using AI import.');
        const response = await fetch('/api/ai/config', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: abort.signal });
        if (!response.ok) throw new Error('AI import is unavailable on this deployment. Use manual import, or check the Worker configuration.');
        const result = await response.json() as AiConfig;
        if (!result.configured) throw new Error('AI import needs a model and NVIDIA Worker secret. Manual PDF import remains available.');
        if (!result.model || result.maxPagesPerBatch < 1 || result.maxPagesPerBatch > 20 || !result.maxPayloadBytes || !result.maxTextChars || !result.maxImageBytes) throw new Error('AI import returned invalid deployment limits. Check the Worker configuration.');
        if (!abort.signal.aborted) { setConfig(result); setError(''); }
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    })();
    return () => abort.abort();
  }, [account]);

  const choose = async (file: File | undefined, role: 'question' | 'markscheme') => {
    if (!file) return;
    setLoading(true); setError(''); setDraft(null); setConsent(false);
    try {
      const doc = await openPdf(file);
      documents.current.add(doc);
      const chosen = { file, doc, hash: await sha256Hex(await file.arrayBuffer()) };
      if (!live.current) { void doc.loadingTask.destroy(); return; }
      if (role === 'question') { setQp(chosen); setPages(`1-${Math.min(20, doc.numPages)}`); setTitle(file.name.replace(/\.pdf$/i,'')); }
      else { setMs(chosen); setMsPages(`1-${Math.min(3,doc.numPages)}`); }
    } catch (e) { setError((e as Error).message); }
    finally { if (live.current) setLoading(false); }
  };

  const run = async () => {
    if (!qp || !config || !backend || !account || !consent || busy) return;
    const capturedAccount = account;
    const abort = new AbortController(); controller.current = abort;
    const check = () => { abort.signal.throwIfAborted(); if (authStore.get().account?.id !== capturedAccount || !live.current) throw new DOMException('Cancelled', 'AbortError'); };
    setBusy(true); setError(''); setDraft(null);
    try {
      const questionPages = selectedPages(pages,qp.doc.numPages,20);
      const schemePages = ms ? selectedPages(msPages,ms.doc.numPages,Math.min(3,config.maxPagesPerBatch-1)) : [];
      const token = await backend.accessToken(); check();
      if (!token) throw new Error('Sign in again before using AI import.');
      const workspace = await db(); check();
      const recoveryKey = `ai-import:v${AI_PROTOCOL_VERSION}:${config.model}:${qp.hash}:${ms?.hash ?? ''}:${questionPages.join(',')}:${schemePages.join(',')}:${images}`;
      const saved = await workspace.get('meta',recoveryKey) as Recovery | undefined;
      const recovery: Recovery = saved?.batches && typeof saved.batches === 'object' ? saved : {batches:{}};
      const scheme = [];
      for (const page of schemePages) { setStatus(`Preparing mark scheme page ${page}…`); scheme.push(await preparePage(ms!.doc,page,'markscheme',images,config)); check(); }
      for (let i=0;i<questionPages.length;i++) {
        const page = questionPages[i]!;
        if (recovery.batches[page]) {
          try { recovery.batches[page] = validateAiBatch(recovery.batches[page], [page], !!scheme.length); }
          catch { delete recovery.batches[page]; }
        }
        if (recovery.batches[page]) { setStatus(`Recovered page ${page} · ${i+1} of ${questionPages.length}`); continue; }
        setStatus(`Processing page ${page} · ${i+1} of ${questionPages.length}`);
        const prepared = await preparePage(qp.doc,page,'question',images,config); check();
        const batch = [prepared,...scheme];
        if (new TextEncoder().encode(JSON.stringify({pages:batch,hasMarkScheme:!!ms})).length > config.maxPayloadBytes) throw new Error(`Page ${page} and the selected mark scheme exceed the request limit. Select fewer mark-scheme pages or turn off page images for text PDFs.`);
        const result = await extractBatch(batch,!!ms,token,abort.signal); check();
        recovery.batches[page] = result;
        await workspace.put('meta',recovery,recoveryKey); check();
      }
      setStatus('Preparing source crops and review…');
      const result = await makePack(questionPages.map(p=>recovery.batches[p]!),qp.doc,title.trim() || 'Imported paper',!!ms); check();
      setDraft(result); setStatus('Completed pages saved locally. Review before importing.');
    } catch (e) {
      if (live.current && authStore.get().account?.id === capturedAccount) {
        if ((e as Error).name === 'AbortError') setStatus('Cancelled. Completed pages remain on this device; start again to resume.');
        else setError((e as Error).message || 'AI import failed. Retry to resume completed pages.');
      }
    } finally { if (live.current) setBusy(false); }
  };
  const finish = () => {
    if (!draft || !qp) return;
    const pdfs = new Map<string,Blob>([['pdfs/question.pdf',qp.file]]);
    if (ms) pdfs.set('pdfs/markscheme.pdf',ms.file);
    onReady({name:qp.file.name,text:draft.text,files:draft.files,pdfs,skipped:[]});
  };

  return <Modal title="Import PDF with AI" size="wide" onClose={() => { controller.current?.abort(); onBack(); }}>
    <div class="stack">
      <p class="muted">Extract a draft from selected PDF pages, then check it against the original. Your PDFs stay on this device. Selected page text and images are sent to NVIDIA only when you start.</p>
      {!account && <div class="notice notice--warn" role="status">Sign in with email to use AI import. You can import PDFs manually without an account.</div>}
      {error && <div class="notice notice--bad" role="alert">{error}</div>}
      <div class="grid-even">
        <Field label="Question paper PDF"><input class="input" type="file" accept=".pdf,application/pdf" disabled={busy || loading} onChange={e=>void choose(e.currentTarget.files?.[0],'question')} /></Field>
        <Field label="Mark scheme PDF (optional)"><input class="input" type="file" accept=".pdf,application/pdf" disabled={busy || loading} onChange={e=>void choose(e.currentTarget.files?.[0],'markscheme')} /></Field>
      </div>
      {loading && <p role="status">Opening PDF…</p>}
      {qp && <>
        <Field label="Paper title"><input class="input" value={title} disabled={busy} onInput={e=>setTitle(e.currentTarget.value)} /></Field>
        <div class="grid-even">
          <Field label={`Question pages (1–${qp.doc.numPages}, at most 20)`}><input class="input" value={pages} disabled={busy} placeholder="2-6, 8" onInput={e=>{setPages(e.currentTarget.value);setConsent(false);setDraft(null);}} /></Field>
          {ms && <Field label={`Relevant mark-scheme pages (1–${ms.doc.numPages}, at most ${Math.min(3,(config?.maxPagesPerBatch??4)-1)})`}><input class="input" value={msPages} disabled={busy} onInput={e=>{setMsPages(e.currentTarget.value);setConsent(false);setDraft(null);}} /></Field>}
        </div>
        {ms && <div class="row"><p class="small muted" style={{flex:1}}>Each question page is matched only against these mark-scheme pages. Choose the relevant answer table; mismatches remain unkeyed.</p><Button disabled={busy} onClick={()=>{setMs(null);setConsent(false);setDraft(null);}}>Remove mark scheme</Button></div>}
        <label class="row small"><input type="checkbox" checked={images} disabled={busy} onChange={e=>{setImages(e.currentTarget.checked);setConsent(false);setDraft(null);}} /> Include page images for diagrams and tables. Scanned pages always include an image.</label>
        <div class="notice notice--warn small"><div class="stack-s"><b>Check before sending</b><span>Question pages: {pages || 'none'}{ms ? `; mark scheme: ${msPages || 'none'}` : '; no mark scheme: all answers stay unkeyed'}. {config ? `Model: ${config.model}.` : ''} One question page is processed at a time. No full PDF is uploaded.</span><label class="row"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.currentTarget.checked)} /> I agree to send the selected page content to NVIDIA.</label></div></div>
      </>}
      {(status || busy) && <p class="small muted" role="status" aria-live="polite">{status}</p>}
      {draft && <div class="stack-s">
        <h3>Import quality</h3>
        {sourceUrl && <a class="jy-btn" href={`${sourceUrl}#page=${Number(pages.match(/\d+/)?.[0] ?? 1)}`} target="_blank" rel="noopener noreferrer">Open original question paper</a>}
        <div class="row"><Badge status="neutral">{draft.summary.extracted} extracted</Badge><Badge status="warn">{draft.summary.unkeyed} unkeyed</Badge><Badge status="warn">{draft.summary.missingFigures} missing figures</Badge><Badge status="warn">{draft.summary.needsReview} need review</Badge></div>
        <p class="small muted">Every AI question needs review. Open its source page from practice after import. Edit flagged content below; the next screen validates the pack and detects conflicts.</p>
        {draft.warnings.length>0 && <ul class="small">{draft.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}
        <Field label="Editable extraction"><textarea class="textarea" spellcheck={false} value={draft.text} onInput={e=>setDraft({...draft,text:e.currentTarget.value})} /></Field>
      </div>}
      <div class="modal-foot">
        <Button disabled={busy} onClick={onBack}>Manual import</Button><span class="spacer" />
        {busy ? <Button onClick={()=>controller.current?.abort()}>Cancel extraction</Button> : draft ? <Button variant="primary" onClick={finish}>Validate and review import</Button> : <Button variant="primary" disabled={!qp || !config || !account || !consent || loading} onClick={()=>void run()}>Start extraction / resume</Button>}
      </div>
    </div>
  </Modal>;
}
