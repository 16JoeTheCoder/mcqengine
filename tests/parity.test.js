// Runs tools/mcqpack.py validate on every fixture and compares (code, where) pairs with validator.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fromBytes } from '../js/importer.js';
import { FIXTURES, readDir, fixtureNames } from './helpers.js';

const TOOL = new URL('../tools/mcqpack.py', import.meta.url).pathname;
const hasPython = spawnSync('python3', ['--version']).status === 0;
const pairs = (list) => list.map((e) => `${e.code}@${e.where}`).sort();

for (const name of fixtureNames()) {
  test(`parity ${name}`, { skip: !hasPython && 'python3 not found' }, () => {
    const dir = join(FIXTURES, name);
    const py = spawnSync('python3', [TOOL, 'validate', '--json', dir], { encoding: 'utf8' });
    const want = JSON.parse(py.stdout);
    const got = fromBytes(readDir(dir));
    assert.deepEqual(pairs(got.errors), pairs(want.errors));
    assert.deepEqual(pairs(got.warnings), pairs(want.warnings));
  });
}
