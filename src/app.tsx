import { useEffect, useState } from 'preact/hooks';
import * as store from './lib/data/db';
import { readFiles, type ImportSource } from './lib/data/files';
import { submitSession } from './lib/engine/session';
import { formatClock } from './lib/engine/timer';
import { bump, href, loadSettings, navigate, routeStore, savedScroll, toast, toasts, useStore, createStore } from './lib/app-state';
import { broadcastChange, onRemoteChange, sessionLockHeld } from './lib/tablock';
import type { Pack, SessionSummary } from './lib/types';
import { Button, Modal } from './ui/kit';
import { Icon } from './ui/icons';
import { DmcMark, Signature } from './ui/brand';
import { Library } from './screens/library';
import { PackScreen } from './screens/pack';
import { SessionScreen } from './screens/session';
import { lazy } from './ui/lazy';

const Results = lazy(() => import('./screens/results').then((m) => m.Results));
const SettingsScreen = lazy(() => import('./screens/settings').then((m) => m.SettingsScreen));
const AboutDialog = lazy(() => import('./screens/settings').then((m) => m.AboutDialog));
const ImportWizard = lazy(() => import('./screens/import').then((m) => m.ImportWizard));
const PromptDialog = lazy(() => import('./screens/prompt').then((m) => m.PromptDialog));

/** Set by main.tsx when a new service worker is waiting. */
export const updateReady = createStore<(() => void) | null>(null);

/**
 * Sessions left 'active' by a previous page (closed tab, crash, refresh) become 'saved' with the
 * remaining time from their last persisted tick. Remaining time therefore never increases.
 */
async function recoverSessions() {
  // Another tab is running a session: its 'active' row is live, not stale. Leave it alone.
  if (await sessionLockHeld()) return;
  for (const s of await store.getOpenSessions()) {
    if (s.status !== 'active') continue;
    const d = await store.getDetail(s.id);
    if (!d) continue;
    const timer = d.timer ? { ...d.timer, endAt: undefined } : undefined;
    await store.persistOpenSession({ ...s, status: 'saved', updatedAt: Date.now() }, { ...d, ...(timer ? { timer } : {}) });
  }
}

