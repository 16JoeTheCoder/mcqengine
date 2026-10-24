import { useEffect, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { imageType, MAX_IMAGE_BYTES, sha256Hex } from '../lib/data/files';
import { statKey } from '../lib/engine/mistakes';
import { LETTERS, type Figure, type Question, type QuestionOverride } from '../lib/types';
import { bump, toast } from '../lib/app-state';
import { Button, Field, Modal } from '../ui/kit';
import { FigureView, Rich } from '../ui/content';
import { Icon } from '../ui/icons';

async function blobToFigure(blob: Blob): Promise<Figure | null> {
  if (blob.size > MAX_IMAGE_BYTES) {
    toast('That image is over 5 MB. Use a smaller screenshot.');
    return null;
  }
  if (!/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) {
    toast('Use a PNG, JPEG, WebP or GIF image.');
    return null;
  }
  const id = await sha256Hex(await blob.arrayBuffer());
  const d = await store.db();
  if (!(await d.get('images', id))) await d.put('images', { id, type: blob.type, blob });
  return { kind: 'image', imageId: id, alt: 'Attached figure' };
}

/** Per-question editor. Edits persist as an override keyed by question id; the import stays untouched. */
export function FixQuestion({ packId, question, onClose, onSaved }: { packId: string; question: Question; onClose: () => void; onSaved?: () => void }) {
  const key = statKey(packId, question.id);
  const [ov, setOv] = useState<QuestionOverride | null>(null);
  const [stem, setStem] = useState(question.stem ?? '');
  const [options, setOptions] = useState<string[]>(question.options?.map((o) => o.text ?? '') ?? []);
  const [answer, setAnswer] = useState<number | null>(question.answer);
  const [figure, setFigure] = useState<Figure | undefined>(question.figure);
  const [reported, setReported] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    void (async () => {
      const o = await (await store.db()).get('overrides', key);
      if (o) {
        setOv(o);
        setReported(!!o.reported);
        setNote(o.note ?? '');
      }
    })();
  }, [key]);

  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (!file) return;
      e.preventDefault();
      const f = await blobToFigure(file);
      if (f) setFigure(f);
    };
    addEventListener('paste', onPaste);
    return () => removeEventListener('paste', onPaste);
  }, []);

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file && imageType(file.name)) {
        const f = await blobToFigure(file);
        if (f) setFigure(f);
      }
    };
    input.click();
  };

  const save = async () => {
    const o: QuestionOverride = { key, packId, qid: question.id, updatedAt: Date.now() };
    if (stem !== (question.stem ?? '') || ov?.stem !== undefined) o.stem = stem;
    if (question.options && (options.some((t, i) => t !== (question.options?.[i]?.text ?? '')) || ov?.options)) o.options = options;
    if (answer !== question.answer || ov?.answer !== undefined) o.answer = answer;
    if (figure !== question.figure || ov?.figure) {
      if (figure) o.figure = figure;
    }
    if (reported) o.reported = true;
    if (note.trim()) o.note = note.trim().slice(0, 500);
    await store.putOverride(o);
    await refreshPackMeta(packId);
    bump();
    toast('Question updated. Your fix is saved on this device.');
    onSaved?.();
    onClose();
  };

  const revert = async () => {
    await store.deleteOverride(key);
    await refreshPackMeta(packId);
    bump();
    toast('Fixes removed for this question.');
    onSaved?.();
    onClose();
  };

  return (
    <Modal
      title={`Fix question ${question.n}`}
      size="wide"
      onClose={onClose}
      footer={
        <>
          {ov && (
            <Button variant="ghost" onClick={revert}>
              Revert to imported
            </Button>
          )}
          <span class="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save fix
          </Button>
        </>
      }
    >
      <div class="stack">
        <p class="small muted">Correct a transcription mistake. Markup: x^{'{2}'} superscript, v_{'{0}'} subscript, \frac{'{a}{b}'} fraction, **bold**.</p>
        {question.stem !== undefined && (
          <Field label="Question text">
            <textarea class="textarea" style={{ fontFamily: 'var(--font-sans)', fontSize: '15px', minHeight: '120px' }} value={stem} onInput={(e) => setStem((e.target as HTMLTextAreaElement).value)} />
          </Field>
        )}
        {stem && (
          <div class="jy-panel jy-panel--sunken small">
            <div class="label" style={{ marginBottom: '4px' }}>Preview</div>
            <Rich text={stem} />
          </div>
        )}
        {question.options && (
          <div class="grid-even">
            {options.map((t, i) => (
              <Field label={`Option ${LETTERS[i]}`} key={i}>
                <input class="input" value={t} onInput={(e) => setOptions(options.map((x, k) => (k === i ? (e.target as HTMLInputElement).value : x)))} />
              </Field>
            ))}
          </div>
        )}
        <div class="jy-field">
          <span>Correct answer</span>
          <div class="seg" role="radiogroup" aria-label="Correct answer">
            {Array.from({ length: question.optionCount }, (_, i) => (
              <button type="button" role="radio" aria-checked={answer === i} aria-pressed={answer === i} onClick={() => setAnswer(i)} key={i}>
                {LETTERS[i]}
              </button>
            ))}
          </div>
        </div>
        <div class="jy-field">
          <span>Figure</span>
          {figure ? <FigureView figure={figure} /> : <span class="small muted">No figure.</span>}
          <div class="row">
            <Button onClick={pickFile}>
              <Icon name="image" size={18} /> Choose image
            </Button>
            <span class="small muted">or paste a screenshot (Ctrl/Cmd + V)</span>
            {figure && (
              <Button variant="ghost" onClick={() => setFigure(undefined)}>
                Remove figure
              </Button>
            )}
          </div>
        </div>
        <label class="check">
          <input type="checkbox" checked={reported} onChange={(e) => setReported((e.target as HTMLInputElement).checked)} /> Report an error in this question (listed in the pack's Data section)
        </label>
        {reported && (
          <Field label="What is wrong?">
            <input class="input" value={note} maxLength={500} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** Keeps pack meta counts (keyed, figures needed) in step with overrides. */
export async function refreshPackMeta(packId: string) {
  const pack = await store.getPack(packId);
  if (!pack) return;
  const [papers, ovs] = await Promise.all([store.getPapers(packId), store.getOverrides(packId)]);
  const om = new Map(ovs.map((o) => [o.qid, o] as const));
  const metas = pack.papers.map((m) => {
    const p = papers.find((x) => x.id === m.id);
    if (!p) return m;
    const qs = p.questions.map((q) => {
      const o = om.get(q.id);
      return { answer: o?.answer !== undefined ? o.answer : q.answer, figure: o?.figure ?? q.figure, options: q.options };
    });
    return {
      ...m,
      keyed: qs.filter((q) => q.answer !== null).length,
      figuresNeeded: qs.filter((q) => q.figure?.kind === 'needed' || q.options?.some((x) => x.figure?.kind === 'needed')).length,
    };
  });
  await store.putPack({ ...pack, papers: metas, updatedAt: Date.now() });
}
