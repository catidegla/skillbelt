#!/usr/bin/env node
/**
 * Tests for the digest, which is the part that has to be boringly correct.
 *
 * A digest that changes when nothing changed makes verify cry wolf and people
 * stop reading it. A digest that stays the same when something did change is
 * worse, because it is a pin that does not pin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { digestDirectory, listFiles, hashBytes, listingOf } from '../bin/digest.mjs';
import { buildLock, serialiseLock } from '../bin/lockfile.mjs';

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'skillbelt-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

const BASE = {
  'SKILL.md': '---\nname: demo\n---\nbody\n',
  'scripts/run.mjs': 'console.log(1);\n',
  'references/notes.md': 'notes\n',
};

test('the same tree hashes the same twice', async () => {
  const dir = await fixture(BASE);
  const a = await digestDirectory(dir);
  const b = await digestDirectory(dir);
  assert.equal(a.digest, b.digest);
  await rm(dir, { recursive: true, force: true });
});

test('two trees with identical content hash the same', async () => {
  const one = await fixture(BASE);
  const two = await fixture(BASE);
  assert.equal((await digestDirectory(one)).digest, (await digestDirectory(two)).digest);
  await rm(one, { recursive: true, force: true });
  await rm(two, { recursive: true, force: true });
});

test('changing one byte in a nested script changes the digest', async () => {
  const before = await fixture(BASE);
  const after = await fixture({ ...BASE, 'scripts/run.mjs': 'console.log(2);\n' });
  assert.notEqual((await digestDirectory(before)).digest, (await digestDirectory(after)).digest);
  await rm(before, { recursive: true, force: true });
  await rm(after, { recursive: true, force: true });
});

test('renaming a file changes the digest even though the bytes are the same', async () => {
  const before = await fixture(BASE);
  const renamed = { 'SKILL.md': BASE['SKILL.md'], 'scripts/go.mjs': BASE['scripts/run.mjs'], 'references/notes.md': BASE['references/notes.md'] };
  const after = await fixture(renamed);

  const a = await digestDirectory(before);
  const b = await digestDirectory(after);

  // Same file hashes, different listing, so hashing the listing is what
  // catches this. Concatenating the file bytes would not.
  assert.deepEqual(a.files.map((f) => f.hash).sort(), b.files.map((f) => f.hash).sort());
  assert.notEqual(a.digest, b.digest);

  await rm(before, { recursive: true, force: true });
  await rm(after, { recursive: true, force: true });
});

test('adding a file changes the digest', async () => {
  const before = await fixture(BASE);
  const after = await fixture({ ...BASE, 'extra.md': 'x\n' });
  assert.notEqual((await digestDirectory(before)).digest, (await digestDirectory(after)).digest);
  await rm(before, { recursive: true, force: true });
  await rm(after, { recursive: true, force: true });
});

test('paths are reported with forward slashes and sorted', async () => {
  const dir = await fixture(BASE);
  const files = await listFiles(dir);
  assert.deepEqual(files.map((f) => f.path), ['SKILL.md', 'references/notes.md', 'scripts/run.mjs']);
  for (const file of files) assert.ok(!file.path.includes('\\'), `${file.path} contains a backslash`);
  await rm(dir, { recursive: true, force: true });
});

test('the digest is the hash of the listing, not of the bytes', async () => {
  const dir = await fixture(BASE);
  const { digest, files } = await digestDirectory(dir);
  assert.equal(digest, hashBytes(listingOf(files)));
  await rm(dir, { recursive: true, force: true });
});

test('a symbolic link is refused rather than followed', async (t) => {
  const dir = await fixture(BASE);
  const target = await fixture({ 'secret.txt': 'not yours\n' });

  try {
    await symlink(join(target, 'secret.txt'), join(dir, 'link.txt'));
  } catch (error) {
    // Unprivileged Windows accounts cannot create symlinks, and the guard is
    // the same code either way, so there is nothing to learn from failing here.
    await rm(dir, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    return t.skip(`this account cannot create symlinks: ${error.code}`);
  }

  await assert.rejects(() => digestDirectory(dir), /symbolic link/);
  await rm(dir, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('the lock serialises deterministically and sorts by id', () => {
  const one = serialiseLock(buildLock([['b', 'bbb'], ['a', 'aaa']]));
  const two = serialiseLock(buildLock([['a', 'aaa'], ['b', 'bbb']]));
  assert.equal(one, two);
  assert.ok(one.indexOf('"a"') < one.indexOf('"b"'));
  assert.ok(one.endsWith('\n'));
});
