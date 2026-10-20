// Shared test helpers: read a fixture folder into Map(relative path -> Uint8Array).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

export function readDir(root, dir = root, out = new Map()) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) readDir(root, full, out);
    else out.set(relative(root, full).split(sep).join('/'), new Uint8Array(readFileSync(full)));
  }
  return out;
}

export const fixtureNames = () => readdirSync(FIXTURES).filter((n) => statSync(join(FIXTURES, n)).isDirectory()).sort();
export const expectOf = (name) => JSON.parse(readFileSync(join(FIXTURES, name, 'expect.json'), 'utf8'));
