import { useEffect, useRef, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { authStore, backend } from '../lib/backend';
import { SCHOOL_DOMAINS, type LibrarySet } from '../lib/backend/types';
import { coverSvg } from '../lib/library/cover';
import { downloadSet, libraryPackId } from '../lib/library/download';
import { loadPending, postSet, prepareFromFiles, prepareFromPack, savePending, type PostPlan, type Prepared } from '../lib/library/post';
import { embeddedFontCss, svgToPng } from '../lib/share/fonts';
import { bump, href, navigate, toast, useStore } from '../lib/app-state';
import { broadcastChange } from '../lib/tablock';
import type { Pack } from '../lib/types';
import { Badge, Button, Field, Modal, Skeleton, fmtInt } from '../ui/kit';
import { Icon } from '../ui/icons';
import { AccountDialog } from './account';

const PAGE = 24;

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
          <span class="small">The owner connects it once by following docs/SUPABASE_SETUP.md. Everything else works without it.</span>
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
          <b>{auth.account ? 'The Library is locked for this account' : 'Sign in with your school email to open the Library'}</b>
          <span class="small">
            Past papers shared by students for school study, open to verified @{domain} accounts.
            {auth.account ? ` You are signed in as ${auth.account.email}; sign in with your @${domain} address to unlock it.` : ''}
          </span>
          <Button variant="accent" onClick={() => setDialog('school')}>Sign in with school email</Button>
        </div>
        {dialog && <AccountDialog mode="school" onClose={() => setDialog(null)} />}
      </main>
    );
  return <Members admin={auth.status.admin} name={auth.account.name} />;
}

function Hero() {
  return (
    <section class="hero" style={{ paddingBottom: 'var(--space-5)' }}>
      <h1 class="display"><span class="light">School</span> Library</h1>
    </section>
  );
}

