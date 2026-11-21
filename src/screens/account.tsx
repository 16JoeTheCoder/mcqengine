import { useEffect, useState } from 'preact/hooks';
import { authStore, backend } from '../lib/backend';
import { href, navigate, toast, useStore } from '../lib/app-state';
import { Badge, Button, Field, Modal } from '../ui/kit';
import { initials } from './profile';
import { SCHOOL_DOMAINS } from '../lib/backend/types';
import { adoptGuest, adoptLegacy, removeWorkspace } from '../lib/data/workspace';
import { createBackup } from '../lib/data/backup';
import { downloadBlob } from '../lib/data/files';
import { collectLocal, getSyncMeta, syncNow, syncStore } from '../lib/sync/sync';
import { db, getOpenSessions } from '../lib/data/db';
import { bump } from '../lib/app-state';
import { Icon } from '../ui/icons';

export type AccountMode = 'school' | 'personal';

/**
 * Sign-in is Google only: the Worker runs the OAuth flow and sets an HttpOnly session cookie.
 * The school button only pre-selects the school account in Google's chooser; the server decides
 * Library access from the verified account. Development builds add an email sign-in.
 */
export function AccountDialog({ mode, onClose, welcome = false }: { mode: AccountMode; onClose: () => void; welcome?: boolean }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!backend) return <Modal title="Accounts" onClose={onClose}><p>Accounts are not set up on this copy of DMC. You can still practise as a guest.</p></Modal>;
  const google = async (school: boolean) => {
    setBusy(true); setError('');
    try { await backend!.signInGoogle(school); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };
  const dev = async (e: Event) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await backend!.signInDev!(email.trim().toLowerCase()); onClose(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const school = mode === 'school';
  return <Modal title={welcome ? 'Sign in to save your progress' : 'Sign in'} onClose={onClose}><div class="stack">
    {welcome && <ul class="stack-s">
      <li>Keep your results, mistakes and stats safe if this browser is cleared.</li>
      <li>Pick up where you left off on another device.</li>
      <li>Open the School Library with your school account.</li>
    </ul>}
    {error && <p class="notice notice--bad" role="alert">{error}</p>}
    <div class="stack-s">
      <Button variant={school ? 'primary' : 'default'} size="lg" block disabled={busy} onClick={() => void google(true)}><GoogleMark /> Continue with school Google account</Button>
      <Button variant={school ? 'default' : 'primary'} size="lg" block disabled={busy} onClick={() => void google(false)}><GoogleMark /> Continue with another Google account</Button>
    </div>
    <p class="small muted">Any Google account can save and sync your progress. The School Library opens for verified @{SCHOOL_DOMAINS[0]} accounts; the server checks this, not the app. Guest practice stays separate until you choose to import it.</p>
    {backend.signInDev && (backend.kind === 'mock' || ['localhost', '127.0.0.1'].includes(location.hostname)) && <form class="stack-s" onSubmit={dev}>
      <Field label="Development sign-in" hint="Only on this computer, for development and tests. School addresses unlock the Library.">
        <input class="input" type="email" autoComplete="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
      </Field>
      <div><Button type="submit" disabled={busy || !email.trim()}>Sign in with this email</Button></div>
    </form>}
    {welcome
      ? <div><Button variant="ghost" onClick={onClose}>Continue as guest</Button></div>
      : <p class="small subtle">You can close this and keep practising without an account.</p>}
  </div></Modal>;
}

/** Google's "G", drawn in the current text colour (the design standard has no multicolour icons). */
function GoogleMark() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.5 12.2c0-.6-.1-1.2-.2-1.7H12v3.4h4.8a4.4 4.4 0 0 1-1.9 2.8" /><path d="M18 18.6A8.5 8.5 0 1 1 17.6 5.6" /><path d="M12 12h8.5" /></svg>;
}

/** The display name, from the email at first sign-in ("Josef Yang"); the person can change it. */
function NameEditor({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(name), [name]);
  const save = async (e: Event) => {
    e.preventDefault(); setBusy(true);
    try { await backend!.updateName(value); toast('Name saved.'); }
    catch (err) { toast((err as Error).message); }
    finally { setBusy(false); }
  };
  return <form class="row" style={{ alignItems: 'flex-end' }} onSubmit={save}>
    <Field label="Your name" hint="Shown on paper sets you post.">
      <input class="input" maxLength={80} required value={value} onInput={(e) => setValue(e.currentTarget.value)} />
    </Field>
    <Button type="submit" disabled={busy || !value.trim() || value.trim() === name}>Save name</Button>
  </form>;
}

