import { useEffect, useState } from 'preact/hooks';
import { authStore, backend } from '../lib/backend';
import type { Profile, ProfilePatch, ProfileStats } from '../lib/backend/types';
import { href, navigate, toast, useStore } from '../lib/app-state';
import * as store from '../lib/data/db';
import { Button, Field, fmtDate, fmtInt, Modal, plural, Seg, Skeleton, Toggle } from '../ui/kit';
import { Icon } from '../ui/icons';

/** Initials for a photo placeholder: "Josef Yang" -> "JY". */
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** The comma list typed in the editor, as at most 8 distinct subjects of at most 40 characters. */
export function parseSubjects(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean).map((s) => s.slice(0, 40)))].slice(0, 8);
}

/** Practice numbers shared on a profile when the owner allows it: submitted sessions only. */
export async function localStats(): Promise<ProfileStats> {
  const sessions = (await store.getAllSessions()).filter((s) => s.status === 'submitted' || s.status === 'auto-submitted');
  let answered = 0;
  let correct = 0;
  const papers = new Set<string>();
  for (const s of sessions) {
    answered += s.answered ?? 0;
    correct += s.correct ?? 0;
    if (s.type === 'paper' && s.paperId) papers.add(`${s.packId}::${s.paperId}`);
  }
  return { sessions: sessions.length, questions: answered, accuracy: answered ? Math.round((correct / answered) * 100) : 0, papers: papers.size };
}

/** A square WebP photo, at most 512 px, from any image the browser can read. */
async function squarePhoto(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const size = Math.min(512, side);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close();
  return await new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('Could not read that image'))), 'image/webp', 0.85));
}

