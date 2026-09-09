#!/usr/bin/env node
/**
 * Regenerates skills.lock.json from whatever is in skills/ right now.
 *
 *   node scripts/update-lock.mjs            rewrite the lock
 *   node scripts/update-lock.mjs --check    exit 1 if it is out of date
 *
 * The check runs in CI. Without it the lock rots the first time somebody edits
 * a skill and forgets, and a rotten pin is worse than no pin, because it
 * teaches people to pass --force out of habit.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { digestDirectory, short } from '../bin/digest.mjs';
import { buildLock, readLock, writeLock, serialiseLock, LOCK_FILE } from '../bin/lockfile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');
const check = process.argv.includes('--check');

const exists = (p) => stat(p).then(() => true, () => false);

const entries = [];
for (const entry of await readdir(SKILLS, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (!(await exists(join(SKILLS, entry.name, 'SKILL.md')))) continue;
  const { digest, files } = await digestDirectory(join(SKILLS, entry.name));
  entries.push([entry.name, digest, files.length]);
}

const lock = buildLock(entries.map(([id, digest]) => [id, digest]));

if (!check) {
  await writeLock(ROOT, lock);
  for (const [id, digest, files] of entries) {
    console.log(`${short(digest)}  ${id}  ${files} file(s)`);
  }
  console.log(`\nwrote ${LOCK_FILE} with ${entries.length} skill(s)`);
  process.exit(0);
}

const current = await readFile(join(ROOT, LOCK_FILE), 'utf8').catch(() => null);

if (current === null) {
  console.error(`${LOCK_FILE} is missing. Run npm run lock.`);
  process.exit(1);
}

if (current !== serialiseLock(lock)) {
  const previous = await readLock(ROOT);
  const ids = new Set([...entries.map(([id]) => id), ...Object.keys(previous?.skills ?? {})]);

  for (const id of [...ids].sort()) {
    const was = previous?.skills?.[id];
    const now = lock.skills[id];
    if (was === now) continue;
    if (!was) console.error(`  added    ${id}  ${short(now)}`);
    else if (!now) console.error(`  dropped  ${id}  ${short(was)}`);
    else console.error(`  changed  ${id}  ${short(was)} -> ${short(now)}`);
  }

  console.error(`\n${LOCK_FILE} is out of date. Run npm run lock and commit the result.`);
  process.exit(1);
}

console.log(`${LOCK_FILE} is current, ${entries.length} skill(s) pinned`);