export function App() {
  const route = useStore(routeStore);
  const list = useStore(toasts);
  const update = useStore(updateReady);
  const [ready, setReady] = useState(false);
  const [prompt, setPrompt] = useState<{ pack?: Pack } | null>(null);
  const [importing, setImporting] = useState<{ pack?: Pack; source?: ImportSource | null } | null>(null);
  const [about, setAbout] = useState(false);
  const [resume, setResume] = useState<SessionSummary[]>([]);
  const [resumeChecked, setResumeChecked] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [crumb, setCrumb] = useState<Pack | null>(null);

  useEffect(() => {
    void (async () => {
      await loadSettings();
      await recoverSessions();
      void store.requestPersistence();
      setReady(true);
    })();
    const quota = () => toast('Storage is full. Export a backup and delete packs you no longer need.');
    const blocked = () => toast('DMC was updated in another tab. Reload to continue.', { label: 'Reload', run: () => location.reload() }, 30_000);
    addEventListener('dmc:quota', quota);
    addEventListener('dmc:db-blocked', blocked);
    const off = onRemoteChange(bump);
    return () => {
      removeEventListener('dmc:quota', quota);
      removeEventListener('dmc:db-blocked', blocked);
      off();
    };
  }, []);

  // Resume prompt: once per app open, above everything.
  useEffect(() => {
    if (!ready || resumeChecked) return;
    setResumeChecked(true);
    void store.getOpenSessions().then((open) => {
      const cur = routeStore.get();
      setResume(open.filter((s) => s.status === 'saved' && !(cur.name === 'session' && cur.id === s.id)).sort((a, b) => b.updatedAt - a.updatedAt));
    });
  }, [ready, resumeChecked]);

  // Breadcrumb pack title.
  useEffect(() => {
    const id = route.name === 'pack' ? route.id : null;
    if (!id) return setCrumb(null);
    void store.getPack(id).then((p) => setCrumb(p ?? null));
  }, [route]);

  // Restore scroll when returning to a page; otherwise start at the top.
  useEffect(() => {
    if (route.name === 'pack' && route.section) return;
    const y = savedScroll(location.hash || '#/');
    requestAnimationFrame(() => window.scrollTo({ top: y ?? 0, behavior: 'instant' as ScrollBehavior }));
    const t = route.name === 'library' ? 'DMC' : route.name === 'settings' ? 'Settings · DMC' : route.name === 'results' ? 'Results · DMC' : route.name === 'session' ? 'Session · DMC' : 'Pack · DMC';
    document.title = t;
  }, [route]);

  // Drag and drop anywhere.
  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => {
      if (!has(e) || routeStore.get().name === 'session') return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => has(e) && e.preventDefault();
    const drop = async (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (routeStore.get().name === 'session') return;
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      try {
        const source = await readFiles(files);
        const r = routeStore.get();
        const pack = r.name === 'pack' ? await store.getPack(r.id) : undefined;
        setImporting({ ...(pack ? { pack } : {}), source });
      } catch (err) {
        toast((err as Error).message || 'Could not read the dropped files.');
      }
    };
    addEventListener('dragenter', enter);
    addEventListener('dragleave', leave);
    addEventListener('dragover', over);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('dragenter', enter);
      removeEventListener('dragleave', leave);
      removeEventListener('dragover', over);
      removeEventListener('drop', drop);
    };
  }, []);

  if (!ready) return <div class="page" aria-busy="true" style={{ paddingTop: '120px' }} />;

  const inSession = route.name === 'session';
  const openPrompt = (pack?: Pack) => setPrompt(pack ? { pack } : {});
  const openImport = (pack?: Pack) => setImporting(pack ? { pack } : {});
  const top = resume[0];

  const handleResume = async (action: 'resume' | 'submit' | 'discard') => {
    if (!top) return;
    if (action !== 'resume' && (await sessionLockHeld())) {
      toast('A session is running in another tab. Finish it there first.');
      return;
    }
    if (action === 'discard' && !confirm('Discard this saved session? Its answers will be lost.')) return;
    setResume(resume.slice(1));
    if (action === 'resume') return navigate(href.session(top.id));
    if (action === 'submit') {
      const r = await submitSession(top.id, false);
      bump();
      broadcastChange();
      return navigate(href.results(r?.summary.id ?? top.id));
    }
    await store.deleteSession(top.id);
    bump();
    broadcastChange();
    toast('Saved session discarded.');
  };

  return (
    <>
      <a class="sr-only" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      {!inSession && (
        <header class="topbar">
          <div class="page">
            <a class="brand" href={href.library()} aria-label="DMC home">
              <DmcMark />
              <span>DMC</span>
            </a>
            <nav class="crumbs hide-sm" aria-label="Breadcrumb">
              <span aria-hidden="true">/</span>
              <a href={href.library()} aria-current={route.name === 'library' ? 'page' : undefined}>Library</a>
              {crumb && (
                <>
                  <span aria-hidden="true">/</span>
                  <a href={href.pack(crumb.id)} aria-current={route.name === 'pack' ? 'page' : undefined}>{crumb.title}</a>
                </>
              )}
              {route.name === 'settings' && (
                <>
                  <span aria-hidden="true">/</span>
                  <a href={href.settings()} aria-current="page">Settings</a>
                </>
              )}
              {route.name === 'results' && (
                <>
                  <span aria-hidden="true">/</span>
                  <span aria-current="page">Results</span>
                </>
              )}
            </nav>
            <span class="spacer" />
            <a class="jy-btn jy-btn--ghost jy-btn--icon" href={href.settings()} aria-label="Settings">
              <Icon name="settings" />
            </a>
            <button type="button" class="signature" onClick={() => setAbout(true)} aria-label="About DMC, built by josef">
              <Signature height={40} />
            </button>
          </div>
        </header>
      )}

      {route.name === 'library' && <Library onPrompt={() => openPrompt()} onImport={() => openImport()} />}
      {route.name === 'pack' && <PackScreen id={route.id} section={route.section} onImport={openImport} onPrompt={openPrompt} />}
      {route.name === 'session' && <SessionScreen id={route.id} />}
      {route.name === 'results' && <Results id={route.id} />}
      {route.name === 'settings' && <SettingsScreen onImport={() => openImport()} onAbout={() => setAbout(true)} />}

      {!inSession && (
        <footer class="footer">
          <div class="page">
            <button type="button" class="signature" onClick={() => setAbout(true)} aria-label="About DMC, built by josef">
              <Signature height={40} />
            </button>
            <span class="small subtle">DMC {__APP_VERSION__} · Your packs and progress stay on this device.</span>
          </div>
        </footer>
      )}

      {prompt && (
        <PromptDialog
          pack={prompt.pack}
          onClose={() => setPrompt(null)}
          onImport={() => {
            const p = prompt.pack;
            setPrompt(null);
            openImport(p);
          }}
        />
      )}
      {importing && <ImportWizard pack={importing.pack} initial={importing.source ?? null} onClose={() => setImporting(null)} />}
      {about && <AboutDialog onClose={() => setAbout(false)} />}
      {top && !inSession && (
        <Modal title="Resume your session?" onClose={() => setResume([])} describedBy="resume-desc">
          <div class="stack" id="resume-desc">
            <p>
              <b>{top.title}</b>: <span class="num">{top.answered}</span> of <span class="num">{top.total}</span> answered{top.mode === 'exam' ? ' in Exam mode' : ' in Practice mode'}.
            </p>
            <ResumeTime id={top.id} />
          </div>
          <div class="modal-foot">
            <Button variant="ghost" onClick={() => handleResume('discard')}>Discard</Button>
            <span class="spacer" />
            <Button onClick={() => handleResume('submit')}>Submit now</Button>
            <Button variant="primary" onClick={() => handleResume('resume')} autoFocus>
              Resume
            </Button>
          </div>
        </Modal>
      )}
      {update && !inSession && (
        <div class="toasts" style={{ bottom: list.length ? '88px' : undefined }}>
          <div class="toast" role="status">
            <span style={{ flex: 1 }}>A new version of DMC is ready.</span>
            <Button onClick={update}>Update</Button>
          </div>
        </div>
      )}
      {list.length > 0 && (
        <div class="toasts" aria-live="polite">
          {list.map((t) => (
            <div class="toast" key={t.id} role="status">
              <span style={{ flex: 1 }}>{t.text}</span>
              {t.action && <Button onClick={t.action.run}>{t.action.label}</Button>}
            </div>
          ))}
        </div>
      )}
      {dragging && (
        <div class="dropzone" aria-hidden="true">
          <span>Drop a pack, zip, folder or backup to import</span>
        </div>
      )}
    </>
  );
}

function ResumeTime({ id }: { id: string }) {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    void store.getDetail(id).then((d) => setMs(d?.timer?.remainingMs ?? null));
  }, [id]);
  if (ms === null) return null;
  return (
    <p class="small muted">
      Time remaining: <span class="num">{formatClock(ms)}</span> (frozen while saved).
    </p>
  );
}
