import { useEffect, useRef, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { authStore, backend } from '../lib/backend';
import { SCHOOL_DOMAINS, type LibrarySet } from '../lib/backend/types';
import { coverSvg } from '../lib/library/cover';
import { downloadSet, updateAvailable } from '../lib/library/download';
import { buildPlan, loadPending, postSet, prepareFromFiles, prepareFromPack, savePending, type PostPlan, type PostStep, type Prepared } from '../lib/library/post';
import { embeddedFontCss, svgToPng } from '../lib/share/fonts';
import { bump, href, navigate, toast, useStore } from '../lib/app-state';
import { broadcastChange } from '../lib/tablock';
import type { Pack } from '../lib/types';
import { isPaperKey, paperKeyFromName, qpKeyOf } from '../../shared/paper-key';
import { Badge, Button, Field, Menu, Modal, Skeleton, fmtInt } from '../ui/kit';
import { Icon } from '../ui/icons';
import { AccountDialog } from './account';

const PAGE = 24;
const mb = (b: number) => `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`;

export function SchoolLibrary() {
  const auth = useStore(authStore);
  const [dialog, setDialog] = useState<'school' | null>(null);
  const domain = SCHOOL_DOMAINS[0]!;

  if (!backend)
    return (
      <main class="page" id="main" tabIndex={-1}>
        <Hero />
        <div class="locked" style={{ minHeight: '200px' }}>
          <b>The school Library is not set up on this copy of DMC</b>
          <span class="small">The owner connects it once by following setup.md. Everything else works without it.</span>
        </div>
      </main>
    );
  if (!auth.ready)
    return (
      <main class="page" aria-busy="true">
        <Hero />
        <div class="cards"><Skeleton h={320} /><Skeleton h={320} /><Skeleton h={320} /></div>
      </main>
    );
  if (!auth.account || !auth.status.member)
    return (
      <main class="page" id="main" tabIndex={-1}>
        <Hero />
        <div class="locked library-locked">
          <Icon name="alert" size={28} />
          <b>{auth.account ? 'The Library is locked for this account' : 'Sign in with your school Google account to open the Library'}</b>
          <span class="small">
            Paper sets shared at school for study, open to verified @{domain} accounts.
            {auth.account ? ` You are signed in as ${auth.account.email}; sign in with your @${domain} account to unlock it.` : ''}
          </span>
          <Button variant="accent" onClick={() => setDialog('school')}>Sign in with school account</Button>
        </div>
        {dialog && <AccountDialog mode="school" onClose={() => setDialog(null)} />}
      </main>
    );
  return <Members admin={auth.status.admin} />;
}

function Hero() {
  return (
    <section class="hero" style={{ paddingBottom: 'var(--space-5)' }}>
      <h1 class="display"><span class="light">School</span> Library</h1>
    </section>
  );
}

function Members({ admin }: { admin: boolean }) {
  const [sets, setSets] = useState<LibrarySet[] | null>(null);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [posting, setPosting] = useState(false);
  const [pending, setPending] = useState<PostPlan | null>(null);
  const [reporting, setReporting] = useState<LibrarySet | null>(null);
  const [deleting, setDeleting] = useState<LibrarySet | null>(null);
  const [choice, setChoice] = useState<{ set: LibrarySet; changed: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [local, setLocal] = useState<Pack[]>([]);

  const load = async (offset = 0) => {
    try {
      const page = await backend!.listSets({ search, limit: PAGE, offset });
      setSets((prev) => (offset ? [...(prev ?? []), ...page] : page));
      setMore(page.length === PAGE);
      setError('');
    } catch (e) {
      setError((e as Error).message || 'The Library could not be reached.');
      setSets((s) => s ?? []);
    }
  };
  const refreshLocal = () => void store.getPacks().then(setLocal);
  useEffect(() => {
    const t = setTimeout(() => void load(0), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    void loadPending().then(setPending);
    refreshLocal();
  }, [posting]);

  const toggleStar = async (s: LibrarySet) => {
    setSets(sets!.map((x) => (x.id === s.id ? { ...x, starred: !s.starred, stars: x.stars + (s.starred ? -1 : 1) } : x)));
    try {
      await backend!.star(s.id, !s.starred);
    } catch (e) {
      toast((e as Error).message);
      void load(0);
    }
  };
  const download = async (s: LibrarySet, prefer?: 'mine' | 'theirs') => {
    setBusy(s.id);
    try {
      const r = await downloadSet(s, { ...(prefer ? { prefer } : {}), onFile: (n, of) => of > 1 && toast(`Downloading ${s.title}: file ${n} of ${of}`) });
      if ('needsChoice' in r) { setChoice({ set: s, changed: r.needsChoice }); return; }
      bump();
      broadcastChange();
      refreshLocal();
      toast(`${s.title} is ready to practise.`, { label: 'Open', run: () => navigate(href.pack(r.packId)) });
    } catch (e) {
      toast((e as Error).message || 'Download failed.');
    } finally {
      setBusy(null);
    }
  };
  const remove = async (s: LibrarySet) => {
    try {
      await backend!.deleteSet(s.id);
      setSets(sets!.filter((x) => x.id !== s.id));
      toast('Removed from the Library. Copies already downloaded stay on those devices.');
    } catch (e) {
      toast((e as Error).message);
    }
    setDeleting(null);
  };
  const restore = async (s: LibrarySet) => {
    try { await backend!.updateSet(s.id, { status: 'approved' }); void load(0); }
    catch (e) { toast((e as Error).message); }
  };

  return (
    <main class="page" id="main" tabIndex={-1}>
      <section class="hero" style={{ paddingBottom: 'var(--space-5)' }}>
        <div class="row" style={{ alignItems: 'flex-end', gap: 'var(--space-5)' }}>
          <div class="stack-s" style={{ flex: 1, minWidth: '240px' }}>
            <h1 class="display"><span class="light">School</span> Library</h1>
            <p class="muted">Paper sets shared at school. Most starred first.</p>
          </div>
          {admin && <Button onClick={() => navigate('#/admin')}><Icon name="settings" size={18} /> Admin</Button>}
          <Button variant="accent" size="lg" onClick={() => setPosting(true)}><Icon name="upload" size={18} /> Post a set</Button>
        </div>
      </section>
      <div class="notice" style={{ marginBottom: 'var(--space-5)' }}>
        <Icon name="info" />
        <div class="small">Shared for study within the school only. Post only papers you are allowed to share, and report anything that should not be here.</div>
      </div>
      {pending && !posting && (
        <div class="notice notice--warn" style={{ marginBottom: 'var(--space-5)' }}>
          <Badge status="warn">Not finished</Badge>
          <div class="row" style={{ justifyContent: 'space-between' }}>
            <span class="small">"{pending.manifest.meta.title}" was not fully posted.</span>
            <div class="row">
              <Button variant="ghost" onClick={() => void savePending(null).then(() => setPending(null))}>Discard</Button>
              <Button onClick={() => setPosting(true)}>Resume</Button>
            </div>
          </div>
        </div>
      )}
      <div class="lib-tools">
        <label class="sr-only" for="set-search">Search the Library</label>
        <input id="set-search" class="input" type="search" placeholder="Search sets" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
      </div>
      {error && (
        <div class="notice notice--bad" role="alert" style={{ marginBottom: 'var(--space-4)' }}>
          <Badge status="bad">Offline</Badge>
          <div class="row" style={{ justifyContent: 'space-between' }}><span class="small">{error}</span><Button onClick={() => void load(0)}>Try again</Button></div>
        </div>
      )}
      {!sets ? (
        <div class="cards" aria-busy="true"><Skeleton h={320} /><Skeleton h={320} /><Skeleton h={320} /></div>
      ) : !sets.length && !error ? (
        <div class="locked" style={{ minHeight: '200px' }}>
          <b>{search ? 'No sets match' : 'Nothing shared yet'}</b>
          <span class="small">{search ? 'Try another word.' : 'Post the first set: papers on your device, a paper-set zip, or PDFs.'}</span>
        </div>
      ) : (
        <div class="cards set-cards">
          {sets.map((s) => {
            const state = updateAvailable(s, local);
            return (
              <article class="jy-panel set-card" key={s.id} aria-labelledby={`set-${s.id}`}>
                <Cover set={s} />
                <div class="stack-s">
                  <h2 id={`set-${s.id}`} class="h3">{s.title}</h2>
                  {s.description && <p class="small muted set-desc">{s.description}</p>}
                  <div class="meta small muted">
                    <span>{s.ownerName}</span>
                    <span><span class="num">{fmtInt(s.paperCount)}</span> paper{s.paperCount === 1 ? '' : 's'}</span>
                    <span>version <span class="num">{s.version}</span></span>
                    {!s.keyed && <span>key partly missing</span>}
                  </div>
                  <div class="set-status">
                    {s.status === 'hidden' && <Badge status="warn">Hidden after reports</Badge>}
                    {state === 'update' && <Badge status="warn">Update available</Badge>}
                    {state === 'current' && <Badge status="ok">On this device</Badge>}
                  </div>
                </div>
                <div class="row set-actions">
                  <Button variant="ghost" size="sm" aria-pressed={s.starred} aria-label={`${s.starred ? 'Unstar' : 'Star'} ${s.title}, ${s.stars} star${s.stars === 1 ? '' : 's'}`} onClick={() => void toggleStar(s)}>
                    <svg class="star" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill={s.starred ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" /></svg> <span class="num">{s.stars}</span>
                  </Button>
                  <span class="spacer" />
                  <Menu label={`More actions for ${s.title}`} items={[
                    { label: 'Report', onSelect: () => setReporting(s), hidden: s.mine },
                    { label: 'Restore', onSelect: () => void restore(s), hidden: !(admin && s.status === 'hidden') },
                    { label: s.mine ? 'Delete' : 'Remove for everyone', onSelect: () => setDeleting(s), danger: true, hidden: !(s.mine || admin) },
                  ]} />
                  <Button size="sm" disabled={busy === s.id} onClick={() => void download(s)}>
                    <Icon name="download" size={16} /> {busy === s.id ? 'Downloading…' : state === 'update' ? 'Update' : state === 'current' ? 'Download again' : 'Download'}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {more && <div style={{ marginTop: 'var(--space-5)' }}><Button onClick={() => void load(sets?.length ?? 0)}>Show more</Button></div>}
      {posting && <PostDialog resume={pending} onClose={(posted) => { setPosting(false); if (posted) void load(0); }} />}
      {reporting && <ReportDialog set={reporting} onClose={() => setReporting(null)} />}
      {deleting && (
        <Modal title={deleting.mine ? `Delete "${deleting.title}"?` : `Remove "${deleting.title}" for everyone?`} onClose={() => setDeleting(null)} footer={<><Button onClick={() => setDeleting(null)} autoFocus>Keep it</Button><Button variant="danger" onClick={() => void remove(deleting)}>{deleting.mine ? 'Delete set' : 'Remove set'}</Button></>}>
          <p>It leaves the Library for everyone. Copies already downloaded stay on those devices, and nobody loses their progress.</p>
        </Modal>
      )}
      {choice && (
        <Modal title="Some questions differ from your copy" onClose={() => setChoice(null)} footer={<>
          <Button onClick={() => { const c = choice; setChoice(null); void download(c.set, 'mine'); }}>Keep mine</Button>
          <Button variant="primary" onClick={() => { const c = choice; setChoice(null); void download(c.set, 'theirs'); }} autoFocus>Use the Library's</Button>
        </>}>
          <p>{choice.changed} question{choice.changed === 1 ? ' was' : 's were'} edited, either on this device or in the Library's newer version. Your answers and statistics stay either way.</p>
          <p class="small muted">Keep mine leaves your edited questions as they are and adds everything else that is new.</p>
        </Modal>
      )}
    </main>
  );
}

const covers = new Map<string, Promise<string>>();
function Cover({ set }: { set: LibrarySet }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const key = set.coverHash ?? `gen:${set.title}`;
    if (!covers.has(key))
      covers.set(
        key,
        set.coverHash
          ? backend!.blobUrl(set.coverHash).then((u) => u ?? Promise.reject(new Error('none')))
          : Promise.resolve(URL.createObjectURL(new Blob([coverSvg(set.title, [set.subject, set.code].filter(Boolean).join(' '))], { type: 'image/svg+xml' }))),
      );
    covers.get(key)!.then((u) => live && setUrl(u), () => covers.delete(key));
    return () => {
      live = false;
    };
  }, [set.coverHash, set.title]);
  return <div class="set-cover">{url ? <img src={url} alt="" loading="lazy" /> : <div class="skel" style={{ height: '100%' }} />}</div>;
}

function ReportDialog({ set, onClose }: { set: LibrarySet; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const send = async () => {
    try {
      await backend!.report(set.id, reason.trim());
      toast('Reported. Thank you. Three reports hide a set until an admin looks at it.');
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <Modal title={`Report "${set.title}"`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!reason.trim()} onClick={() => void send()}>Send report</Button></>}>
      <Field label="What is wrong?" hint="For example: not a past paper, wrong answers, personal information, not ours to share.">
        <textarea class="textarea" style={{ fontFamily: 'var(--font-sans)', minHeight: '96px' }} maxLength={500} value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
      </Field>
    </Modal>
  );
}

const STEP_LABELS = ['Checking', 'Uploading files', 'Publishing'] as const;
function Stepper({ step }: { step: PostStep | null }) {
  const at = !step ? -1 : step.step === 'checking' ? 0 : step.step === 'uploading' ? 1 : 2;
  return (
    <ol class="stepper" aria-label="Posting steps">
      {STEP_LABELS.map((l, i) => (
        <li key={l} data-state={i < at ? 'done' : i === at ? 'now' : 'todo'} aria-current={i === at ? 'step' : undefined}>
          {i === 1 && step?.step === 'uploading' ? `Uploading file ${step.file} of ${step.files}` : l}
        </li>
      ))}
    </ol>
  );
}

/** One row of the matching table: the paper, its key and where the key came from. */
function KeyRow({ k, value, onChange }: { k: Prepared['keys'][number]; value: string; onChange: (v: string) => void }) {
  const typed = value.trim().toLowerCase();
  const ok = !typed || isPaperKey(typed) || !!paperKeyFromName(typed);
  return (
    <tr>
      <td>{k.title}</td>
      <td>
        {k.status === 'found' ? <code>{k.key}</code> : (
          <input class="input" aria-label={`Paper key for ${k.title}`} placeholder={k.suggestion ?? '9702_s24_qp_12'} value={value} aria-invalid={!ok} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
        )}
      </td>
      <td>
        {k.status === 'found' && <Badge status="ok">Found{k.from ? ` (${k.from})` : ''}</Badge>}
        {k.status === 'confirm' && (typed && ok ? <Badge status="ok">Confirmed</Badge> : <Badge status="warn">Confirm</Badge>)}
        {k.status === 'missing' && (typed && ok ? <Badge status="ok">Entered</Badge> : <Badge status="neutral">Not found</Badge>)}
      </td>
    </tr>
  );
}

/**
 * Posting a set. Choose papers (a paper set on this device, a zip, or PDFs); everything that can
 * be worked out is filled in and checked before anything uploads; the matching table shows each
 * paper's key; Post stays disabled until something is chosen and every guessed key is confirmed.
 * Progress is stepped and resumable; errors name the file.
 */
function PostDialog({ resume, onClose }: { resume: PostPlan | null; onClose: (posted: boolean) => void }) {
  const auth = useStore(authStore);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(resume?.manifest.meta.title ?? '');
  const [desc, setDesc] = useState(resume?.manifest.meta.description ?? '');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [cover, setCover] = useState<Blob | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const [step, setStep] = useState<PostStep | null>(null);
  const [failure, setFailure] = useState('');
  const [state, setState] = useState<'edit' | 'posting' | 'paused' | 'posted'>(resume ? 'paused' : 'edit');
  const abort = useRef<AbortController | null>(null);
  const plan = useRef<PostPlan | null>(resume);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => void store.getPacks().then((ps) => setPacks(ps.filter((p) => p.origin?.kind !== 'library'))), []);
  useEffect(() => {
    if (!cover) return setCoverUrl(null);
    const u = URL.createObjectURL(cover);
    setCoverUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [cover]);

  const use = async (p: Promise<Prepared>) => {
    setBusy(true);
    try {
      const r = await p;
      setPrep(r);
      setTitle(r.meta.title);
      setDesc(r.meta.description);
      setKeys({});
    } catch (e) {
      toast((e as Error).message || 'That could not be read.');
    }
    setBusy(false);
  };

  const confirmedKeys = () => Object.fromEntries(Object.entries(keys).map(([id, v]) => {
    const t = v.trim().toLowerCase();
    return [id, isPaperKey(t) ? qpKeyOf(t) : paperKeyFromName(t) ? qpKeyOf(paperKeyFromName(t)!) : ''];
  }).filter(([, v]) => v));
  const unconfirmed = prep ? prep.keys.filter((k) => k.status === 'confirm' && !confirmedKeys()[k.docId]) : [];
  const badEntry = Object.values(keys).some((v) => v.trim() && !isPaperKey(v.trim().toLowerCase()) && !paperKeyFromName(v.trim()));
  const defaultCover = async () => svgToPng(coverSvg(title, [prep?.meta.subject, prep?.meta.code].filter(Boolean).join(' '), await embeddedFontCss()), 600, 800);

  const run = async () => {
    setFailure('');
    try {
      if (!plan.current) {
        if (!prep) return;
        setBusy(true);
        plan.current = await buildPlan(prep, { ...prep.meta, title: title.trim() || prep.meta.title, description: desc.trim() }, confirmedKeys(), cover ?? (await defaultCover()));
        setBusy(false);
      }
      abort.current = new AbortController();
      setState('posting');
      await postSet(plan.current, setStep, abort.current.signal);
      setState('posted');
    } catch (e) {
      setBusy(false);
      if (!plan.current) return toast((e as Error).message);
      setState('paused');
      if ((e as Error).name !== 'AbortError') setFailure((e as Error).message || 'Posting stopped. Resume when you are back online.');
    }
  };

  if (state === 'posted')
    return (
      <Modal title="Posted" onClose={() => onClose(true)} footer={<Button variant="primary" onClick={() => onClose(true)} autoFocus>Done</Button>}>
        <p><b>{plan.current?.manifest.meta.title}</b> is in the Library for everyone at school. Posting it again later adds a new version; copies update instead of doubling.</p>
      </Modal>
    );
  if (state !== 'edit') {
    const pct = step?.step === 'uploading' ? Math.round((step.sent / Math.max(1, step.total)) * 100) : step?.step === 'publishing' ? 100 : 0;
    return (
      <Modal title={state === 'posting' ? 'Posting…' : 'Posting paused'} onClose={() => { abort.current?.abort(); onClose(false); }} dismissable={state !== 'posting'}>
        <div class="stack">
          <p><b>{plan.current?.manifest.meta.title}</b></p>
          <Stepper step={step} />
          {step?.step === 'uploading' && (
            <>
              <div class="progress" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div style={{ transform: `scaleX(${pct / 100})` }} /></div>
              <p class="small muted num" aria-live="polite">{step.label} · {mb(step.sent)} of {mb(step.total)}</p>
            </>
          )}
          {failure && <div class="notice notice--bad" role="alert"><Badge status="bad">Stopped</Badge><div class="small">{failure}</div></div>}
          <div class="modal-foot" style={{ marginTop: 0 }}>
            {state === 'posting' ? (
              <Button onClick={() => abort.current?.abort()}>Cancel</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => void savePending(null).then(() => onClose(false))}>Discard</Button>
                <Button variant="primary" onClick={() => void run()}>Resume</Button>
              </>
            )}
          </div>
        </div>
      </Modal>
    );
  }

  const blocked = !prep || busy || !title.trim() || unconfirmed.length > 0 || badEntry;
  return (
    <Modal title="Post a set" size="wide" onClose={() => onClose(false)} footer={
      <>
        {prep && unconfirmed.length > 0 && <span class="small muted" style={{ marginRight: 'auto' }}>Confirm {unconfirmed.length} paper key{unconfirmed.length === 1 ? '' : 's'} to post</span>}
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button variant="primary" disabled={blocked} onClick={() => void run()}><Icon name="upload" size={18} /> {busy && prep ? 'Preparing…' : 'Post'}</Button>
      </>
    }>
      <div class="stack">
        {!prep ? (
          <>
            <p><b>What to upload:</b> question papers with their mark schemes (PDFs), a paper-set zip, or a paper set already on this device. DMC reads what it can and checks everything before anything uploads.</p>
            <div class="row">
              <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={busy}><Icon name="file" size={18} /> Choose PDFs or zip</Button>
              <input ref={fileRef} type="file" hidden multiple accept=".zip,.pdf,application/zip,application/pdf" onChange={(e) => void use(prepareFromFiles([...((e.target as HTMLInputElement).files ?? [])]))} />
              {packs.length > 0 && (
                <>
                  <label class="sr-only" for="post-pack">A paper set on this device</label>
                  <select id="post-pack" class="select" style={{ width: 'auto' }} value="" onChange={(e) => { const p = packs.find((x) => x.id === (e.target as HTMLSelectElement).value); if (p) void use(prepareFromPack(p)); }}>
                    <option value="">Or a paper set on this device…</option>
                    {packs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                </>
              )}
            </div>
            {busy && <p class="small muted" aria-live="polite">Checking…</p>}
          </>
        ) : (
          <div class="post-grid">
            <div class="stack-s">
              <div class="set-cover post-cover">{coverUrl ? <img src={coverUrl} alt="Cover" /> : <DefaultCoverPreview title={title} sub={[prep.meta.subject, prep.meta.code].filter(Boolean).join(' ')} />}</div>
              <div class="row">
                <label class="jy-btn jy-btn--sm">
                  <Icon name="image" size={16} /> Choose cover
                  <input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) setCropping(f); }} />
                </label>
                {cover && <Button variant="ghost" size="sm" onClick={() => setCover(null)}>Use default</Button>}
              </div>
            </div>
            <div class="stack">
              <Field label="Name"><input class="input" maxLength={120} value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></Field>
              <Field label="Description" hint="Optional. What is in it, and anything to know.">
                <textarea class="textarea" style={{ fontFamily: 'var(--font-sans)', minHeight: '80px' }} maxLength={1000} value={desc} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} />
              </Field>
              <div class="chips" aria-label="Detected">{prep.facts.map((f) => <span class="jy-badge jy-badge--ink" key={f}>{f}</span>)}</div>
              <div class="stack-s">
                <h3 class="h3" style={{ fontSize: '16px' }}>Papers</h3>
                <table class="key-table">
                  <thead><tr><th scope="col">Paper</th><th scope="col">Paper key</th><th scope="col">Status</th></tr></thead>
                  <tbody>{prep.keys.map((k) => <KeyRow key={k.docId} k={k} value={keys[k.docId] ?? ''} onChange={(v) => setKeys({ ...keys, [k.docId]: v })} />)}</tbody>
                </table>
                <p class="small muted">A paper key is Cambridge's file name, such as 9702_s24_qp_12. It links the same paper across sets, so nobody uploads it twice and copies never double. Keys that were not found are optional.</p>
              </div>
              <p class="small subtle">Checked: {prep.report.warnings.length ? `${prep.report.warnings.length} note${prep.report.warnings.length === 1 ? '' : 's'}, no errors` : 'no problems found'}. Posting as {auth.account?.name}{prep.base ? `, as version ${prep.base + 1}` : ''}.</p>
            </div>
          </div>
        )}
      </div>
      {cropping && <CoverCrop file={cropping} onClose={() => setCropping(null)} onDone={(b) => { setCover(b); setCropping(null); }} />}
    </Modal>
  );
}

function DefaultCoverPreview({ title, sub }: { title: string; sub: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([coverSvg(title, sub)], { type: 'image/svg+xml' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [title, sub]);
  return url ? <img src={url} alt="Default cover" /> : null;
}

/** A fixed 3:4 frame: drag to position, slider to zoom, Done draws a 600 x 800 PNG. */
function CoverCrop({ file, onClose, onDone }: { file: File; onClose: () => void; onDone: (b: Blob) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const W = 300;
  const H = 400;
  useEffect(() => {
    if (file.size > 15_000_000) {
      toast('That image is over 15 MB.');
      return onClose();
    }
    const u = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => {
      toast('That image could not be opened.');
      onClose();
    };
    i.src = u;
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const base = img ? Math.max(W / img.naturalWidth, H / img.naturalHeight) : 1;
  const s = base * zoom;
  const clamp = (o: { x: number; y: number }) => (img ? { x: Math.min(0, Math.max(W - img.naturalWidth * s, o.x)), y: Math.min(0, Math.max(H - img.naturalHeight * s, o.y)) } : o);
  const pos = clamp(off);
  const done = () => {
    if (!img) return;
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 800;
    c.getContext('2d')!.drawImage(img, -pos.x / s, -pos.y / s, W / s, H / s, 0, 0, 600, 800);
    c.toBlob((b) => b && onDone(b), 'image/png');
  };
  return (
    <Modal title="Crop cover" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={done} disabled={!img}>Use cover</Button></>}>
      <div class="stack">
        <div class="crop-frame" style={{ width: `${W}px`, height: `${H}px` }}
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y }; }}
          onPointerMove={(e) => { if (drag.current) setOff(clamp({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y })); }}
          onPointerUp={() => (drag.current = null)}>
          {img && <img src={img.src} alt="" draggable={false} style={{ width: `${img.naturalWidth * s}px`, height: `${img.naturalHeight * s}px`, transform: `translate(${pos.x}px, ${pos.y}px)` }} />}
        </div>
        <label class="jy-field">
          <span>Zoom</span>
          <input type="range" min={1} max={3} step={0.01} value={zoom} onInput={(e) => setZoom(Number((e.target as HTMLInputElement).value))} />
        </label>
        <p class="small muted">Drag the picture to place it in the frame.</p>
      </div>
    </Modal>
  );
}
