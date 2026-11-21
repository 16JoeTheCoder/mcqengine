import { useEffect, useState } from 'preact/hooks';
import { authStore, backend } from '../lib/backend';
import { toast, useStore } from '../lib/app-state';
import { Badge, Button, Field, Skeleton, fmtInt, focusMainIfLost } from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * Admin panel: storage against the free tier, downloads per account, who may use the Library,
 * moderation and backups. The server refuses every route to non-admins; this screen
 * only hides itself for them.
 */
interface Storage { freeTierBytes: number; totalBytes: number; libraryBytes: number; files: number; databaseBackupBytes: number; personalBackupBytes: number; perAccount: { user_id: string | null; email: string | null; name: string | null; bytes: number; files: number }[] }
interface Usage { since: string; rows: { day: string; email: string | null; name: string | null; downloads: number; download_bytes: number; uploads: number; upload_bytes: number }[] }
interface Backups { daily: { date: string; bytes: number; complete: boolean }[]; weekly: { date: string; bytes: number; complete: boolean }[] }
interface Flagged { id: string; title: string; ownerName: string; status: 'approved' | 'hidden'; reports: number; reasons: { reason: string }[] }

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${fmtInt(Math.round(b / 1e3))} kB`);

export function AdminPanel() {
  const auth = useStore(authStore);
  useEffect(focusMainIfLost, []);
  if (!backend || !auth.ready) return <main class="page" aria-busy="true"><Skeleton h={320} /></main>;
  if (!auth.status.admin)
    return (
      <main class="page" id="main" tabIndex={-1}>
        <h1 class="display"><span class="light">Admin</span></h1>
        <div class="locked" style={{ minHeight: '160px' }}><b>Admins only</b><span class="small">Ask an admin to add your school address.</span></div>
      </main>
    );
  return (
    <main class="page" id="main" tabIndex={-1}>
      <section class="hero" style={{ paddingBottom: 'var(--space-5)' }}>
        <h1 class="display"><span class="light">Library</span> admin</h1>
      </section>
      <div class="stack" style={{ gap: 'var(--space-6)', maxWidth: '1000px' }}>
        <StoragePanel />
        <AccessPanel />
        <ModerationPanel />
        <BackupsPanel />
        <UsagePanel />
      </div>
    </main>
  );
}

function useAdmin<T>(path: string): [T | null, string, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const load = () => void backend!.admin<T>(path).then((d) => { setData(d); setError(''); }, (e: Error) => setError(e.message));
  useEffect(load, [path]);
  return [data, error, load];
}

function Panel({ id, title, children, error }: { id: string; title: string; children: preact.ComponentChildren; error?: string }) {
  return (
    <section class="jy-panel stack" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {error && <div class="notice notice--bad" role="alert"><Badge status="bad">Error</Badge><div class="small">{error}</div></div>}
      {children}
    </section>
  );
}

function StoragePanel() {
  const [s, error] = useAdmin<Storage>('storage');
  const pct = s ? Math.min(100, (s.totalBytes / s.freeTierBytes) * 100) : 0;
  return (
    <Panel id="a-storage" title="Storage" error={error}>
      {!s ? <Skeleton h={80} /> : (
        <>
          <p><b class="num">{size(s.totalBytes)}</b> <span class="muted">of the {size(s.freeTierBytes)} R2 free tier ({pct.toFixed(1)}%)</span></p>
          <div class="progress" role="progressbar" aria-label="Storage used of the free tier" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><div style={{ transform: `scaleX(${pct / 100})` }} /></div>
          {pct >= 80 && <div class="notice notice--warn" role="status"><Badge status="warn">Near the limit</Badge><div class="small">Remove old sets, or move the account to a paid plan before uploads fail.</div></div>}
          <p class="small muted">Library files <span class="num">{size(s.libraryBytes)}</span> in <span class="num">{fmtInt(s.files)}</span> files · database backups <span class="num">{size(s.databaseBackupBytes)}</span> · personal backups <span class="num">{size(s.personalBackupBytes)}</span>. Each file counts once, against whoever uploaded it first.</p>
          {s.perAccount.length > 0 && (
            <table class="key-table">
              <thead><tr><th scope="col">Account</th><th scope="col">Files</th><th scope="col">Stored</th></tr></thead>
              <tbody>{s.perAccount.map((r) => <tr key={r.user_id ?? 'gone'}><td>{r.name ?? 'Deleted account'} <span class="small muted">{r.email ?? ''}</span></td><td class="num">{fmtInt(r.files)}</td><td class="num">{size(r.bytes)}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}
    </Panel>
  );
}

function ListEditor({ path, label, field, placeholder, note }: { path: 'allowlist' | 'admins' | 'domains'; label: string; field: 'email' | 'domain'; placeholder: string; note?: boolean }) {
  const [data, error, reload] = useAdmin<{ items: Record<string, string>[] }>(path);
  const [value, setValue] = useState('');
  const [why, setWhy] = useState('');
  const send = async (method: 'POST' | 'DELETE', v: string) => {
    try {
      await backend!.admin(path, { method, body: { [field]: v, ...(method === 'POST' && note && why ? { note: why } : {}) } });
      setValue(''); setWhy(''); reload();
      toast(method === 'POST' ? `Added ${v}.` : `Removed ${v}.`);
    } catch (e) { toast((e as Error).message); }
  };
  return (
    <div class="stack-s">
      <h3 class="h3" style={{ fontSize: '16px' }}>{label}</h3>
      {error && <p class="small" role="alert">{error}</p>}
      <ul class="stack-s" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {(data?.items ?? []).map((it) => (
          <li key={it[field]} class="row" style={{ justifyContent: 'space-between' }}>
            <span><code>{it[field]}</code>{it.note ? <span class="small muted"> · {it.note}</span> : null}</span>
            <Button variant="ghost" size="sm" aria-label={`Remove ${it[field]}`} onClick={() => { if (confirm(`Remove ${it[field]}?`)) void send('DELETE', it[field]!); }}>Remove</Button>
          </li>
        ))}
      </ul>
      <form class="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); if (value.trim()) void send('POST', value.trim()); }}>
        <Field label={`Add ${field === 'email' ? 'an email' : 'a domain'}`}><input class="input" type={field === 'email' ? 'email' : 'text'} placeholder={placeholder} value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} /></Field>
        {note && <Field label="Note (optional)"><input class="input" maxLength={200} value={why} placeholder="Physics teacher" onInput={(e) => setWhy((e.target as HTMLInputElement).value)} /></Field>}
        <Button type="submit" disabled={!value.trim()}>Add</Button>
      </form>
    </div>
  );
}

function AccessPanel() {
  return (
    <Panel id="a-access" title="Who can use the Library">
      <p class="small muted">Verified Google Workspace accounts on a school domain are members. Add teachers or helpers who use another address to the allowlist. Admins are members too.</p>
      <div class="grid-even">
        <ListEditor path="allowlist" label="Allowlist" field="email" placeholder="teacher@gmail.com" note />
        <ListEditor path="admins" label="Admins" field="email" placeholder="name@stjbs.sch.id" />
      </div>
      <ListEditor path="domains" label="School domains" field="domain" placeholder="stjbs.sch.id" />
    </Panel>
  );
}

function ModerationPanel() {
  const [data, error, reload] = useAdmin<{ sets: Flagged[] }>('moderation');
  const act = async (s: Flagged, what: 'restore' | 'delete') => {
    if (what === 'delete' && !confirm(`Delete "${s.title}" from the Library for everyone? Copies already downloaded stay on those devices.`)) return;
    try {
      if (what === 'restore') await backend!.updateSet(s.id, { status: 'approved' });
      else await backend!.deleteSet(s.id);
      reload();
      toast(what === 'restore' ? 'Restored.' : 'Deleted.');
    } catch (e) { toast((e as Error).message); }
  };
  return (
    <Panel id="a-mod" title="Reported and hidden sets" error={error}>
      {!data ? <Skeleton h={60} /> : !data.sets.length ? <p class="small muted">Nothing reported.</p> : (
        <ul class="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.sets.map((s) => (
            <li key={s.id} class="stack-s">
              <div class="row" style={{ justifyContent: 'space-between' }}>
                <span><b>{s.title}</b> <span class="small muted">by {s.ownerName} · {s.reports} report{s.reports === 1 ? '' : 's'}</span></span>
                {s.status === 'hidden' ? <Badge status="warn">Hidden</Badge> : <Badge status="neutral">Visible</Badge>}
              </div>
              {s.reasons.length > 0 && <ul class="small muted">{s.reasons.map((r, i) => <li key={i}>{r.reason}</li>)}</ul>}
              <div class="row">
                {s.status === 'hidden' && <Button size="sm" onClick={() => void act(s, 'restore')}>Restore</Button>}
                <Button size="sm" variant="danger" onClick={() => void act(s, 'delete')}>Delete</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function BackupsPanel() {
  const [b, error, reload] = useAdmin<Backups>('backups');
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try { await backend!.admin('backups', { method: 'POST' }); toast('Backup finished.'); reload(); }
    catch (e) { toast((e as Error).message); }
    setRunning(false);
  };
  const list = (title: string, rows: Backups['daily']) => (
    <div class="stack-s">
      <h3 class="h3" style={{ fontSize: '16px' }}>{title}</h3>
      {!rows.length ? <p class="small muted">None yet.</p> : (
        <ul class="small" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((r) => <li key={r.date} class="row"><span class="num">{r.date}</span><span class="muted num">{size(r.bytes)}</span>{!r.complete && <Badge status="warn">Incomplete</Badge>}</li>)}
        </ul>
      )}
    </div>
  );
  return (
    <Panel id="a-backups" title="Backups" error={error}>
      <p class="small muted">Every night at 00:00 Jakarta time the database is copied to R2. Seven daily and four weekly copies are kept. Files are not copied; R2 already keeps them safe. Restoring is in setup.md.</p>
      {!b ? <Skeleton h={60} /> : <div class="grid-even">{list('Daily', b.daily)}{list('Weekly', b.weekly)}</div>}
      <div><Button disabled={running} onClick={() => void run()}><Icon name="save" size={18} /> {running ? 'Backing up…' : 'Run backup now'}</Button></div>
    </Panel>
  );
}

function UsagePanel() {
  const [u, error] = useAdmin<Usage>('downloads?days=14');
  return (
    <Panel id="a-usage" title="Downloads and uploads, last 14 days" error={error}>
      {!u ? <Skeleton h={60} /> : !u.rows.length ? <p class="small muted">No activity yet.</p> : (
        <table class="key-table">
          <thead><tr><th scope="col">Day</th><th scope="col">Account</th><th scope="col">Downloads</th><th scope="col">Uploads</th></tr></thead>
          <tbody>{u.rows.map((r, i) => <tr key={i}><td class="num">{r.day}</td><td>{r.name ?? 'Deleted account'}</td><td class="num">{fmtInt(r.downloads)} · {size(r.download_bytes)}</td><td class="num">{fmtInt(r.uploads)} · {size(r.upload_bytes)}</td></tr>)}</tbody>
        </table>
      )}
    </Panel>
  );
}
