import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { validate, badPath } from '../js/validator.js';
import { fromBytes } from '../js/importer.js';
import { FIXTURES, readDir, fixtureNames, expectOf } from './helpers.js';

const codes = (list) => list.map((e) => e.code).sort();

for (const name of fixtureNames()) {
  test(`fixture ${name}`, () => {
    const want = expectOf(name);
    const { pack, errors, warnings } = fromBytes(readDir(join(FIXTURES, name)));
    assert.deepEqual(codes(errors), [...want.errors].sort());
    if (want.substring) assert.ok(errors.some((e) => e.message.includes(want.substring)), JSON.stringify(errors));
    if (want.warnings) assert.deepEqual(codes(warnings), [...want.warnings].sort());
    for (const [path, value] of Object.entries(want.check || {})) {
      const [qid, field] = path.split('.');
      assert.deepEqual(pack.questions.find((q) => q.id === qid)[field], value);
    }
  });
}

test('unknown fields are kept', () => {
  const { pack } = fromBytes(readDir(join(FIXTURES, 'valid-typed')));
  assert.equal(pack['x-unknown'], 42);
  assert.deepEqual(pack.questions[1].futureField, { kept: true });
});

test('asset checks are skipped when assets is null', () => {
  const pack = { format: 'mcqpack', formatVersion: '1.0', id: 'ab', version: '1', title: 't', optionKeys: ['A', 'B'],
    questions: [{ id: 'q1', type: 'single', rev: 1, answer: 'A', snapshot: [{ src: 'nowhere.png' }] }] };
  assert.deepEqual(validate(pack, null).errors, []);
  assert.equal(validate(pack, new Map()).errors[0].code, 'asset-missing');
});

test('non-object pack and empty questions', () => {
  assert.equal(validate(null, null).errors[0].code, 'json');
  assert.ok(validate({ format: 'mcqpack', formatVersion: '1.0', questions: [] }, null).errors.some((e) => e.message.includes('questions')));
});

test('badPath', () => {
  for (const p of ['', '/a', 'a/../b', './a', 'a//b', 'a\\b', 'c:x', 'http://x']) assert.ok(badPath(p), p);
  for (const p of ['a.png', 'assets/p-1.png', 'a/b/c.svg']) assert.ok(!badPath(p), p);
});

test('zip-style upload with a top folder is re-rooted', () => {
  const raw = new Map([...readDir(join(FIXTURES, 'valid-snapshot'))].map(([p, b]) => [`my-pack/${p}`, b]));
  raw.set('other/pack.json/', new Uint8Array());
  const { errors, blobs } = fromBytes(raw);
  assert.deepEqual(errors, []);
  assert.equal(blobs.get('assets/p.png').type, 'image/png');
});
