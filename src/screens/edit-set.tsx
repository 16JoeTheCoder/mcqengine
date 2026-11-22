import { useState } from 'preact/hooks';
import { authStore, backend } from '../lib/backend';
import * as store from '../lib/data/db';
import { bump, toast, useStore } from '../lib/app-state';
import { setIdOf, type Pack } from '../lib/types';
import { Button, Field, Modal, Toggle } from '../ui/kit';

export const SET_LIMITS = { title: 120, subject: 80, description: 1000 } as const;

/** The edited fields of a set, trimmed and checked. Returns an error message, or the patch. */
export function setPatch(f: { title: string; subject: string; description: string; examDate: string }): { error: string } | { title: string; subject: string; description: string; examDate?: string } {
  const title = f.title.trim();
  const subject = f.subject.trim();
  const description = f.description.trim();
  if (!title) return { error: 'Give the paper set a name.' };
  if (title.length > SET_LIMITS.title) return { error: `Keep the name to ${SET_LIMITS.title} characters.` };
  if (subject.length > SET_LIMITS.subject) return { error: `Keep the subject to ${SET_LIMITS.subject} characters.` };
  if (description.length > SET_LIMITS.description) return { error: `Keep the description to ${SET_LIMITS.description} characters.` };
  if (f.examDate && !/^\d{4}-\d{2}-\d{2}$/.test(f.examDate)) return { error: 'Enter the exam date as a date.' };
  return { title, subject, description, ...(f.examDate ? { examDate: f.examDate } : {}) };
}

/**
 * Edit a paper set's name and details, from the home card or the set page. The set keeps its
 * permanent set ID, so it stays linked to the Library. A set this account posted can also update
 * its Library listing; a downloaded copy changes only here (an update keeps the local name).
 */
export function EditSet({ pack, onClose }: { pack: Pack; onClose: () => void }) {
  const auth = useStore(authStore);
  const [title, setTitle] = useState(pack.title);
  const [subject, setSubject] = useState(pack.subject);
  const [description, setDescription] = useState(pack.description ?? '');
  const [examDate, setExamDate] = useState(pack.examDate ?? '');
  const setId = setIdOf(pack);
  const canPublish = !!backend && !!setId && auth.status.member && pack.origin?.kind !== 'library' && pack.libraryVersion !== undefined;
  const [listing, setListing] = useState(canPublish);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (e: Event) => {
    e.preventDefault();
    const p = setPatch({ title, subject, description, examDate });
    if ('error' in p) { setError(p.error); return; }
    setBusy(true);
    try {
      const { examDate: ed, ...rest } = p;
      const next: Pack = { ...pack, ...rest, updatedAt: Date.now() };
      if (ed) next.examDate = ed; else delete next.examDate;
      if (!rest.description) delete next.description;
      await store.putPack(next);
      bump();
      if (listing && canPublish) {
        try {
          await backend!.updateSet(setId!, { title: rest.title, subject: rest.subject, description: rest.description });
          toast('Saved here and in the School Library.');
        } catch (err) {
          toast(`Saved on this device. The Library listing was not changed: ${(err as Error).message}`, undefined, 8000);
        }
      } else toast('Saved.');
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Edit paper set"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={(e) => void save(e)} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <form id="edit-set" class="stack" onSubmit={save}>
        <Field label="Name">
          <input class="input" name="title" required maxLength={SET_LIMITS.title} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
        </Field>
        <Field label="Subject">
          <input class="input" name="subject" maxLength={SET_LIMITS.subject} value={subject} onInput={(e) => setSubject(e.currentTarget.value)} />
        </Field>
        <Field label="Description" hint={`Optional, up to ${SET_LIMITS.description} characters.`}>
          <textarea class="input" name="description" rows={3} maxLength={SET_LIMITS.description} value={description} onInput={(e) => setDescription(e.currentTarget.value)} />
        </Field>
        <Field label="Exam date" hint="Optional.">
          <input class="input" type="date" name="examDate" value={examDate} onInput={(e) => setExamDate(e.currentTarget.value)} />
        </Field>
        {canPublish && <Toggle label="Also update the School Library listing" checked={listing} onChange={setListing} hint="Only the person who posted the set (or an admin) can change it." />}
        {pack.origin?.kind === 'library' && <p class="small muted">This is a copy from the School Library. Changes stay on this device and are kept when you update the copy.</p>}
        {error && <p class="small" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
