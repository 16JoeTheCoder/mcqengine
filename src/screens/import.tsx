import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { readFiles, type ImportSource } from '../lib/data/files';
import { PdfImport } from './pdf-import';
import { crossCheck, type CrossCheckIssue } from '../lib/format/crosscheck';
import { commitImport, parseImport, planImport, type ParseOutcome } from '../lib/data/importer';
import { readProgressJson } from '../lib/data/backup';
import { buildFixPrompt } from '../lib/format/prompt';
import { toQuestion, type MergeResult, type PaperOverrides } from '../lib/format/merge';
import type { NDoc } from '../lib/format/validate';
import { bump, href, navigate, toast } from '../lib/app-state';
import { broadcastChange } from '../lib/tablock';
import { LETTERS, type ImageRecord, type Pack } from '../lib/types';
import { Badge, Button, copyText, Field, Modal } from '../ui/kit';
import { Icon } from '../ui/icons';
import { FigureView, OptionBody, previewImages, Rich } from '../ui/content';
import { RestoreDialog } from './data';

const draft = { text: '' };
/** Review edits survive closing the dialog while the same JSON is being imported. */
const reviewDraft: { text: string; targetId?: string; newTitle?: string; newSubject?: string; ov?: Record<string, PaperOverrides & { groupText?: string }> } = { text: '' };

/** A numeric field that can be emptied while typing: empty means "not set", values are capped. */
function numField(v: string, max: number): number | undefined {
  const d = v.replace(/\D/g, '');
  if (!d) return undefined;
  const n = Number(d);
  return n >= 1 ? Math.min(max, n) : undefined;
}

export interface ImportProps {
  pack?: Pack;
  initial?: ImportSource | null;
  /** Question paper and mark scheme PDFs: opens the bare PDF path. */
  pdfs?: File[];
  onClose: () => void;
}

