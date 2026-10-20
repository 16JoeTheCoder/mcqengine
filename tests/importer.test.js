import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { zipSync } from '../vendor/fflate/fflate.js';
import { readUpload, fromBytes, attachBlobs, assetUrl, closePack, assemble } from '../js/importer.js';
import { FIXTURES, readDir } from './helpers.js';

// Minimal File stand-in: what <input type=file> gives us.
const file = (name, bytes, rel = '') => ({ name, size: bytes.length, webkitRelativePath: rel, arrayBuffer: async () => bytes.buffer.slice(0) });

test('zip upload with a top-level folder loads and validates', async () => {
  const files = readDir(join(FIXTURES, 'valid-typed'));
  const zip = zipSync(Object.fromEntries([...files].map(([p, b]) => [`valid-typed/${p}`, b])));
  const raw = await readUpload([file('pack.zip', zip)]);
  const { pack, errors, blobs, json } = fromBytes(raw);
  assert.deepEqual(errors, []);
  assert.equal(pack.questions[0].explanation, 'Because.');
  assert.equal(blobs.get('assets/fig.svg').type, 'image/svg+xml');
  assert.ok(!blobs.has('pack.json'));
  assert.equal(JSON.parse(json).id, 'fixture-pack');
});

test('a bad zip is refused with readable errors', async () => {
  const files = readDir(join(FIXTURES, 'invalid-svg-script'));
  const raw = await readUpload([file('x.zip', zipSync(Object.fromEntries(files)))]);
  const { errors } = fromBytes(raw);
  assert.deepEqual(errors.map((e) => `${e.where}: ${e.code}`), ['q1: svg-unsafe']);
});

test('folder upload uses webkitRelativePath; single json becomes pack.json', async () => {
  const files = readDir(join(FIXTURES, 'valid-snapshot'));
  const raw = await readUpload([...files].map(([p, b]) => file(p.split('/').pop(), b, `folder/${p}`)));
  assert.deepEqual(fromBytes(raw).errors, []);
  const single = await readUpload([file('my-pack.json', files.get('pack.json'))]);
  assert.deepEqual([...single.keys()], ['pack.json']);
  assert.deepEqual(fromBytes(single).errors.map((e) => e.code), ['asset-missing']);
});

test('assetUrl: built-in packs use relative URLs, uploads use object URLs that closePack revokes', () => {
  const { pack, blobs } = fromBytes(readDir(join(FIXTURES, 'valid-snapshot')));
  attachBlobs(pack, blobs);
  const url = assetUrl(pack, 'assets/p.png');
  assert.match(url, /^blob:/);
  assert.equal(assetUrl(pack, 'assets/p.png'), url); // cached
  assert.equal(assetUrl(pack, 'nope.png'), '');
  closePack(pack);
  assert.notEqual(assetUrl(pack, 'assets/p.png'), url);
  assert.equal(assetUrl({}, 'x'), '');
});

test('assemble without asset checks (built-in packs)', () => {
  const files = new Map([['pack.json', JSON.stringify({ format: 'mcqpack', formatVersion: '1.0', id: 'ab', version: '1', title: 't',
    optionKeys: ['A', 'B'], questions: [{ id: 'q', type: 'single', rev: 1, answer: 'A', snapshot: [{ src: 'a.png' }] }] })]]);
  assert.deepEqual(assemble(files, false).errors, []);
  assert.equal(assemble(files, true).errors[0].code, 'asset-missing');
});