export function Avatar({ name, src, size = 96 }: { name: string; src: string | null; size?: number }) {
  return src
    ? <img class="avatar" src={src} alt="" width={size} height={size} style={{ width: `${size}px`, height: `${size}px` }} />
    : <span class="avatar avatar--empty" aria-hidden="true" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.36)}px` }}>{initials(name)}</span>;
}

/** #/u/<handle>: a school member's profile. Members only; the server decides who sees what. */
export function ProfileScreen({ handle }: { handle: string }) {
  const auth = useStore(authStore);
  const [p, setP] = useState<Profile | null | 'missing' | 'locked'>(null);
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!backend || !auth.ready) return;
    if (!auth.status.member) { setP('locked'); return; }
    setP(null);
    backend.profile(handle).then(setP).catch(() => setP('missing'));
  }, [handle, auth.ready, auth.status.member, v]);

  if (!backend || p === 'locked') return <main class="page" id="main" tabIndex={-1}><h1>Profiles</h1><p class="muted">Profiles are for school accounts. Sign in with your school Google account to see them.</p></main>;
  if (p === 'missing') return <main class="page" id="main" tabIndex={-1}><h1>Profile not found</h1><p class="muted">It may be private, or the address is wrong.</p><a class="jy-btn" href={href.library()}>Go home</a></main>;
  if (!p) return <main class="page" id="main" tabIndex={-1}><Skeleton h={220} /></main>;
  const stats = p.stats;
  return (
    <main class="page profile" id="main" tabIndex={-1}>
      <section class="jy-panel profile-head" aria-labelledby="profile-name">
        <Avatar name={p.name} src={p.avatar} size={112} />
        <div class="stack-s profile-id">
          <h1 id="profile-name" class="display" style={{ overflowWrap: 'anywhere' }}>{p.name}</h1>
          <span class="small muted">@{p.handle}{p.mine && p.visibility === 'private' ? ' · private' : ''}</span>
          {p.headline && <p class="profile-headline">{p.headline}</p>}
          {p.subjects.length > 0 && <ul class="chips" aria-label="Subjects">{p.subjects.map((s) => <li key={s} class="jy-badge jy-badge--ink">{s}</li>)}</ul>}
        </div>
        <div class="row profile-actions">
          {p.mine ? (
            <Button variant="primary" onClick={() => setEditing(true)}><Icon name="pencil" size={16} /> Edit profile</Button>
          ) : (
            <Button variant="ghost" onClick={() => setReporting(true)}>Report</Button>
          )}
        </div>
      </section>

      <div class="profile-grid">
        <section class="jy-panel stack" aria-labelledby="about-head">
          <h2 id="about-head" class="h3">About</h2>
          {p.bio ? <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{p.bio}</p> : <p class="muted" style={{ margin: 0 }}>{p.mine ? 'Add a short bio so classmates know who you are.' : 'No bio yet.'}</p>}
          <dl class="profile-facts">
            <div><dt class="label">Joined</dt><dd>{fmtDate(typeof p.joined === 'number' ? p.joined : Date.parse(p.joined))}</dd></div>
            <div><dt class="label">Paper sets posted</dt><dd class="num">{fmtInt(p.sets.length)}</dd></div>
            <div><dt class="label">Stars received</dt><dd class="num">{fmtInt(p.starsReceived)}</dd></div>
          </dl>
        </section>
        <section class="jy-panel stack" aria-labelledby="stats-head">
          <h2 id="stats-head" class="h3">Practice</h2>
          {stats && (p.showStats || p.mine) && Object.keys(stats).length ? (
            <>
              <dl class="profile-facts">
                <div><dt class="label">Sessions</dt><dd class="num">{fmtInt(stats.sessions ?? 0)}</dd></div>
                <div><dt class="label">Questions</dt><dd class="num">{fmtInt(stats.questions ?? 0)}</dd></div>
                <div><dt class="label">Accuracy</dt><dd class="num">{stats.accuracy ?? 0}%</dd></div>
                <div><dt class="label">Papers done</dt><dd class="num">{fmtInt(stats.papers ?? 0)}</dd></div>
              </dl>
              {p.mine && !p.showStats && <p class="small muted" style={{ margin: 0 }}>Only you can see these. Turn on "Show my practice numbers" to share them.</p>}
            </>
          ) : <p class="muted" style={{ margin: 0 }}>{p.mine ? 'Share your practice numbers from Edit profile.' : 'Not shared.'}</p>}
        </section>
      </div>

      <section class="stack" aria-labelledby="sets-head">
        <h2 id="sets-head" class="h3">Paper sets</h2>
        {p.sets.length ? (
          <div class="cards">
            {p.sets.map((s) => (
              <a key={s.id} class="jy-panel jy-panel--link stack-s" href={href.school(s.title)}>
                <span class="label">{s.subject || 'Paper set'}</span>
                <b style={{ overflowWrap: 'anywhere' }}>{s.title}</b>
                <span class="small muted">{plural(s.paperCount, 'paper')} · {plural(s.questionCount, 'question')} · <Icon name="target" size={12} /> {fmtInt(s.stars)} stars · version {s.version}</span>
              </a>
            ))}
          </div>
        ) : <p class="muted">{p.mine ? 'Paper sets you post to the School Library appear here.' : 'No paper sets posted yet.'}</p>}
      </section>

      {editing && <ProfileEditor profile={p} onClose={(changed) => { setEditing(false); if (changed) setV((x) => x + 1); }} />}
      {reporting && <ReportProfile handle={p.handle} onClose={() => setReporting(false)} />}
    </main>
  );
}

function ProfileEditor({ profile, onClose }: { profile: Profile; onClose: (changed: boolean) => void }) {
  const auth = useStore(authStore);
  const [name, setName] = useState(profile.name);
  const [handle, setHandle] = useState(profile.handle);
  const [headline, setHeadline] = useState(profile.headline);
  const [bio, setBio] = useState(profile.bio);
  const [subjects, setSubjects] = useState(profile.subjects.join(', '));
  const [visibility, setVisibility] = useState<'school' | 'private'>(profile.visibility ?? 'school');
  const [showStats, setShowStats] = useState(profile.showStats);
  const [photo, setPhoto] = useState<Blob | null | undefined>(undefined);
  const [preview, setPreview] = useState<string | null>(profile.avatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      const b = await squarePhoto(f);
      if (b.size > 512 * 1024) throw new Error('That photo is too large even after resizing. Try another one.');
      setPhoto(b);
      setPreview(URL.createObjectURL(b));
    } catch (e) { setError((e as Error).message); }
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (name.trim() !== auth.account?.name) await backend!.updateName(name.trim());
      const patch: ProfilePatch = { headline: headline.trim(), bio: bio.trim(), subjects: parseSubjects(subjects), visibility, showStats };
      if (handle.trim().toLowerCase() !== profile.handle) patch.handle = handle.trim().toLowerCase();
      patch.stats = await localStats();
      const r = await backend!.updateProfile(patch);
      if (photo !== undefined) await backend!.setAvatar(photo);
      const acc = authStore.get().account;
      if (acc) authStore.set({ ...authStore.get(), account: { ...acc, name: name.trim(), handle: r.handle } });
      toast('Profile saved.');
      if (r.handle !== profile.handle) navigate(href.profile(r.handle));
      onClose(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Edit profile" size="wide" onClose={() => onClose(false)} footer={<><Button onClick={() => onClose(false)}>Cancel</Button><Button variant="accent" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button></>}>
      <div class="stack">
        <div class="row" style={{ alignItems: 'center' }}>
          <Avatar name={name} src={preview} size={72} />
          <label class="jy-btn jy-btn--sm">
            <Icon name="image" size={16} /> Choose photo
            <input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => void pick((e.target as HTMLInputElement).files?.[0])} />
          </label>
          {preview && <Button size="sm" variant="ghost" onClick={() => { setPhoto(null); setPreview(null); }}>Remove photo</Button>}
        </div>
        <Field label="Name" hint="Shown on your profile and on paper sets you post."><input class="input" name="name" maxLength={80} value={name} onInput={(e) => setName(e.currentTarget.value)} /></Field>
        <Field label="Profile address" hint="3 to 30 letters, digits, dots, dashes or underscores."><input class="input" name="handle" maxLength={30} value={handle} onInput={(e) => setHandle(e.currentTarget.value)} /></Field>
        <Field label="Headline" hint="For example: Year 12 · Physics, Chemistry, Maths."><input class="input" name="headline" maxLength={80} value={headline} onInput={(e) => setHeadline(e.currentTarget.value)} /></Field>
        <Field label="Bio" hint={`${160 - bio.length} characters left.`}><textarea class="input" name="bio" rows={3} maxLength={160} value={bio} onInput={(e) => setBio(e.currentTarget.value)} /></Field>
        <Field label="Subjects" hint="Separate with commas; up to 8."><input class="input" name="subjects" value={subjects} onInput={(e) => setSubjects(e.currentTarget.value)} /></Field>
        <Seg label="Who can see your profile" value={visibility} onChange={setVisibility} options={[{ value: 'school', label: 'School accounts' }, { value: 'private', label: 'Only me' }]} />
        <Toggle label="Show my practice numbers" checked={showStats} onChange={setShowStats} hint="Sessions, questions answered, accuracy and papers done, from this device. Never answers or mistakes." />
        <p class="small muted" style={{ margin: 0 }}>Profiles are only visible inside the school, never on the public web.</p>
        {error && <p class="small" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

function ReportProfile({ handle, onClose }: { handle: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { await backend!.reportProfile(handle, reason.trim()); toast('Reported. An admin will look at it.'); onClose(); }
    catch (e) { toast((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Report profile" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void send()}>Report</Button></>}>
      <Field label="What is wrong?" hint="Admins see your report, not the person reported."><textarea class="input" rows={3} maxLength={500} value={reason} onInput={(e) => setReason(e.currentTarget.value)} /></Field>
    </Modal>
  );
}