const onlyPdfs = (files: File[]) => files.length > 0 && files.every((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');

export function ImportWizard({ pack, initial, pdfs, onClose }: ImportProps) {
  const [source, setSource] = useState<ImportSource | null>(initial ?? null);
  const [pdfFiles, setPdfFiles] = useState<File[] | null>(pdfs ?? null);
  // The pasted text survives closing the dialog (Esc, backdrop, Cancel) until an import succeeds.
  const [text, setTextState] = useState(initial?.text ?? draft.text);
  const setText = (t: string) => {
    draft.text = t;
    setTextState(t);
  };
  const [outcome, setOutcome] = useState<ParseOutcome | null>(null);
  const [step, setStep] = useState<'input' | 'review'>('input');
  const [restore, setRestore] = useState<{ manifest: string; data: string; images: Map<string, Blob>; pdfs?: Map<string, Blob> } | null>(initial?.backup ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  // Live validation, debounced.
  useEffect(() => {
    if (!text.trim()) return setOutcome(null);
    const t = setTimeout(() => {
      const progress = readProgressJson(text);
      if (progress) {
        setRestore({ ...progress, images: new Map() });
        return;
      }
      setOutcome(parseImport(text, new Set([...(source?.files.keys() ?? []), ...(source?.pdfs.keys() ?? [])])));
    }, 250);
    return () => clearTimeout(t);
  }, [text, source]);

  const load = async (files: File[]) => {
    if (onlyPdfs(files)) return setPdfFiles(files);
    try {
      const src = await readFiles(files);
      if (src.backup) return setRestore(src.backup);
      if (!src.text) return toast('No JSON file found. A zip or folder needs a pack.json (or one .json file) next to an images folder.');
      setSource(src);
      setText(src.text);
      if (src.skipped.length) toast(`Skipped ${src.skipped.length} file(s): ${src.skipped.slice(0, 3).join(', ')}`);
    } catch (e) {
      setSource(null);
      setText('');
      const m = (e as Error).message || '';
      toast(/zip|unzip|invalid/i.test(m) && !/larger/.test(m) ? 'That zip could not be read. Is it a DMC pack or backup zip?' : m || 'Could not read that file.', undefined, 8000);
    }
  };

  if (restore) return <RestoreDialog source={restore} onClose={onClose} />;
  if (pdfFiles) return <PdfImport files={pdfFiles} {...(pack ? { pack } : {})} onClose={onClose} />;

  const errors = outcome?.ok ? outcome.result.errors : [];
  const canReview = outcome?.ok && !errors.length;
  const fixPrompt = () =>
    outcome && (outcome.ok ? buildFixPrompt(outcome.result.errors, text) : buildFixPrompt([], text, outcome.syntax));

  if (step === 'review' && outcome?.ok) return <Review pack={pack} doc={outcome.result.doc} warnings={outcome.result.warnings} source={source} onBack={() => setStep('input')} onClose={onClose} />;

  return (
    <Modal title={pack ? `Import into ${pack.title}` : 'Import a pack'} size="wide" onClose={onClose}>
      <div class="stack">
        <p class="small muted">Paste the AI's reply, or choose a .json file, a .zip (JSON plus images and PDFs) or a folder. Or choose question paper PDFs with their mark schemes to practise straight from the PDF. You can also drop files anywhere on the page.</p>
        <div class="row">
          <Button onClick={() => fileRef.current?.click()}>
            <Icon name="file" size={18} /> Choose file
          </Button>
          <Button onClick={() => pdfRef.current?.click()}>
            <Icon name="upload" size={18} /> PDF papers
          </Button>
          <input ref={pdfRef} type="file" accept=".pdf,application/pdf" multiple hidden onChange={(e) => load([...((e.target as HTMLInputElement).files ?? [])])} />
          <Button onClick={() => dirRef.current?.click()}>
            <Icon name="folder" size={18} /> Choose folder
          </Button>
          <input ref={fileRef} type="file" accept=".json,.txt,.zip,application/json,application/zip" hidden onChange={(e) => load([...((e.target as HTMLInputElement).files ?? [])])} />
          <input ref={dirRef} type="file" hidden {...({ webkitdirectory: '' } as object)} multiple onChange={(e) => load([...((e.target as HTMLInputElement).files ?? [])])} />
          {source && <span class="small muted">Loaded {source.name}{source.files.size ? ` with ${source.files.size} image${source.files.size === 1 ? '' : 's'}` : ''}</span>}
        </div>
        <label class="jy-field">
          <span>JSON</span>
          <textarea
            class="textarea"
            value={text}
            spellcheck={false}
            placeholder={'```json\n{ "format": "dmc-pack/1", "papers": [ … ] }\n```'}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            aria-describedby="import-status"
            autoFocus
          />
        </label>
        <div id="import-status" class="stack-s">
          <span class="sr-only" aria-live="polite">
            {!outcome ? '' : !outcome.ok ? 'The JSON is not readable' : errors.length ? `${errors.length} problems to fix` : 'Valid JSON, ready to review'}
          </span>
          {!outcome && <span class="small subtle">Waiting for input.</span>}
          {outcome && !outcome.ok && (
            <div class="notice notice--bad">
              <Badge status="bad">Not readable</Badge>
              <div class="small">{outcome.syntax}</div>
            </div>
          )}
          {outcome?.ok && (
            <>
              {errors.length ? (
                <div class="notice notice--bad">
                  <div class="stack-s">
                    <Badge status="bad">{errors.length} problem{errors.length === 1 ? '' : 's'} to fix</Badge>
                    <ul class="small" style={{ margin: 0, paddingLeft: '18px', maxHeight: '200px', overflow: 'auto' }}>
                      {errors.slice(0, 50).map((e, i) => (
                        <li key={i}>
                          <span class="num">{e.path}</span>: {e.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : (
                <div class="notice notice--ok">
                  <Badge status="ok">Valid</Badge>
                  <div class="small">
                    {outcome.result.doc.papers.length} paper{outcome.result.doc.papers.length === 1 ? '' : 's'}, {outcome.result.doc.papers.reduce((a, p) => a + p.questions.length, 0)} questions
                    {outcome.result.doc.answers.length ? `, ${outcome.result.doc.answers.length} answer key${outcome.result.doc.answers.length === 1 ? '' : 's'}` : ''}.
                  </div>
                </div>
              )}
              {outcome.result.notes.length > 0 && (
                <p class="small subtle">Normalised: {outcome.result.notes.join('; ')}.</p>
              )}
            </>
          )}
        </div>
        <div class="modal-foot" style={{ marginTop: 0 }}>
          {outcome && (!outcome.ok || errors.length > 0) && (
            <Button
              onClick={async () => {
                const ok = await copyText(fixPrompt() ?? '');
                toast(ok ? 'Fix prompt copied. Paste it into the same AI chat, then paste the new reply here.' : 'Could not copy the fix prompt.');
              }}
            >
              <Icon name="copy" size={18} /> Copy fix prompt
            </Button>
          )}
          <span class="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canReview} onClick={() => setStep('review')}>
            Review import <Icon name="right" size={18} />
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Review({ pack, doc, warnings, source, onBack, onClose }: { pack?: Pack; doc: NDoc; warnings: { path: string; message: string; confirm?: boolean }[]; source: ImportSource | null; onBack: () => void; onClose: () => void }) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const same = reviewDraft.text === draft.text && !!draft.text;
  const [targetId, setTargetId] = useState<string>(pack?.id ?? (same ? reviewDraft.targetId ?? '' : ''));
  const [newTitle, setNewTitle] = useState(same && reviewDraft.newTitle !== undefined ? reviewDraft.newTitle : doc.pack?.title ?? '');
  const [newSubject, setNewSubject] = useState(same && reviewDraft.newSubject !== undefined ? reviewDraft.newSubject : doc.pack?.subject ?? '');
  const [ov, setOv] = useState<Record<string, PaperOverrides & { groupText?: string }>>(() =>
    same && reviewDraft.ov ? reviewDraft.ov :
    Object.fromEntries(doc.papers.map((p) => [p.id, { title: p.title, groupText: p.group.join(' > '), questionCount: p.questionCount, ...(p.timeLimitMin ? { timeLimitMin: p.timeLimitMin } : {}) }])),
  );
  const [plan, setPlan] = useState<{ merge: MergeResult; images: ImageRecord[]; imageMap: Map<string, string> } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<{ title: string; issues: CrossCheckIssue[] }[] | null>(null);

  // Cross-check typed questions against the question paper PDF, when the zip carries one.
  useEffect(() => {
    const withPdf = doc.papers.filter((p) => !p.bare && p.pdf?.questionPaper && source?.pdfs.has(p.pdf.questionPaper));
    if (!withPdf.length) return;
    let live = true;
    void (async () => {
      const { openPdf, pdfText } = await import('../lib/pdf/pdf');
      const out: { title: string; issues: CrossCheckIssue[] }[] = [];
      for (const p of withPdf) {
        try {
          const pdf = await openPdf(source!.pdfs.get(p.pdf!.questionPaper!)!);
          out.push({ title: p.title, issues: crossCheck(p, await pdfText(pdf)) });
          void pdf.loadingTask.destroy();
        } catch {
          /* unreadable PDF: nothing to compare */
        }
      }
      if (live) setChecks(out);
    })();
    return () => {
      live = false;
    };
  }, [doc, source]);

  useEffect(() => {
    if (!pack) void store.getPacks().then((p) => setPacks(p.sort((a, b) => b.updatedAt - a.updatedAt)));
  }, [pack]);

  const overrides = useMemo(() => {
    const out: Record<string, PaperOverrides> = {};
    for (const [id, o] of Object.entries(ov)) {
      out[id] = {
        ...(o.title ? { title: o.title.trim() } : {}),
        group: (o.groupText ?? '').split('>').map((x) => x.trim()).filter(Boolean),
        // Only an edited count overrides the import, so a mismatched chunk is reported, not absorbed.
        ...(o.questionCount && o.questionCount !== doc.papers.find((p) => p.id === id)?.questionCount ? { questionCount: o.questionCount } : {}),
        ...(o.timeLimitMin ? { timeLimitMin: o.timeLimitMin } : {}),
      };
    }
    return out;
  }, [ov, doc]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const r = await planImport(doc, { packId: targetId || null }, source, overrides);
      if (!live) return;
      for (const img of r.images) previewImages.set(img.id, img.blob);
      setPlan(r);
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [doc, targetId, source, overrides]);

  useEffect(() => {
    Object.assign(reviewDraft, { text: draft.text, targetId, newTitle, newSubject, ov });
  }, [targetId, newTitle, newSubject, ov]);

  // Count mismatches between expected and found require explicit confirmation.
  const mismatches = [
    ...warnings.filter((w) => w.confirm).map((w) => w.message),
    ...(plan?.merge.papers ?? []).filter((p) => p.present !== p.questionCount).map((p) => `"${p.title}" will have ${p.present} of ${p.questionCount} questions; it can be started once the rest arrive.`),
  ];
  const missingTime = doc.papers.some((p) => !ov[p.id]?.timeLimitMin);
  const conflicts = plan?.merge.conflicts ?? [];
  const canCommit = !!plan && !conflicts.length && !missingTime && (!mismatches.length || confirmed) && (targetId || newTitle.trim()) && !busy;
  const set = (id: string, patch: Partial<PaperOverrides & { groupText: string }>) => setOv({ ...ov, [id]: { ...ov[id], ...patch } });
  const applyTimeToAll = (m: number) => setOv(Object.fromEntries(Object.entries(ov).map(([k, v]) => [k, { ...v, timeLimitMin: m }])));

  const commit = async () => {
    if (!plan || !canCommit) return;
    setBusy(true);
    try {
      const id = await commitImport({ packId: targetId || null, newPack: { title: newTitle, subject: newSubject } }, plan.merge, plan.images);
      previewImages.clear();
      draft.text = '';
      reviewDraft.text = '';
      bump();
      broadcastChange();
      const added = plan.merge.plan.reduce((a, p) => a + p.added, 0);
      toast(`Imported ${added} question${added === 1 ? '' : 's'}${plan.merge.answersApplied ? ` and ${plan.merge.answersApplied} answers` : ''}.`);
      onClose();
      navigate(href.pack(id, 'papers'));
    } catch (e) {
      toast((e as Error).message || 'Import failed. Nothing was changed.');
      setBusy(false);
    }
  };

  const sample = doc.papers.flatMap((p) => {
    const qs = p.questions;
    const picks = [qs[0], qs[Math.floor(qs.length / 2)], qs[qs.length - 1]].filter((x, i, a) => x && a.indexOf(x) === i);
    return picks.map((q) => ({ paper: p, q: q! }));
  }).slice(0, 6);
  const imageMap = plan?.imageMap ?? new Map<string, string>();

  return (
    <Modal title="Review import" size="full" onClose={onClose}>
      <div class="stack">
        {!pack && (
          <div class="jy-panel jy-panel--sunken stack-s">
            <div class="label">Destination</div>
            <div class="grid-even">
              <Field label="Pack">
                <select class="select" value={targetId} onChange={(e) => setTargetId((e.target as HTMLSelectElement).value)}>
                  <option value="">New pack</option>
                  {packs.map((p) => (
                    <option value={p.id} key={p.id}>{p.title}</option>
                  ))}
                </select>
              </Field>
              {!targetId && (
                <div class="grid-even">
                  <Field label="Pack name">
                    <input class="input" value={newTitle} onInput={(e) => setNewTitle((e.target as HTMLInputElement).value)} placeholder="AS Physics Paper 1" />
                  </Field>
                  <Field label="Subject">
                    <input class="input" value={newSubject} onInput={(e) => setNewSubject((e.target as HTMLInputElement).value)} />
                  </Field>
                </div>
              )}
            </div>
          </div>
        )}

        {checks && (
          <div class={`notice ${checks.some((c) => c.issues.length) ? 'notice--warn' : 'notice--ok'}`}>
            <div class="stack-s small">
              <Badge status={checks.some((c) => c.issues.length) ? 'warn' : 'ok'}>{checks.some((c) => c.issues.length) ? 'Check against the PDF' : 'Numbers match the PDF'}</Badge>
              {checks.every((c) => !c.issues.length) ? (
                <span>Every number in the typed questions appears in the question paper.</span>
              ) : (
                <ul style={{ margin: 0, paddingLeft: '18px' }}>
                  {checks.flatMap((c) => c.issues.map((i) => (
                    <li key={`${c.title}-${i.n}`}>{c.title} Q{i.n}: {i.missing.slice(0, 4).join(', ')} not found in the PDF ({i.missing.length} of {i.checked} numbers). Compare it with the paper before importing.</li>
                  )))}
                </ul>
              )}
            </div>
          </div>
        )}

        {doc.papers.length > 0 && (
          <div class="stack-s">
            <div class="label">Papers</div>
            <div class="table-wrap">
              <table class="jy-table review-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Group (use &gt;)</th>
                    <th class="n">Questions</th>
                    <th class="n">Time cap (min)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.papers.map((p) => {
                    const o = ov[p.id] ?? {};
                    const pl = plan?.merge.plan.find((x) => x.id === p.id);
                    return (
                      <tr key={p.id}>
                        <td data-label="Title" style={{ minWidth: '200px' }}>
                          <input class="input" aria-label={`Title for ${p.id}`} value={o.title} onInput={(e) => set(p.id, { title: (e.target as HTMLInputElement).value })} />
                          <div class="small subtle num" style={{ marginTop: '4px' }}>{p.id} · found {p.questions.length}</div>
                        </td>
                        <td data-label="Group" style={{ minWidth: '160px' }}>
                          <input class="input" aria-label={`Group for ${p.id}`} value={o.groupText} onInput={(e) => set(p.id, { groupText: (e.target as HTMLInputElement).value })} />
                        </td>
                        <td data-label="Questions" class="n" style={{ width: '110px' }}>
                          <input class="input num" aria-label={`Question count for ${p.id}`} inputMode="numeric" value={o.questionCount ?? ''} onInput={(e) => set(p.id, { questionCount: numField((e.target as HTMLInputElement).value, 200) })} />
                        </td>
                        <td data-label="Time cap (min)" class="n" style={{ width: '170px' }}>
                          <input class="input num" aria-label={`Time limit in minutes for ${p.id}`} inputMode="numeric" aria-invalid={!o.timeLimitMin} value={o.timeLimitMin ?? ''} onInput={(e) => set(p.id, { timeLimitMin: numField((e.target as HTMLInputElement).value, 600) })} />
                          {doc.papers.length > 1 && o.timeLimitMin && (
                            <button type="button" class="jy-btn jy-btn--ghost jy-btn--sm apply-all" onClick={() => applyTimeToAll(o.timeLimitMin!)}>Apply to all</button>
                          )}
                        </td>
                        <td>
                          {pl ? <Badge status={pl.status === 'new' ? 'ok' : pl.status === 'merge' ? 'ink' : 'neutral'}>{pl.status === 'new' ? 'New' : pl.status === 'merge' ? `Adds ${pl.added}${pl.keyed ? `, keys ${pl.keyed}` : ''}` : 'Already imported'}</Badge> : '…'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {missingTime ? <p class="small" style={{ color: 'var(--status-bad)' }}>Set the time cap for every paper. It is the hard maximum for any timer.</p> : <p class="small muted">Time caps are 1 to 600 minutes; larger values are capped at 600.</p>}
          </div>
        )}
        {doc.answers.length > 0 && (
          <p class="small">
            Answer keys for: {doc.answers.map((a) => a.paper).join(', ')}{plan ? ` (${plan.merge.answersApplied} answers will be filled)` : ''}.
          </p>
        )}

        {conflicts.length > 0 && (
          <div class="notice notice--bad">
            <div class="stack-s">
              <Badge status="bad">Conflicts: nothing will be imported</Badge>
              <ul class="small" style={{ margin: 0, paddingLeft: '18px' }}>
                {conflicts.slice(0, 30).map((c, i) => (
                  <li key={i}><span class="num">{c.path}</span>: {c.message}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {mismatches.length > 0 && (
          <div class="notice notice--warn">
            <div class="stack-s">
              <Badge status="warn">Check before importing</Badge>
              <ul class="small" style={{ margin: 0, paddingLeft: '18px' }}>
                {mismatches.slice(0, 20).map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
              <label class="check small">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed((e.target as HTMLInputElement).checked)} /> I have checked these and want to import anyway
              </label>
            </div>
          </div>
        )}
        {warnings.filter((w) => !w.confirm).length > 0 && (
          <details class="small">
            <summary>{warnings.filter((w) => !w.confirm).length} note(s) from the transcription</summary>
            <ul style={{ paddingLeft: '18px' }}>
              {warnings.filter((w) => !w.confirm).slice(0, 50).map((w, i) => (
                <li key={i}><span class="num">{w.path}</span>: {w.message}</li>
              ))}
            </ul>
          </details>
        )}

        {sample.length > 0 && (
          <div class="stack-s">
            <div class="label">Preview: compare these with the paper</div>
            <div class="grid-even">
              {sample.map(({ paper, q }) => {
                const question = toQuestion(paper.id, paper.optionCount, q, imageMap);
                return (
                  <div class="jy-panel stack-s" key={`${paper.id}-${q.n}`}>
                    <div class="row small muted">
                      <span class="num">Q{q.n}</span> · {paper.title} {q.uncertain && <Badge status="warn">Flagged by AI</Badge>}
                    </div>
                    {q.stem && <div><Rich text={q.stem} /></div>}
                    {question.figure && <FigureView figure={question.figure} />}
                    <ol class="small" style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: '4px' }}>
                      {Array.from({ length: question.optionCount }, (_, i) => (
                        <li key={i} style={{ display: 'flex', gap: '8px' }}>
                          <b class="num">{LETTERS[i]}</b> <OptionBody q={question} i={i} />
                          {q.answer === i && <Badge status="ok">Key</Badge>}
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div class="modal-foot">
          <Button onClick={onBack}>
            <Icon name="left" size={18} /> Back
          </Button>
          <span class="spacer" />
          {!canCommit && !busy && (
            <span class="small muted" role="status">
              {!plan ? 'Checking…' : conflicts.length ? 'Resolve the conflicts above to import.' : missingTime ? 'Set a time cap for every paper.' : mismatches.length && !confirmed ? 'Tick the check box above to confirm.' : !targetId && !newTitle.trim() ? 'Name the new pack.' : ''}
            </span>
          )}
          <Button variant="accent" onClick={commit} disabled={!canCommit}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
