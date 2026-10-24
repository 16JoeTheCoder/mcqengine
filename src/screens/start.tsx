import { useState } from 'preact/hooks';
import { createSession, packStandardLength, sessionCapMin } from '../lib/engine/session';
import { getOpenSessions } from '../lib/data/db';
import { formatClock, perQuestionMaxSec } from '../lib/engine/timer';
import { bump, href, navigate, settingsStore, toast, useStore } from '../lib/app-state';
import type { Pack, PaperMeta, SessionMode, SessionType, TimerKind } from '../lib/types';
import { Badge, Button, Field, Modal, Seg } from '../ui/kit';
import { Icon } from '../ui/icons';

export interface StartRequest {
  type: SessionType;
  paper?: PaperMeta;
  /** Number of questions the session will have (random/drill). */
  size?: number;
}

/** Mode and timer setup, then start. Timer inputs are clamped to the paper's hard cap. */
export function StartDialog({ pack, req, blocked, onClose }: { pack: Pack; req: StartRequest; blocked: boolean; onClose: () => void }) {
  const settings = useStore(settingsStore);
  const n = req.paper?.questionCount ?? req.size ?? packStandardLength(pack);
  const capMin = req.paper ? req.paper.timeLimitMin : sessionCapMin(pack, req.type, n);
  const perQMax = perQuestionMaxSec(capMin, n);
  const [mode, setMode] = useState<SessionMode>('exam');
  const [kind, setKind] = useState<TimerKind>(req.type === 'drill' ? 'total' : 'none');
  const [minutes, setMinutes] = useState(capMin);
  const [perQ, setPerQ] = useState(perQMax);
  const [strict, setStrict] = useState(false);
  const [shuffle, setShuffle] = useState(settings.shuffleDefault);
  const [busy, setBusy] = useState(false);
  const clampMin = (v: number) => Math.min(capMin, Math.max(1, Math.round(v) || 1));
  const clampSec = (v: number) => Math.min(perQMax, Math.max(1, Math.round(v) || 1));

  const total = kind === 'total' ? minutes * 60_000 : kind === 'perq' ? perQ * 1000 * n : capMin * 60_000;
  const title = req.type === 'paper' ? req.paper?.title ?? 'Paper' : req.type === 'random' ? 'Random session' : 'Mistakes drill';

  const resume = async () => {
    const open = (await getOpenSessions()).find((s) => s.packId === pack.id);
    onClose();
    if (open) navigate(href.session(open.id));
  };

  const start = async () => {
    if (blocked || busy) return;
    setBusy(true);
    try {
      const { summary } = await createSession({
        pack,
        type: req.type,
        mode,
        ...(req.paper ? { paperId: req.paper.id } : {}),
        timer: { kind, minutes, perQSec: perQ, strict },
        shuffle: req.type === 'paper' && shuffle,
        smart: settings.smartRandom,
      });
      bump();
      onClose();
      navigate(href.session(summary.id));
    } catch (e) {
      toast((e as Error).message || 'Could not start the session.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} autoFocus={blocked}>Cancel</Button>
          {blocked ? (
            <Button variant="primary" onClick={resume}>
              Resume saved session
            </Button>
          ) : (
            <Button variant="accent" onClick={start} disabled={busy} autoFocus>
              <Icon name="play" size={16} /> Start
            </Button>
          )}
        </>
      }
    >
      <div class="stack">
        <p class="muted">
          <span class="num">{n}</span> questions · time cap <span class="num">{capMin}</span> min
          {req.type === 'paper' ? ' · always the full paper' : ''}
        </p>
        {blocked && (
          <div class="notice notice--warn">
            <Badge status="warn">Saved session</Badge>
            <div class="small">This pack has a saved session. Resume, submit or discard it first (one saved session per pack).</div>
          </div>
        )}
        <div class="jy-field">
          <span>Mode</span>
          <Seg label="Mode" value={mode} onChange={setMode} options={[{ value: 'exam', label: 'Exam' }, { value: 'practice', label: 'Practice' }]} />
          <small>{mode === 'exam' ? 'Timed, results at the end, like the real paper.' : 'No timer. See if you are right after each answer.'}</small>
        </div>
        {mode === 'exam' && (
          <div class="jy-field" style={{ minHeight: '200px' }}>
            <span>Timer</span>
            <Seg
              label="Timer"
              value={kind}
              onChange={setKind}
              options={[
                ...(req.type === 'drill' ? [] : [{ value: 'none' as TimerKind, label: `Full time (${capMin} min)` }]),
                { value: 'total', label: 'Fixed total' },
                ...(perQMax >= 1 ? [{ value: 'perq' as TimerKind, label: 'Per question' }] : []),
              ]}
            />
            {kind === 'none' && <small>The full time allowed for this paper, {capMin} minutes.</small>}
            {kind === 'total' && (
              <div class="row" style={{ alignItems: 'flex-end' }}>
                <input type="range" min={1} max={capMin} value={minutes} onInput={(e) => setMinutes(clampMin(Number((e.target as HTMLInputElement).value)))} aria-label="Total minutes" style={{ flex: 1 }} />
                <Field label="Minutes">
                  <input class="input num" style={{ width: '96px' }} inputMode="numeric" value={minutes} onChange={(e) => {
                    const el = e.target as HTMLInputElement;
                    const v = clampMin(Number(el.value));
                    el.value = String(v);
                    setMinutes(v);
                  }} />
                </Field>
              </div>
            )}
            {kind === 'perq' && (
              <>
                <div class="row" style={{ alignItems: 'flex-end' }}>
                  <input type="range" min={1} max={perQMax} value={perQ} onInput={(e) => setPerQ(clampSec(Number((e.target as HTMLInputElement).value)))} aria-label="Seconds per question" style={{ flex: 1 }} />
                  <Field label="Seconds">
                    <input class="input num" style={{ width: '96px' }} inputMode="numeric" value={perQ} onChange={(e) => {
                      const el = e.target as HTMLInputElement;
                      const v = clampSec(Number(el.value));
                      el.value = String(v);
                      setPerQ(v);
                    }} />
                  </Field>
                </div>
                <label class="check">
                  <input type="checkbox" checked={strict} onChange={(e) => setStrict((e.target as HTMLInputElement).checked)} />
                  <span>Strict: each question has its own countdown, moves on at zero, no going back</span>
                </label>
              </>
            )}
            <small>
              Total <span class="num">{formatClock(total)}</span>
              {kind === 'perq' && !strict ? ' · a pace marker shows if you are ahead or behind' : ''}
            </small>
          </div>
        )}
        {req.type === 'paper' && (
          <label class="check">
            <input type="checkbox" checked={shuffle} onChange={(e) => setShuffle((e.target as HTMLInputElement).checked)} /> Shuffle question order
          </label>
        )}
      </div>
    </Modal>
  );
}
