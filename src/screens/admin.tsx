import { useEffect, useState } from 'preact/hooks';
import { authStore, backend } from '../lib/backend';
import { href, navigate, toast, useStore } from '../lib/app-state';
import { Badge, Button, Field, Menu, Modal, Skeleton, fmtDate, fmtInt } from '../ui/kit';
import { Bars } from '../ui/charts';
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

type Tab = 'overview' | 'users' | 'content' | 'access' | 'operations' | 'audit';
const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' }, { value: 'users', label: 'Users' }, { value: 'content', label: 'Content' },
  { value: 'access', label: 'Access' }, { value: 'operations', label: 'Operations' }, { value: 'audit', label: 'Audit log' },
];
const TAB_KEY = 'dmc-admin-tab';

/**
 * The admin dashboard: a full-height panel over the app with everything needed to run DMC at
 * scale. Overview (health and usage), users (search, suspend, sign out everywhere, quota),
 * content (reports, hidden sets and profiles), access (domains, allowlist, admins), operations
 * (backups, file collection, duplicate papers) and the audit log. The server refuses every
 * route to non-admins and records every change; this screen only hides itself for them.
 */
export function AdminPanel() {
  const auth = useStore(authStore);
  const [tab, setTabState] = useState<Tab>(() => { try { const t = localStorage.getItem(TAB_KEY) as Tab | null; return t && TABS.some((x) => x.value === t) ? t : 'overview'; } catch { return 'overview'; } });
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* private mode */ } };
  const close = () => (history.length > 1 ? history.back() : navigate(href.school()));
  if (!backend || !auth.ready) return null;
  if (!auth.status.admin)
    return (
      <Modal title="Admins only" onClose={close}><p class="small">Ask an admin to add your school address.</p></Modal>
    );
  return (
    <>
      <Modal title="Library admin" size="drawer" onClose={close}>
        <div class="admin-tabs" role="tablist" aria-label="Admin sections">
          {TABS.map((t) => (
            <button key={t.value} type="button" role="tab" id={`atab-${t.value}`} aria-selected={tab === t.value} aria-controls={`apanel-${t.value}`} class="admin-tab" onClick={() => setTab(t.value)}>{t.label}</button>
          ))}
        </div>
        <div class="stack admin-body" role="tabpanel" id={`apanel-${tab}`} aria-labelledby={`atab-${tab}`}>
          {tab === 'overview' && <OverviewPanel onGo={setTab} />}
          {tab === 'users' && <UsersPanel />}
          {tab === 'content' && <ModerationPanel />}
          {tab === 'access' && <AccessPanel />}
          {tab === 'operations' && <><BackupsPanel /><GcPanel /><DuplicatesPanel /><StoragePanel /><UsagePanel /></>}
          {tab === 'audit' && <AuditPanel />}
        </div>
      </Modal>
    </>
  );
}

interface Overview {
  users: { total: number; active7: number; active30: number; suspended: number; members: number };
  sets: { total: number; hidden: number; stars: number };
  storage: { library: number; files: number; limit: number };
  usage: { day: string; downloads: number; downloadBytes: number; uploads: number; uploadBytes: number }[];
  errors24h: number;
  openReports: number;
  lastBackup: { date: string; bytes: number; complete: boolean } | null;
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div class={`admin-tile${tone ? ` is-${tone}` : ''}`}>
      <span class="label">{label}{tone && <> <Badge status={tone}>{tone === 'bad' ? 'Act now' : 'Check'}</Badge></>}</span>
      <b class="num">{value}</b>
      {sub && <span class="small muted">{sub}</span>}
    </div>
  );
}

