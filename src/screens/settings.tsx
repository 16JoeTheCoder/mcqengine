import { useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { bump, href, navigate, settingsStore, toast, updateSettings, useStore } from '../lib/app-state';
import { broadcastChange } from '../lib/tablock';
import { Button, Field, Modal, Seg, Toggle } from '../ui/kit';
import { Icon } from '../ui/icons';
import { Signature, DmcMark } from '../ui/brand';
import { BackupPanel } from './data';

export function SettingsScreen({ onImport, onAbout }: { onImport: () => void; onAbout: () => void }) {
  const s = useStore(settingsStore);
  const [wipe, setWipe] = useState(false);
  const [typed, setTyped] = useState('');
  const set = (patch: Partial<typeof s>) => void updateSettings(patch);

  const doWipe = async () => {
    await store.wipeAll();
    await updateSettings({ ...s, lastBackupAtCount: 0, dismissedTips: [] });
    bump();
    broadcastChange();
    setWipe(false);
    toast('All data on this device was erased.');
    navigate(href.library());
  };

  return (
    <main class="page" id="main" style={{ maxWidth: '880px' }}>
      <div class="hero" style={{ paddingBottom: 'var(--space-5)' }}>
        <h1 class="display"><span class="light">Your</span> settings</h1>
      </div>
      <div class="stack" style={{ gap: 'var(--space-6)' }}>
        <section class="jy-panel stack" aria-labelledby="s-exam">
          <h2 id="s-exam">Exam</h2>
          <Field label="Exam date" hint="Shows a countdown on each pack. Optional.">
            <input class="input" type="date" style={{ maxWidth: '240px' }} value={s.examDate ?? ''} onChange={(e) => set({ examDate: (e.target as HTMLInputElement).value || undefined })} />
          </Field>
          <Toggle label="Projection" hint="An indicative, damped estimate for exam day. Turn off if it causes worry." checked={s.projection} onChange={(v) => set({ projection: v })} />
        </section>

        <section class="jy-panel stack" aria-labelledby="s-practice">
          <h2 id="s-practice">Practice</h2>
          <Toggle label="Rushed-error alert" hint="After an exam paper, flags when you went faster than usual and scored lower." checked={s.rushedAlert} onChange={(v) => set({ rushedAlert: v })} />
          <Toggle label="Calibration stats" hint="Accuracy when sure vs when Unsure." checked={s.calibration} onChange={(v) => set({ calibration: v })} />
          <Toggle label="Smart random" hint="Within the least-seen questions, favour ones you got wrong or marked Unsure." checked={s.smartRandom} onChange={(v) => set({ smartRandom: v })} />
          <Toggle label="Shuffle paper order by default" checked={s.shuffleDefault} onChange={(v) => set({ shuffleDefault: v })} />
          <Toggle label="Confirm before submitting" hint="When off, Finish on the last question submits straight away if everything is answered." checked={s.confirmSubmit} onChange={(v) => set({ confirmSubmit: v })} />
          <Toggle label="Keyboard hints" checked={s.keyHints} onChange={(v) => set({ keyHints: v })} />
        </section>

        <section class="jy-panel stack" aria-labelledby="s-look">
          <h2 id="s-look">Appearance</h2>
          <div class="jy-field">
            <span>Theme</span>
            <Seg label="Theme" value={s.theme} onChange={(v) => set({ theme: v })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </div>
          <Toggle label="Reduce effects" hint="Turns off motion such as chart draw-in, counters and hover lifts." checked={s.reduceEffects} onChange={(v) => set({ reduceEffects: v })} />
        </section>

        <section class="jy-panel stack" aria-labelledby="s-data">
          <h2 id="s-data">Data</h2>
          <p class="small muted prose">Everything is stored in this browser only. Clearing site data erases it, so back up regularly.</p>
          <Toggle label="Backup reminder" hint={`Offer a full backup every ${s.backupEvery} completed sessions.`} checked={s.backupReminder} onChange={(v) => set({ backupReminder: v })} />
          {s.backupReminder && (
            <Field label="Remind every (sessions)">
              <input class="input num" style={{ maxWidth: '120px' }} inputMode="numeric" value={s.backupEvery} onChange={(e) => set({ backupEvery: Math.max(1, Math.min(100, Number((e.target as HTMLInputElement).value) || 10)) })} />
            </Field>
          )}
          <BackupPanel />
          <div class="row">
            <Button onClick={onImport}><Icon name="upload" size={18} /> Import pack or backup</Button>
            <span class="spacer" />
            <Button variant="danger" onClick={() => setWipe(true)}><Icon name="trash" size={18} /> Erase all data</Button>
          </div>
        </section>

        <section class="jy-panel stack" aria-labelledby="s-about">
          <h2 id="s-about">About</h2>
          <div class="row"><DmcMark size={40} /> <span><b>DMC</b> <span class="muted">Dynamic Multiple Choice · version {__APP_VERSION__}</span></span></div>
          <div><Button onClick={onAbout}>About DMC</Button></div>
        </section>
      </div>
      {wipe && (
        <Modal
          title="Erase all data"
          onClose={() => setWipe(false)}
          footer={
            <>
              <Button onClick={() => setWipe(false)}>Cancel</Button>
              <Button variant="danger" disabled={typed.trim() !== 'ERASE'} onClick={doWipe}>Erase everything</Button>
            </>
          }
        >
          <div class="stack">
            <p>This deletes every pack, session and setting on this device. It cannot be undone without a backup.</p>
            <Field label="Type ERASE to confirm">
              <input class="input" value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} autoFocus />
            </Field>
          </div>
        </Modal>
      )}
    </main>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="About DMC" size="wide" onClose={onClose}>
      <div class="stack" style={{ gap: 'var(--space-5)' }}>
        <div style={{ padding: 'var(--space-5) 0' }}>
          <Signature height={96} />
        </div>
        <p class="lead">
          <b style={{ color: 'var(--ink)' }}>DMC</b>, Dynamic Multiple Choice. Built to a standard. Built to move.
        </p>
        <div class="grid-even small">
          <div class="stack-s">
            <div class="label">Version</div>
            <span class="num">{__APP_VERSION__} ({__BUILD_ID__})</span>
            <div class="label" style={{ marginTop: '12px' }}>Credits</div>
            <span>Designed and built by Josef Yang (builtbyjosef).</span>
          </div>
          <div class="stack-s">
            <div class="label">Your data</div>
            <span>Packs and progress stay on this device. DMC has no account, no server and no tracking. Nothing is uploaded.</span>
          </div>
        </div>
        <div class="small muted stack-s">
          <div class="label">Licences</div>
          <span>Space Grotesk, JetBrains Mono and Inter (Greek subset): SIL Open Font Licence 1.1. Lucide icons: ISC. Preact, idb: MIT. fflate: MIT.</span>
        </div>
      </div>
    </Modal>
  );
}
