import { useEffect, useState } from 'preact/hooks';
import { authStore, backend } from '../lib/backend';
import { href, navigate, toast, useStore } from '../lib/app-state';
import { Button, Field, Modal, Seg } from '../ui/kit';
import { adoptGuest, adoptLegacy, removeWorkspace } from '../lib/data/workspace';
import { createBackup } from '../lib/data/backup';
import { downloadBlob } from '../lib/data/files';
import { collectLocal, getSyncMeta, syncNow, syncStore } from '../lib/sync/sync';
import { db, getOpenSessions } from '../lib/data/db';
import { bump } from '../lib/app-state';
import { Icon } from '../ui/icons';

export type AccountMode = 'school' | 'personal';

/** Email codes are entered here; no provider account chooser is required. */
export function AccountDialog({ mode: initial, onClose }: { mode: AccountMode; onClose: () => void }) {
  const [mode, setMode] = useState<AccountMode>(initial);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown((v) => v - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  if (!backend) return <Modal title="Accounts" onClose={onClose}><p>Accounts are not configured. You can still practise as a guest.</p></Modal>;
  const send = async (e?: Event) => {
    e?.preventDefault(); setBusy(true); setError('');
    try {
      await backend!.signInEmail(email.trim().toLowerCase(), true);
      setSent(true); setCooldown(60);

    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const verify = async (e: Event) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await backend!.verifyEmailCode(email, code); toast('Email verified. Opening your personal workspace…'); onClose(); }
    catch { setError('The code is invalid or expired. Check the latest email, or request a new code.'); }
    finally { setBusy(false); }
  };
  return <Modal title="Sign in by email" onClose={onClose}><div class="stack">
    <Seg label="Account type" value={mode} onChange={setMode} options={[{value:'school',label:'School email'},{value:'personal',label:'Personal'}]} />
    <p class="small muted">Any verified email can sync personal progress. School Library access is checked by the server. Guest data stays separate until you choose to import it.</p>
    {error && <p class="notice notice--bad" role="alert">{error}</p>}
    {!sent ? <form class="stack" onSubmit={send}>
      <Field label="Email"><input class="input" type="email" autoComplete="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></Field>
      <Button type="submit" variant="primary" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send verification code'}</Button>
    </form> : <>
      <p role="status">Code sent to {email}. Enter the latest code before it expires.{backend.kind === 'mock' ? ' Development code: 123456.' : ''}</p>
      <form class="stack" onSubmit={verify}>
        <Field label="Verification code"><input class="input" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6,10}" minLength={6} maxLength={10} required value={code} onInput={(e) => setCode(e.currentTarget.value)} autoFocus /></Field>
        <Button type="submit" variant="primary" disabled={busy || code.length < 6}>{busy ? 'Verifying…' : 'Verify and sign in'}</Button>
      </form>
      <div class="row"><Button disabled={busy || cooldown > 0} onClick={() => void send()}>{cooldown ? `Resend in ${cooldown} s` : 'Resend code'}</Button><Button variant="ghost" disabled={busy} onClick={() => {setSent(false);setCode('');setError('');}}>Change email</Button></div>
    </>}
    <p class="small subtle">You can close this dialog and keep practising without an account.</p>
  </div></Modal>;
}

/** Top-bar account control: Sign in when signed out; a menu with status and sign out when signed in. */
export function AccountButton({ onSync, syncLabel }: { onSync?: () => void; syncLabel?: string }) {
  const auth = useStore(authStore);
  const [dialog, setDialog] = useState<AccountMode | null>(null);
  const [menu, setMenu] = useState(false);
  const [working, setWorking] = useState(false);
  const [conflicts, setConflicts] = useState(0);
  useEffect(() => { if (menu) void db().then((d) => d.get('meta', 'syncConflicts')).then((rows) => setConflicts(Array.isArray(rows) ? rows.length : 0)); }, [menu]);
  if (!backend) return null;
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
        <span aria-hidden="true">{(a.name || a.email).charAt(0).toUpperCase()}</span>
      </button>
      {menu && (
        <Modal title="Account" onClose={() => setMenu(false)}>
          <div class="stack">
            <div>
              <b>{a.email}</b>
              <div class="small muted">{auth.status.member ? (auth.status.admin ? 'School Library: member, admin' : 'School Library: member') : 'School Library: locked (needs a school email)'}</div>
            </div>
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
            <p class="small muted">Your personal cache is separate from guest practice and other accounts on this browser.</p>
            <Button disabled={working} onClick={async () => {
              if (!confirm('Import the preserved cache from the previous app version? Only continue if these were your records. A known different account cache is refused.')) return;
              setWorking(true); try { const count = await adoptLegacy(a.id); bump(); toast(`Recovered ${count} legacy records.`); } catch(e) { toast((e as Error).message); } finally { setWorking(false); }
            }}>Recover previous-version data</Button>
            <Button disabled={working} onClick={async () => { if (!confirm('Copy guest packs and progress into this account? This explicitly allows their progress to sync. Existing account records are kept.')) return; setWorking(true); try { const count = await adoptGuest(); bump(); toast(`Imported ${count} guest records. Originals remain in the guest workspace.`); } catch (e) { toast((e as Error).message); } finally { setWorking(false); } }}>Import guest progress</Button>
            <Button disabled={working} onClick={async () => {
              if (!confirm('For a shared device: first download a complete backup and sync pending progress, then remove this account’s local cache and sign out. Keep the downloaded backup safe; PDFs do not sync. Continue?')) return;
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
            <div class="row">
              {auth.status.member && <Button onClick={() => { setMenu(false); navigate(href.school()); }}>Open Library</Button>}
              <span class="spacer" />
              <Button variant="ghost" onClick={() => { void backend!.signOut().catch((e: Error) => toast(e.message)); setMenu(false); }}>Sign out</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
