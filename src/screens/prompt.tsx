import { useMemo, useState } from 'preact/hooks';
import { buildAnswersPrompt, buildPrompt, type DiagramMode, type PromptOptions } from '../lib/format/prompt';
import { slugify } from '../lib/format/validate';
import type { Pack } from '../lib/types';
import { toast } from '../lib/app-state';
import { Button, copyText, Field, Modal, Seg, Toggle } from '../ui/kit';
import { Icon } from '../ui/icons';

/** Form values survive closing the dialog, so an accidental Esc never loses the details. */
const drafts = new Map<string, unknown>();
function useDraft<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(drafts.has(key) ? (drafts.get(key) as T) : init);
  return [
    v,
    (x: T) => {
      drafts.set(key, x);
      setV(x);
    },
  ];
}

const splitGroup = (s: string) => s.split('>').map((x) => x.trim()).filter(Boolean);

/** "Make a pack with AI" / "Add papers": builds a complete, tailored prompt for any AI chat. */
export function PromptDialog({ pack, onClose, onImport }: { pack?: Pack; onClose: () => void; onImport: () => void }) {
  const [tab, setTab] = useState<'paper' | 'key'>('paper');
  const [subject, setSubject] = useDraft(`subject:${pack?.id ?? 'new'}`, pack?.subject ?? '');
  const [packTitle, setPackTitle] = useDraft('packTitle', '');
  const [paperTitle, setPaperTitle] = useDraft('paperTitle', '');
  const [paperId, setPaperId] = useDraft('paperId', '');
  const [group, setGroup] = useDraft('group', '');
  const [count, setCount] = useDraft('count', '');
  const [minutes, setMinutes] = useDraft('minutes', '');
  const [optionCount, setOptionCount] = useDraft<'4' | '5'>('optionCount', '4');
  const [diagrams, setDiagrams] = useDraft<DiagramMode>('diagrams', 'draw');
  const [answerKey, setAnswerKey] = useDraft<PromptOptions['answerKey']>('answerKey', 'attached');
  const [chunk, setChunk] = useDraft('chunk', false);
  const [from, setFrom] = useDraft('from', '1');
  const [to, setTo] = useDraft('to', '20');
  const [explanations, setExplanations] = useDraft('explanations', false);
  const [keyPaper, setKeyPaper] = useState(pack?.papers.find((p) => p.keyed < p.questionCount)?.id ?? pack?.papers[0]?.id ?? '');
  const [copied, setCopied] = useState(false);

  const num = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s) : undefined);
  const ready = tab === 'paper' ? !!paperTitle.trim() && (!!pack || !!packTitle.trim()) : !!keyPaper;
  const prompt = useMemo(() => {
    if (tab === 'key') {
      const p = pack?.papers.find((x) => x.id === keyPaper);
      return p ? buildAnswersPrompt({ paperId: p.id, paperTitle: p.title, questionCount: p.questionCount, optionCount: p.optionCount }) : '';
    }
    return buildPrompt({
      subject: subject.trim(),
      ...(!pack && packTitle.trim() ? { packTitle: packTitle.trim() } : {}),
      paperTitle: paperTitle.trim() || 'Paper 1',
      paperId: paperId.trim() || slugify(paperTitle),
      group: splitGroup(group),
      optionCount: Number(optionCount),
      ...(num(count) ? { questionCount: num(count) } : {}),
      ...(num(minutes) ? { timeLimitMin: num(minutes) } : {}),
      diagrams,
      answerKey,
      ...(chunk && num(from) && num(to) && num(to)! >= num(from)! ? { from: num(from), to: num(to) } : {}),
      explanations,
    });
  }, [tab, subject, pack, packTitle, paperTitle, paperId, group, optionCount, count, minutes, diagrams, answerKey, chunk, from, to, explanations, keyPaper]);

  const copy = async () => {
    if (!ready) return;
    const ok = await copyText(prompt);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2500);
    toast(ok ? 'Prompt copied. Paste it into your AI chat with the paper attached.' : 'Could not copy. Select the text and copy it manually.');
  };

  return (
    <Modal title={pack ? `Add papers to ${pack.title}` : 'Make a pack with AI'} size="full" onClose={onClose}>
      <div class="stack">
        <ol class="steps">
          <li><span>Fill in the details below and copy the prompt.</span></li>
          <li><span>Open any AI chat (ChatGPT, Claude, Gemini…), attach the question paper PDF{answerKey === 'attached' ? ' and its mark scheme' : ''}, and paste the prompt.</span></li>
          <li><span>Copy the JSON it replies with and import it here. DMC checks it and tells you exactly what to fix.</span></li>
        </ol>
        {pack && (
          <div class="tabs" role="tablist" aria-label="Prompt type">
            <button role="tab" aria-selected={tab === 'paper'} onClick={() => setTab('paper')}>New paper</button>
            <button role="tab" aria-selected={tab === 'key'} onClick={() => setTab('key')}>Answer key for a paper</button>
          </div>
        )}
        <div class="start-row">
          {tab === 'paper' ? (
            <div class="stack">
              {!pack && (
                <div class="grid-even">
                  <Field label="Pack name" hint="e.g. AS Physics 9702 Paper 1">
                    <input class="input" value={packTitle} onInput={(e) => setPackTitle((e.target as HTMLInputElement).value)} autoFocus />
                  </Field>
                  <Field label="Subject">
                    <input class="input" value={subject} onInput={(e) => setSubject((e.target as HTMLInputElement).value)} placeholder="Physics" />
                  </Field>
                </div>
              )}
              <div class="grid-even">
                <Field label="Paper title" hint="As you want it listed">
                  <input class="input" value={paperTitle} onInput={(e) => setPaperTitle((e.target as HTMLInputElement).value)} placeholder="May/June 2025 Paper 12" />
                </Field>
                <Field label="Group path" hint="Use > between levels, e.g. 2025 > May/June">
                  <input class="input" value={group} onInput={(e) => setGroup((e.target as HTMLInputElement).value)} placeholder="2025 > May/June" />
                </Field>
              </div>
              <div class="grid-even">
                <Field label="Number of questions" hint="Leave blank to read it from the paper">
                  <input class="input num" inputMode="numeric" value={count} onInput={(e) => setCount((e.target as HTMLInputElement).value)} placeholder="40" />
                </Field>
                <Field label="Time allowed (minutes)" hint="The hard cap for timers">
                  <input class="input num" inputMode="numeric" value={minutes} onInput={(e) => setMinutes((e.target as HTMLInputElement).value)} placeholder="75" />
                </Field>
              </div>
              <Field label="Paper id" hint="Stable id so re-imports merge. Auto from the title.">
                <input class="input num" value={paperId} onInput={(e) => setPaperId((e.target as HTMLInputElement).value)} placeholder={slugify(paperTitle) || 'may-june-2025-paper-12'} />
              </Field>
              <div class="jy-field">
                <span>Options per question</span>
                <Seg label="Options per question" value={optionCount} onChange={setOptionCount} options={[{ value: '4', label: 'A–D' }, { value: '5', label: 'A–E' }]} />
              </div>
              <div class="jy-field">
                <span>Diagrams</span>
                <Seg
                  label="Diagrams"
                  value={diagrams}
                  onChange={setDiagrams}
                  options={[
                    { value: 'draw', label: 'Draw simple ones' },
                    { value: 'placeholder', label: 'Mark for screenshots' },
                    { value: 'none', label: 'No diagrams' },
                  ]}
                />
              </div>
              <div class="jy-field">
                <span>Answer key</span>
                <Seg
                  label="Answer key"
                  value={answerKey}
                  onChange={setAnswerKey}
                  options={[
                    { value: 'attached', label: 'Attaching mark scheme' },
                    { value: 'separate', label: 'Add it later' },
                    { value: 'none', label: 'No key' },
                  ]}
                />
              </div>
              <Toggle label="Split a long paper" hint="Ask for a range of questions; import each part into the same paper." checked={chunk} onChange={setChunk} />
              {chunk && (
                <div class="grid-even">
                  <Field label="From question">
                    <input class="input num" inputMode="numeric" value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
                  </Field>
                  <Field label="To question">
                    <input class="input num" inputMode="numeric" value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
                  </Field>
                </div>
              )}
              <Toggle label="Ask for short explanations" hint="Only from the mark scheme or examiner report, never invented." checked={explanations} onChange={setExplanations} />
            </div>
          ) : (
            <div class="stack">
              <Field label="Paper">
                <select class="select" value={keyPaper} onChange={(e) => setKeyPaper((e.target as HTMLSelectElement).value)}>
                  {pack?.papers.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.title} ({p.keyed}/{p.questionCount} keyed)
                    </option>
                  ))}
                </select>
              </Field>
              <p class="small muted">Attach the mark scheme to your AI chat and paste this prompt. Import the reply like any pack file; it fills in the answers.</p>
            </div>
          )}
          <div class="stack sticky-col">
            <div class="jy-code">
              <div class="bar">
                <Icon name="sparkles" size={14} /> Paste into any AI chat
              </div>
              <pre tabIndex={0} aria-label="Generated prompt">{ready ? prompt : tab === 'paper' ? 'Enter a pack name and paper title to build the prompt.' : 'Choose a paper.'}</pre>
            </div>
            <div class="row sticky-actions">
              <Button variant="accent" size="lg" onClick={copy} disabled={!ready}>
                <Icon name={copied ? 'check' : 'copy'} size={18} /> {copied ? 'Copied' : 'Copy prompt'}
              </Button>
              <Button size="lg" onClick={onImport}>
                <Icon name="upload" size={18} /> Import the reply
              </Button>
            </div>
            <p class="small subtle">Nothing leaves your device from here. You choose which AI to use; DMC never reads PDFs itself.</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