function Members({ admin, name }: { admin: boolean; name: string }) {
  const [sets, setSets] = useState<LibrarySet[] | null>(null);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [posting, setPosting] = useState(false);
  const [pending, setPending] = useState<PostPlan | null>(null);
  const [reporting, setReporting] = useState<LibrarySet | null>(null);
  const [error, setError] = useState('');
  const [local, setLocal] = useState<Set<string>>(new Set());

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
  useEffect(() => {
    const t = setTimeout(() => void load(0), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    void loadPending().then(setPending);
    void store.getPacks().then((ps) => setLocal(new Set(ps.map((p) => p.id))));
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
  const download = async (s: LibrarySet) => {
    try {
      toast(`Downloading ${s.title}…`);
      const id = await downloadSet(s);
      bump();
      broadcastChange();
      toast(`${s.title} is ready to practise.`, { label: 'Open', run: () => navigate(href.pack(id)) });
      setLocal(new Set([...local, id]));
    } catch (e) {
      toast((e as Error).message || 'Download failed.');
    }
  };
  const remove = async (s: LibrarySet) => {
    if (!confirm(s.mine ? `Delete "${s.title}" from the Library? Copies already downloaded stay on those devices.` : `Remove "${s.title}" from the Library for everyone?`)) return;
    try {
      await backend!.deleteSet(s);
      setSets(sets!.filter((x) => x.id !== s.id));
      toast('Removed from the Library.');
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const restore = async (s: LibrarySet) => {
    await backend!.updateSet(s.id, { status: 'approved' });
    void load(0);
  };

  return (
    <main class="page" id="main" tabIndex={-1}>
      <section class="hero" style={{ paddingBottom: 'var(--space-5)' }}>
        <div class="row" style={{ alignItems: 'flex-end', gap: 'var(--space-5)' }}>
          <div class="stack-s" style={{ flex: 1, minWidth: '240px' }}>
            <h1 class="display"><span class="light">School</span> Library</h1>
            <p class="muted">Paper sets shared by students. Most starred first.</p>
          </div>
          <Button variant="accent" size="lg" onClick={() => setPosting(true)}><Icon name="upload" size={18} /> Post a set</Button>
        </div>
      </section>
      <div class="notice" style={{ marginBottom: 'var(--space-5)' }}>
        <Icon name="info" />
        <div class="small">Shared for school study use only, within the school. Please post only papers you are allowed to share, and report anything that should not be here.</div>
      </div>
      {pending && !posting && (
        <div class="notice notice--warn" style={{ marginBottom: 'var(--space-5)' }}>
          <Badge status="warn">Not finished</Badge>
          <div class="row" style={{ justifyContent: 'space-between' }}>
            <span class="small">"{pending.meta.title}" was not fully posted.</span>
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
          <span class="small">{search ? 'Try another word.' : 'Post the first set: a pack on your device, a pack zip, or PDFs.'}</span>
        </div>
      ) : (
        <div class="cards set-cards">
          {sets.map((s) => (
            <article class="jy-panel set-card" key={s.id} aria-labelledby={`set-${s.id}`}>
              <Cover set={s} />
              <div class="stack-s">
                <h2 id={`set-${s.id}`} class="h3">{s.title}</h2>
                {s.description && <p class="small muted set-desc">{s.description}</p>}
                <div class="meta small muted">
                  <span>{s.ownerName}</span>
                  <span><span class="num">{fmtInt(s.paperCount)}</span> paper{s.paperCount === 1 ? '' : 's'}</span>
                  {!s.keyed && <span>key partly missing</span>}
                </div>
                {s.status === 'hidden' && <Badge status="warn">Hidden after reports</Badge>}
              </div>
              <div class="row set-actions">
                <Button variant="ghost" size="sm" aria-pressed={s.starred} aria-label={`${s.starred ? 'Unstar' : 'Star'} ${s.title}, ${s.stars} star${s.stars === 1 ? '' : 's'}`} onClick={() => void toggleStar(s)}>
                  <span aria-hidden="true" class={`star${s.starred ? ' on' : ''}`} /> <span class="num">{s.stars}</span>
                </Button>
                <span class="spacer" />
                <Button size="sm" onClick={() => void download(s)}>
                  <Icon name="download" size={16} /> {local.has(libraryPackId(s.id)) ? 'Update' : 'Download'}
                </Button>
              </div>
              <div class="row set-actions small">
                <button type="button" class="jy-btn jy-btn--ghost jy-btn--sm" onClick={() => setReporting(s)}>Report</button>
                {(s.mine || admin) && <button type="button" class="jy-btn jy-btn--ghost jy-btn--sm" onClick={() => void remove(s)}>{s.mine ? 'Delete' : 'Remove'}</button>}
                {admin && s.status === 'hidden' && <button type="button" class="jy-btn jy-btn--ghost jy-btn--sm" onClick={() => void restore(s)}>Restore</button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {more && <div style={{ marginTop: 'var(--space-5)' }}><Button onClick={() => void load(sets?.length ?? 0)}>Show more</Button></div>}
      {posting && <PostDialog name={name} resume={pending} onClose={(posted) => { setPosting(false); if (posted) void load(0); }} />}
      {reporting && <ReportDialog set={reporting} onClose={() => setReporting(null)} />}
    </main>
  );
}

const covers = new Map<string, Promise<string>>();
function Cover({ set }: { set: LibrarySet }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const key = set.coverPath ?? `gen:${set.title}`;
    if (!covers.has(key))
      covers.set(
        key,
        set.coverPath
          ? backend!.signedUrl('sets', set.coverPath).then((u) => u ?? Promise.reject(new Error('none')))
          : Promise.resolve(URL.createObjectURL(new Blob([coverSvg(set.title, [set.subject, set.code].filter(Boolean).join(' '))], { type: 'image/svg+xml' }))),
      );
    covers.get(key)!.then((u) => live && setUrl(u), () => covers.delete(key));
    return () => {
      live = false;
    };
  }, [set.coverPath, set.title]);
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

/**
 * Posting a set, in a handful of taps: pick a zip, PDFs or a pack on this device; everything
 * detectable is filled in and validated before anything uploads; edit only cover, name and
 * description; post with progress, cancel and resume; finish with one "Posted".
 */
function PostDialog({ name, resume, onClose }: { name: string; resume: PostPlan | null; onClose: (posted: boolean) => void }) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(resume?.meta.title ?? '');
  const [desc, setDesc] = useState(resume?.meta.description ?? '');
  const [cover, setCover] = useState<Blob | null>(resume?.cover ?? null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
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
    } catch (e) {
      toast((e as Error).message || 'That could not be read.');
    }
    setBusy(false);
  };

  const defaultCover = async () => svgToPng(coverSvg(title, [prep?.meta.subject, prep?.meta.code].filter(Boolean).join(' '), await embeddedFontCss()), 600, 800);

  const run = async () => {
    if (!plan.current) {
      const acct = authStore.get().account;
      if (!prep || !acct) return;
      plan.current = { id: crypto.randomUUID(), ownerId: acct.id, meta: { ...prep.meta, title: title.trim().slice(0, 120) || prep.meta.title, description: desc.trim().slice(0, 1000) }, ownerName: name, zip: prep.zip, cover: cover ?? (await defaultCover()), done: [] };
      await savePending(plan.current);
    }
    abort.current = new AbortController();
    setState('posting');
    try {
      await postSet(plan.current, (sent, total) => setProgress({ sent, total }), abort.current.signal);
      setState('posted');
    } catch (e) {
      setState('paused');
      if ((e as Error).name !== 'AbortError') toast((e as Error).message || 'Posting stopped. Resume when you are back online.');
    }
  };

  const pct = progress ? Math.round((progress.sent / Math.max(1, progress.total)) * 100) : 0;
  if (state === 'posted')
    return (
      <Modal title="Posted" onClose={() => onClose(true)} footer={<Button variant="primary" onClick={() => onClose(true)} autoFocus>Done</Button>}>
        <p><b>{plan.current?.meta.title}</b> is in the Library for everyone at school.</p>
      </Modal>
    );
  if (state !== 'edit')
    return (
      <Modal title={state === 'posting' ? 'Posting…' : 'Posting paused'} onClose={() => { abort.current?.abort(); onClose(false); }} dismissable={state !== 'posting'}>
        <div class="stack">
          <p><b>{plan.current?.meta.title}</b></p>
          <div class="progress" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div style={{ transform: `scaleX(${pct / 100})` }} /></div>
          <p class="small muted num">{pct}%{progress ? ` · ${(progress.sent / 1e6).toFixed(1)} of ${(progress.total / 1e6).toFixed(1)} MB` : ''}</p>
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

  return (
    <Modal title="Post a set" size="wide" onClose={() => onClose(false)} footer={
      <>
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button variant="primary" disabled={!prep || busy || !title.trim()} onClick={() => void run()}><Icon name="upload" size={18} /> Post</Button>
      </>
    }>
      <div class="stack">
        {!prep ? (
          <>
            <p class="small muted">Choose what to share. DMC fills in everything it can and checks the pack before anything uploads.</p>
            <div class="row">
              <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={busy}><Icon name="file" size={18} /> Zip or PDFs</Button>
              <input ref={fileRef} type="file" hidden multiple accept=".zip,.pdf,application/zip,application/pdf" onChange={(e) => void use(prepareFromFiles([...((e.target as HTMLInputElement).files ?? [])]))} />
              {packs.length > 0 && (
                <>
                  <label class="sr-only" for="post-pack">A pack on this device</label>
                  <select id="post-pack" class="select" style={{ width: 'auto' }} value="" onChange={(e) => { const p = packs.find((x) => x.id === (e.target as HTMLSelectElement).value); if (p) void use(prepareFromPack(p)); }}>
                    <option value="">Or a pack on this device…</option>
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
                <textarea class="textarea" style={{ fontFamily: 'var(--font-sans)', minHeight: '96px' }} maxLength={1000} value={desc} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} />
              </Field>
              <div class="chips" aria-label="Detected">{prep.facts.map((f) => <span class="jy-badge jy-badge--ok" key={f}>{f}</span>)}</div>
              <p class="small subtle">Checked: {prep.report.warnings.length ? `${prep.report.warnings.length} note${prep.report.warnings.length === 1 ? '' : 's'}, no errors` : 'no problems found'}. Posting as {name}.</p>
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
