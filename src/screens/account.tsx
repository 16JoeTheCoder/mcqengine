import { useState } from 'preact/hooks';
import { authStore, backend } from '../lib/backend';
import { SCHOOL_DOMAINS, isSchoolEmail } from '../lib/backend/types';
import { href, navigate, toast, useStore } from '../lib/app-state';
import { Button, Field, Modal, Seg } from '../ui/kit';
import { Icon } from '../ui/icons';

export type AccountMode = 'school' | 'personal';

/**
 * Sign in. School: Google (with the school domain as a chooser hint only) or an email link; the
 * server decides Library access from the verified email. Personal: Google or an email link, for
 * sync and backups. Never required: everything except the Library works signed out.
 */
export function AccountDialog({ mode: initial, onClose }: { mode: AccountMode; onClose: () => void }) {
  const [mode, setMode] = useState<AccountMode>(initial);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const domain = SCHOOL_DOMAINS[0]!;

  if (!backend)
    return (
      <Modal title="Accounts" onClose={onClose}>
        <p class="muted">Accounts are not set up on this copy of DMC yet. Everything else works without one, on this device.</p>
      </Modal>
    );

  const google = async () => {
    setBusy(true);
    try {
      await backend!.signInGoogle(mode === 'school');
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };
  const link = async (e: Event) => {
    e.preventDefault();
    if (mode === 'school' && !isSchoolEmail(email)) return toast(`Use your @${domain} address for the Library, or create a personal account.`);
    setBusy(true);
    try {
      await backend!.signInEmail(email);
      if (backend!.kind === 'mock') {
        toast(`Signed in as ${email.trim().toLowerCase()} (development backend).`);
        onClose();
      } else setSent(true);
    } catch (err) {
      toast((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <Modal title={mode === 'school' ? 'Sign in with school email' : 'Create a personal account'} onClose={onClose}>
      <div class="stack">
        <Seg label="Account type" value={mode} onChange={(m) => { setMode(m); setSent(false); }} options={[{ value: 'school', label: 'School email' }, { value: 'personal', label: 'Personal' }]} />
        <p class="small muted">
          {mode === 'school'
            ? `Your @${domain} account unlocks the school Library and syncs your progress across devices.`
            : 'A personal account (any Google or email address) syncs your progress across devices. The school Library needs a school email.'}
        </p>
        {sent ? (
          <div class="notice notice--ok" role="status">
            <span class="jy-badge jy-badge--ok">Link sent</span>
            <div class="small">Open the link we emailed to {email.trim()} on this device to finish signing in.</div>
          </div>
        ) : (
          <>
            {backend.kind === 'supabase' && (
              <Button variant="primary" onClick={() => void google()} disabled={busy}>
                Continue with Google{mode === 'school' ? ` (@${domain})` : ''}
              </Button>
            )}
            <form class="stack-s" onSubmit={link}>
              <Field label={backend.kind === 'mock' ? 'Email (development sign-in, no password)' : 'Or get a sign-in link by email'}>
                <input class="input" type="email" autoComplete="email" required placeholder={mode === 'school' ? `name@${domain}` : 'you@example.com'} value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
              </Field>
              <div>
                <Button type="submit" variant={backend.kind === 'mock' ? 'primary' : 'default'} disabled={busy || !email.trim()}>
                  {backend.kind === 'mock' ? 'Sign in' : 'Email me a link'}
                </Button>
              </div>
            </form>
          </>
        )}
        <p class="small subtle">DMC keeps working without an account. Signing in never uploads your PDFs or packs unless you choose to back them up.</p>
      </div>
    </Modal>
  );
}

/** Top-bar account control: Sign in when signed out; a menu with status and sign out when signed in. */
export function AccountButton({ onSync, syncLabel }: { onSync?: () => void; syncLabel?: string }) {
  const auth = useStore(authStore);
  const [dialog, setDialog] = useState<AccountMode | null>(null);
  const [menu, setMenu] = useState(false);
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
            <div class="row">
              {auth.status.member && <Button onClick={() => { setMenu(false); navigate(href.school()); }}>Open Library</Button>}
              <span class="spacer" />
              <Button variant="ghost" onClick={() => { void backend!.signOut(); setMenu(false); toast('Signed out. Your packs and progress stay on this device.'); }}>Sign out</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
