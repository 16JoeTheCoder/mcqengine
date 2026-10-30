import { useEffect, useState } from 'preact/hooks';
import { applyRestore, BackupError, createBackup, planRestore, type RestorePlan, type Tier } from '../lib/data/backup';
import { downloadBlob, readZip } from '../lib/data/files';
import { authStore, backend } from '../lib/backend';
import * as store from '../lib/data/db';
import { bump, settingsStore, toast, updateSettings, useStore } from '../lib/app-state';
import { broadcastChange } from '../lib/tablock';
import { Badge, Button, fmtDate, Modal } from '../ui/kit';
import { Icon } from '../ui/icons';

const LABELS: Record<string, string> = {
  packs: 'pack',
  papers: 'paper',
  sessions: 'session',
  sessionDetail: 'session detail',
  questionStats: 'question stat',
  bankEvents: 'mistakes-bank event',
  overrides: 'question fix',
  meta: 'settings',
};
const phrase = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([k, n]) => n > 0 && k !== 'sessionDetail' && k !== 'bankEvents')
    .map(([k, n]) => `${n} ${LABELS[k] ?? k}${n === 1 || k === 'meta' ? '' : 's'}`)
    .join(', ');

export async function doBackup(tier: Tier) {
  try {
    const { blob, name } = await createBackup(tier);
    downloadBlob(blob, name);
    if (tier === 'everything') {
      const done = (await store.getAllSessions()).filter((s) => s.status === 'submitted' || s.status === 'auto-submitted').length;
      await updateSettings({ lastBackupAtCount: done, lastBackupAt: Date.now() });
    }
    toast(`Backup saved as ${name}. Keep it somewhere safe, such as cloud storage.`);
  } catch {
    toast('Backup failed. Try again, or export a smaller tier.');
  }
}

export function BackupPanel() {
  const s = useStore(settingsStore);
  const [busy, setBusy] = useState<Tier | null>(null);
  const run = async (t: Tier) => {
    setBusy(t);
    await doBackup(t);
    setBusy(null);
  };
  return (
    <div class="stack">
      <div class="grid-3">
        {(
          [
            ['progress', 'Progress only', 'Sessions, stats, fixes and settings, as JSON. Small.'],
            ['packs', 'Packs only', 'Every pack, paper and image, as a zip.'],
            ['everything', 'Everything', 'Packs, images, progress and settings in one zip. Use this to move devices.'],
          ] as [Tier, string, string][]
        ).map(([t, title, text]) => (
          <div class="jy-panel backup-card stack-s" key={t}>
            <h3>{title}</h3>
            <p class="small muted grow">{text}</p>
            <Button variant={t === 'everything' ? 'primary' : 'default'} onClick={() => run(t)} disabled={!!busy}>
              <Icon name="download" size={18} /> {busy === t ? 'Preparing…' : `Export ${title.toLowerCase()}`}
            </Button>
          </div>
        ))}
      </div>
      <p class="small muted">Last full backup: {s.lastBackupAt ? fmtDate(s.lastBackupAt) : 'never'}. To restore, import a backup file the same way as a pack: drop it anywhere, or use Import.</p>
      <CloudBackup />
    </div>
  );
}

/**
 * Opt-in: your own packs (not Library packs, which come back from the Library) as one private file
 * in your account. Progress already syncs; this is for the packs themselves.
 */
function CloudBackup() {
  const auth = useStore(authStore);
  const [pct, setPct] = useState<number | null>(null);
  const [restore, setRestore] = useState<{ manifest: string; data: string; images: Map<string, Blob>; pdfs: Map<string, Blob> } | null>(null);
  if (!backend || !auth.account) return null;
  const path = `${auth.account.id}/packs.zip`;
  const up = async () => {
    setPct(0);
    try {
      const { blob } = await createBackup('packs', Date.now(), { excludeLibrary: true });
      if (blob.size > 200 * 1024 * 1024) throw new Error('Your packs are over 200 MB; export them to a file instead.');
      await backend!.upload('backups', { path, blob, contentType: 'application/zip' }, (n) => setPct(Math.round((n / blob.size) * 100)), new AbortController().signal, true);
      toast('Your packs are backed up to your account.');
    } catch (e) {
      toast((e as Error).message || 'Backup failed.');
    }
    setPct(null);
  };
  const down = async () => {
    const blob = await backend!.download('backups', path).catch(() => null);
    if (!blob) return toast('No pack backup in your account yet.');
    const src = await readZip(blob, 'packs.zip');
    if (src.backup) setRestore(src.backup);
  };
  return (
    <div class="jy-panel stack-s">
      <h3>Packs in your account</h3>
      <p class="small muted">Optional. Keeps a private copy of your own packs (with their PDFs) in your account, for a new device. Library packs are left out; download them again from the Library.</p>
      <div class="row">
        <Button onClick={() => void up()} disabled={pct !== null}><Icon name="upload" size={18} /> {pct === null ? 'Back up my packs' : `Uploading ${pct}%`}</Button>
        <Button variant="ghost" onClick={() => void down()}>Restore from my account</Button>
      </div>
      {restore && <RestoreDialog source={restore} onClose={() => setRestore(null)} />}
    </div>
  );
}

export function RestoreDialog({ source, onClose }: { source: { manifest: string; data: string; images: Map<string, Blob>; pdfs?: Map<string, Blob> }; onClose: () => void }) {
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    planRestore(source.manifest, source.data, source.images, source.pdfs)
      .then(setPlan)
      .catch((e) => setError(e instanceof BackupError ? e.message : 'This backup could not be read.'));
  }, [source]);
  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await applyRestore(plan);
      bump();
      broadcastChange();
      toast('Backup imported.');
      onClose();
    } catch {
      toast('Import failed. Nothing was changed.');
      setBusy(false);
    }
  };
  const adds = plan ? phrase(plan.adds) : '';
  const merges = plan ? phrase(plan.merges) : '';
  return (
    <Modal
      title="Import backup"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={apply} disabled={!plan || busy || (!adds && !merges)}>
            {busy ? 'Importing…' : 'Import backup'}
          </Button>
        </>
      }
    >
      {error && (
        <div class="notice notice--bad">
          <Badge status="bad">Rejected</Badge>
          <div class="small">{error}</div>
        </div>
      )}
      {!error && !plan && <p class="muted">Checking the backup…</p>}
      {plan && (
        <div class="stack">
          <p class="small muted">
            {plan.manifest.tier === 'everything' ? 'Full backup' : plan.manifest.tier === 'packs' ? 'Packs backup' : 'Progress backup'} from {fmtDate(plan.manifest.createdAt)}. <Badge status="ok">Checksum verified</Badge>
          </p>
          <p>{adds ? `Adds ${adds}.` : 'Adds nothing new.'}</p>
          {merges && <p>Updates {merges} where the backup is newer.</p>}
          {plan.orphans > 0 && (
            <div class="notice notice--warn">
              <Badge status="warn">Packs missing</Badge>
              <div class="small">{plan.orphans} progress records belong to packs that are not on this device and are not in this backup, so they are skipped. Import the packs (or a full backup) first to keep that progress.</div>
            </div>
          )}
          <p class="small muted">Records already on this device that are newer than the backup are kept. Nothing is deleted.</p>
        </div>
      )}
    </Modal>
  );
}
