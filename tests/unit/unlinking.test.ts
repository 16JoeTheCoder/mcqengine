import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../src/lib/data/db';
import { backend } from '../../src/lib/backend';
import { buildPlan, postSet, prepareFromPack } from '../../src/lib/library/post';
import { downloadSet } from '../../src/lib/library/download';
import { exportPackZip } from '../../src/lib/data/backup';
import { readZip } from '../../src/lib/data/files';
import { commitImport, parseImport, planImport } from '../../src/lib/data/importer';
import { doc, syntheticPaper } from '../fixtures/make';
import { importPack } from './helpers';

/** Regression: local packs and Library sets came apart and duplicated (Phase 2 root cause). */
let n = 0;
beforeEach(async () => { store.useDbName(`unlink-${++n}`); indexedDB.deleteDatabase('dmc-mock-server'); await backend!.signOut(); });

async function importZip(blob: Blob) {
  const src = await readZip(blob, 'x.zip');
  const r = parseImport(src.text!, new Set([...src.files.keys(), ...src.pdfs.keys()]));
  if (!r.ok) throw new Error(r.syntax);
  const target = { packId: null, newPack: { title: 'Re-import', subject: 'Physics' } };
  const { merge, images } = await planImport(r.result.doc, target, src, {});
  return commitImport(target, merge, images);
}

describe('one set, one local pack', () => {
  it('posting my pack and downloading it back on the same device keeps one pack', async () => {
    await backend!.signInDev!('ana@stjbs.sch.id');
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const prep = await prepareFromPack((await store.getPack(id))!);
    await postSet(await buildPlan(prep, prep.meta, {}, null), () => {}, new AbortController().signal);
    const [set] = await backend!.listSets({ search: '', limit: 10, offset: 0 });
    await downloadSet(set!);
    expect((await store.getPacks()).length).toBe(1);
  });
  it('exporting a pack and importing the file again updates the same pack', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    const { blob } = await exportPackZip(pack, await store.getPapers(id), []);
    expect(await importZip(blob)).toBe(id);
    expect((await store.getPacks()).length).toBe(1);
  });
  it('the same Cambridge paper written with two AI ids is one paper', async () => {
    const a = doc(syntheticPaper('9702-s24-12', 4));
    const b = doc(syntheticPaper('phys-may-june-2024-p12', 4));
    for (const d of [a, b]) (d.papers[0] as { source?: unknown }).source = { questionPaper: '9702_s24_qp_12.pdf' };
    const id = await importPack(a);
    await importPack(b, id);
    expect((await store.getPack(id))!.papers.length).toBe(1);
  });
});