function OverviewPanel({ onGo }: { onGo: (t: Tab) => void }) {
  const [o, error, reload] = useAdmin<Overview>('overview');
  if (error) return <Panel id="a-ov" title="Overview" error={error}><Button onClick={reload}>Try again</Button></Panel>;
  if (!o) return <Skeleton h={240} />;
  const pct = Math.min(100, (o.storage.library / o.storage.limit) * 100);
  const backupAge = o.lastBackup ? Math.floor((Date.now() - Date.parse(`${o.lastBackup.date}T17:00:00Z`)) / 86_400_000) : null;
  return (
    <>
      <section aria-labelledby="a-ov" class="stack-s">
        <h2 id="a-ov" class="sr-only">Overview</h2>
        <div class="admin-tiles">
          <Tile label="Accounts" value={fmtInt(o.users.total)} sub={`${fmtInt(o.users.members)} Library members`} />
          <Tile label="Active" value={fmtInt(o.users.active7)} sub={`this week · ${fmtInt(o.users.active30)} this month`} />
          <Tile label="Paper sets" value={fmtInt(o.sets.total)} sub={`${fmtInt(o.sets.hidden)} hidden · ${fmtInt(o.sets.stars)} stars`} />
          <Tile label="Storage" value={`${pct.toFixed(1)}%`} sub={`${size(o.storage.library)} of ${size(o.storage.limit)}`} tone={pct >= 80 ? 'warn' : undefined} />
          <Tile label="Open reports" value={fmtInt(o.openReports)} sub={o.openReports ? 'needs a look' : 'nothing waiting'} tone={o.openReports ? 'warn' : undefined} />
          <Tile label="App errors" value={fmtInt(o.errors24h)} sub="last 24 hours" tone={o.errors24h > 20 ? 'bad' : o.errors24h ? 'warn' : undefined} />
          <Tile label="Last backup" value={o.lastBackup ? o.lastBackup.date : 'None'} sub={o.lastBackup ? `${size(o.lastBackup.bytes)}${o.lastBackup.complete ? '' : ' · incomplete'}` : 'run one in Operations'} tone={!o.lastBackup || (backupAge ?? 0) > 1 || !o.lastBackup.complete ? 'bad' : undefined} />
          <Tile label="Suspended" value={fmtInt(o.users.suspended)} sub="accounts" />
        </div>
      </section>
      <Panel id="a-ov-usage" title="Downloads per day, last 14 days">
        <Bars bars={o.usage.map((d) => ({ label: d.day.slice(5), value: d.downloads }))} height={160} format={(v) => fmtInt(v)} label="Downloads per day" />
        <p class="small muted">{fmtInt(o.usage.reduce((a, d) => a + d.downloads, 0))} downloads ({size(o.usage.reduce((a, d) => a + d.downloadBytes, 0))}) and {fmtInt(o.usage.reduce((a, d) => a + d.uploads, 0))} uploads ({size(o.usage.reduce((a, d) => a + d.uploadBytes, 0))}) in 14 days.</p>
      </Panel>
      <div class="row">
        {o.openReports > 0 && <Button onClick={() => onGo('content')}>Review reports</Button>}
        <Button variant="ghost" onClick={() => onGo('users')}>Find an account</Button>
        <Button variant="ghost" onClick={() => onGo('operations')}>Backups and storage</Button>
      </div>
    </>
  );
}

interface AdminUser { id: string; email: string; name: string; handle: string | null; createdAt: number; lastSeenAt: number; suspendedAt: number | null; quotaBytes: number | null; member: number; admin: number; bytes: number; sets: number; sessions: number; visibility: string }