/** Top-bar account control: Sign in when signed out; a menu with status and sign out when signed in. */
export function AccountButton({ onSync, syncLabel }: { onSync?: () => void; syncLabel?: string }) {
  const auth = useStore(authStore);
  const [dialog, setDialog] = useState<AccountMode | null>(null);
  const [menu, setMenu] = useState(false);
  const [working, setWorking] = useState(false);
  const [conflicts, setConflicts] = useState(0);
  useEffect(() => { if (menu) void db().then((d) => d.get('meta', 'syncConflicts')).then((rows) => setConflicts(Array.isArray(rows) ? rows.length : 0)); }, [menu]);
  if (!backend) return <span class="small subtle" title="This build has no account server, so accounts and sync are off.">Sign-in unavailable</span>;
  if (!auth.account)
    return (
      <>
        <Button variant="ghost" onClick={() => setDialog('school')}>Sign in</Button>
        {dialog && <AccountDialog mode={dialog} onClose={() => setDialog(null)} />}
      </>
    );
  const a = auth.account;
  return (
    <>
      {syncLabel && <span class="small subtle hide-sm sync-label" aria-live="polite">{syncLabel}</span>}
      <button type="button" class="jy-btn jy-btn--ghost jy-btn--icon account-chip" aria-label={`Account: ${a.email}`} aria-haspopup="dialog" title={syncLabel} onClick={() => setMenu(true)}>
        <span aria-hidden="true">{initials(a.name || a.email)}</span>
      </button>
      {menu && (
        <Modal title="Account" onClose={() => setMenu(false)}>
          <div class="stack">
            <div class="account-card">
              <span class="avatar avatar--empty" aria-hidden="true" style={{ width: '56px', height: '56px', fontSize: '20px' }}>{initials(a.name || a.email)}</span>
              <div class="stack-s" style={{ minWidth: 0 }}>
                <b style={{ overflowWrap: 'anywhere' }}>{a.name}</b>
                <span class="small muted" style={{ overflowWrap: 'anywhere' }}>{a.handle ? `@${a.handle} · ` : ''}{a.email}</span>
                <div class="row" style={{ gap: 'var(--space-1)' }}>
                  {auth.status.member ? <Badge status="ok">School Library member</Badge> : <Badge status="neutral">Library locked: needs a school account</Badge>}
                  {auth.status.admin && <Badge status="ink">Admin</Badge>}
                </div>
              </div>
            </div>
            <div class="row">
              {auth.status.member && a.handle && <Button variant="primary" onClick={() => { setMenu(false); navigate(href.profile(a.handle!)); }}>View profile</Button>}
              {auth.status.member && <Button onClick={() => { setMenu(false); navigate(href.school()); }}>Open Library</Button>}
              {auth.status.admin && <Button onClick={() => { setMenu(false); navigate(href.admin()); }}>Admin dashboard</Button>}
            </div>
            {!auth.status.member && <NameEditor name={a.name} />}
            {syncLabel && (
              <div class="row">
                <span class="small muted" style={{ flex: 1 }}>{syncLabel}</span>
                {onSync && <Button size="sm" onClick={onSync}><Icon name="shuffle" size={16} /> Sync now</Button>}
              </div>
            )}
            {conflicts > 0 && <div class="notice notice--warn" role="status"><div class="stack-s">
              <p>{conflicts} conflicting local edits were preserved. The server copy is active. Export your local copies to review before clearing this cache.</p>
              <Button onClick={async () => {
                const d = await db(); const rows = await d.get('meta', 'syncConflicts');
                downloadBlob(new Blob([JSON.stringify(rows, null, 2)], {type:'application/json'}), 'dmc-conflicting-local-edits.json');
                if (confirm('Keep the downloaded conflict file safe. Acknowledge these conflicts and keep the current server versions?')) { await d.delete('meta', 'syncConflicts'); setConflicts(0); }
              }}>Export and acknowledge conflicts</Button>
            </div></div>}
            <details class="account-data">
              <summary>Data on this device</summary>
              <div class="stack-s" style={{ marginTop: 'var(--space-2)' }}>
            <p class="small muted">Your personal cache is separate from guest practice and other accounts on this browser.</p>
            <Button disabled={working} onClick={async () => {
              if (!confirm('Import the preserved cache from the previous app version? Only continue if these were your records. A known different account cache is refused.')) return;
              setWorking(true); try { const count = await adoptLegacy(a.id); bump(); toast(`Recovered ${count} legacy records.`); } catch(e) { toast((e as Error).message); } finally { setWorking(false); }
            }}>Recover previous-version data</Button>
            <Button disabled={working} onClick={async () => { if (!confirm('Copy guest paper sets and progress into this account? This explicitly allows their progress to sync. Existing account records are kept.')) return; setWorking(true); try { const count = await adoptGuest(); bump(); toast(`Imported ${count} guest records. Originals remain in the guest workspace.`); } catch (e) { toast((e as Error).message); } finally { setWorking(false); } }}>Import guest progress</Button>
            <Button disabled={working} onClick={async () => {
              if (!confirm('For a shared device: first download a complete backup and sync pending progress, then remove this account’s local cache and sign out. Keep the downloaded backup safe; files on this device do not sync. Continue?')) return;
              setWorking(true);
              try {
                if ((await getOpenSessions()).length) throw new Error('Finish or discard open sessions before removing the cache.');
                const backup = await createBackup('everything'); downloadBlob(backup.blob, backup.name);
                await syncNow(backend, a.id);
                const pendingConflicts = await (await db()).get('meta', 'syncConflicts');
                if (Array.isArray(pendingConflicts) && pendingConflicts.length) { setConflicts(pendingConflicts.length); throw new Error('Review and export conflicting local edits before clearing the cache.'); }
                if (syncStore.get().state !== 'idle' || (await collectLocal((await getSyncMeta(a.id)).versions)).length) throw new Error('Pending changes are not safely synced. Cache kept; retry when online.');
                (await db()).close();
                await removeWorkspace(a.id);
                await backend!.signOut();
              } catch (e) { toast((e as Error).message); setWorking(false); }
            }}>Back up, remove cache and sign out</Button>
              </div>
            </details>
            <div class="row">
              <span class="spacer" />
              <Button variant="ghost" onClick={() => { void backend!.signOut().catch((e: Error) => toast(e.message)); setMenu(false); }}>Sign out</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