function UsersPanel() {
  const auth = useStore(authStore);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, error, reload] = useAdmin<{ users: AdminUser[]; more: boolean }>(`users?q=${encodeURIComponent(term)}&offset=${offset}`);
  const act = async (u: AdminUser, action: 'suspend' | 'restore' | 'signout' | 'quota' | 'hide-profile') => {
    let quotaBytes: number | null | undefined;
    if (action === 'suspend' && !confirm(`Suspend ${u.email}? They are signed out everywhere at once and cannot sign in until restored.`)) return;
    if (action === 'signout' && !confirm(`Sign ${u.email} out on every device?`)) return;
    if (action === 'quota') {
      const v = prompt(`Upload quota for ${u.email} in MB (empty for the default):`, u.quotaBytes ? String(Math.round(u.quotaBytes / 1048576)) : '');
      if (v === null) return;
      quotaBytes = v.trim() ? Math.round(Number(v) * 1048576) : null;
      if (quotaBytes !== null && (!Number.isFinite(quotaBytes) || quotaBytes < 0)) { toast('Enter a number of MB.'); return; }
    }
    try {
      await backend!.admin(`users/${u.id}`, { method: 'POST', body: { action, ...(action === 'quota' ? { quotaBytes } : {}) } });
      toast('Done.');
      reload();
    } catch (e) { toast((e as Error).message); }
  };
  return (
    <Panel id="a-users" title="Users" error={error}>
      <form class="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); setOffset(0); setTerm(q.trim()); }}>
        <Field label="Find an account"><input class="input" type="search" placeholder="Name, email or profile address" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></Field>
        <Button type="submit">Search</Button>
      </form>
      {!data ? <Skeleton h={120} /> : !data.users.length ? <p class="small muted">No accounts match.</p> : (
        <div class="table-wrap">
          <table class="jy-table admin-users">
            <thead><tr><th scope="col">Account</th><th scope="col">Access</th><th scope="col">Last seen</th><th scope="col" class="n">Stored</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td data-label="Account"><b>{u.name}</b><div class="small muted" style={{ overflowWrap: 'anywhere' }}>{u.email}{u.handle ? ` · @${u.handle}` : ''}</div></td>
                  <td data-label="Access">
                    <div class="row" style={{ gap: '4px' }}>
                      {u.suspendedAt ? <Badge status="bad">Suspended</Badge> : u.member ? <Badge status="ok">Member</Badge> : <Badge status="neutral">Personal</Badge>}
                      {!!u.admin && <Badge status="ink">Admin</Badge>}
                    </div>
                  </td>
                  <td data-label="Last seen" class="small">{fmtDate(u.lastSeenAt)}<div class="muted">{u.sessions} session{u.sessions === 1 ? '' : 's'}</div></td>
                  <td data-label="Stored" class="n num">{size(u.bytes)}{u.quotaBytes !== null && <div class="small muted">quota {size(u.quotaBytes)}</div>}</td>
                  <td data-label="Actions">
                    <Menu label={`Actions for ${u.email}`} buttonLabel="Actions" items={[
                      { label: 'Sign out everywhere', onSelect: () => void act(u, 'signout') },
                      { label: 'Set upload quota', onSelect: () => void act(u, 'quota') },
                      { label: 'Make profile private', onSelect: () => void act(u, 'hide-profile'), hidden: u.visibility === 'private' },
                      { label: 'Restore account', onSelect: () => void act(u, 'restore'), hidden: !u.suspendedAt },
                      { label: 'Suspend account', onSelect: () => void act(u, 'suspend'), danger: true, hidden: !!u.suspendedAt || u.email === auth.account?.email },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (offset > 0 || data.more) && (
        <div class="row">
          <Button size="sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button>
          <Button size="sm" disabled={!data.more} onClick={() => setOffset(offset + 50)}>Next</Button>
        </div>
      )}
    </Panel>
  );
}

function AuditPanel() {
  const [data, error] = useAdmin<{ entries: { id: number; at: number; actor: string; action: string; target: string }[] }>('audit');
  return (
    <Panel id="a-audit" title="Audit log" error={error}>
      <p class="small muted">Every admin change, newest first. Kept with the nightly backups.</p>
      {!data ? <Skeleton h={120} /> : !data.entries.length ? <p class="small muted">No admin actions yet.</p> : (
        <div class="table-wrap">
          <table class="jy-table">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Target</th></tr></thead>
            <tbody>{data.entries.map((e) => <tr key={e.id}><td class="small num">{new Date(e.at).toLocaleString()}</td><td class="small">{e.actor}</td><td><code>{e.action}</code></td><td class="small" style={{ overflowWrap: 'anywhere' }}>{e.target}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function GcPanel() {
  const [g, error] = useAdmin<{ due: { n: number; bytes: number }; waiting: { n: number; bytes: number } }>('gc');
  return (
    <Panel id="a-gc" title="File collection" error={error}>
      {!g ? <Skeleton h={40} /> : <p class="small">Tonight: <b class="num">{fmtInt(g.due.n)}</b> unused file{g.due.n === 1 ? '' : 's'} (<span class="num">{size(g.due.bytes)}</span>) will be deleted. Waiting out the 7-day grace: <span class="num">{fmtInt(g.waiting.n)}</span> (<span class="num">{size(g.waiting.bytes)}</span>).</p>}
    </Panel>
  );
}

interface DupPaper { qp_hash: string; label: string | null; title: string; setId: string | null; setTitle: string | null; size: number | null }
function DuplicatesPanel() {
  const [d, error] = useAdmin<{ groups: { similarity: number; papers: DupPaper[] }[] }>('duplicates');
  return (
    <Panel id="a-dups" title="Duplicate papers" error={error}>
      <p class="small muted">The same paper stored as two different files (found by its text). New posts link automatically; these are older copies.</p>
      {!d ? <Skeleton h={40} /> : !d.groups.length ? <p class="small muted">No duplicates.</p> : (
        <ul class="stack-s" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {d.groups.map((g, i) => (
            <li key={i} class="small">
              <Badge status="warn">{Math.round(g.similarity * 100)}% same text</Badge>{' '}
              {g.papers.map((p) => `${p.title || p.label || p.qp_hash.slice(0, 10)} (${p.setTitle ?? 'no set'}, ${p.size ? size(p.size) : '?'})`).join(' and ')}
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
  const [data, error, reload] = useAdmin<{ sets: Flagged[]; people?: { id: string; handle: string | null; name: string; visibility: string; reports: number; reasons: { reason: string }[] }[] }>('moderation');
  const hideProfile = async (id: string) => {
    try { await backend!.admin(`users/${id}`, { method: 'POST', body: { action: 'hide-profile' } }); toast('Profile made private.'); reload(); }
    catch (e) { toast((e as Error).message); }
  };
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
    <>
    <Panel id="a-mod-people" title="Reported profiles" error={error}>
      {!data ? <Skeleton h={40} /> : !data.people?.length ? <p class="small muted">Nothing reported.</p> : (
        <ul class="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.people.map((p) => (
            <li key={p.id} class="stack-s">
              <div class="row" style={{ justifyContent: 'space-between' }}>
                <span><b>{p.name}</b> <span class="small muted">{p.handle ? `@${p.handle} · ` : ''}{p.reports} report{p.reports === 1 ? '' : 's'}</span></span>
                {p.visibility === 'private' ? <Badge status="neutral">Private</Badge> : <Badge status="warn">Visible</Badge>}
              </div>
              <ul class="small muted">{p.reasons.map((r, i) => <li key={i}>{r.reason}</li>)}</ul>
              {p.visibility !== 'private' && <div><Button size="sm" onClick={() => void hideProfile(p.id)}>Make private</Button></div>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
    </>
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
