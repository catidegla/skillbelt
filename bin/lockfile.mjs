/**
 * Reading and writing the two records that make an install checkable.
 *
 * skills.lock.json ships with the package and says what each skill hashed to
 * when it was released. It is the pin: if the copy on disk does not match it,
 * either somebody edited the skill and forgot to regenerate the lock, or the
 * files are not the ones that were published.
 *
 * .skillbelt.json is written into each harness directory at install time and
 * records what was actually put there. It is the receipt: it answers "has
 * anything touched this skill since I installed it", which the lock alone
 * cannot, because the lock only describes the source.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ALGORITHM } from './digest.mjs';

export const LOCK_FILE = 'skills.lock.json';
export const RECEIPT_FILE = '.skillbelt.json';

const readJson = (path) => readFile(path, 'utf8').then(JSON.parse, () => null);

export async function readLock(root) {
  const lock = await readJson(join(root, LOCK_FILE));
  if (!lock || typeof lock.skills !== 'object' || lock.skills === null) return null;
  return lock;
}

export function buildLock(entries) {
  // Sorted so regenerating after an unrelated change produces no diff, and a
  // real change produces a diff of exactly one line.
  const skills = {};
  for (const [id, digest] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
    skills[id] = digest;
  }
  return { algorithm: ALGORITHM, skills };
}

export const serialiseLock = (lock) => `${JSON.stringify(lock, null, 2)}\n`;

export async function writeLock(root, lock) {
  await writeFile(join(root, LOCK_FILE), serialiseLock(lock), 'utf8');
}

export async function readReceipts(dir) {
  const receipts = await readJson(join(dir, RECEIPT_FILE));
  if (!receipts || typeof receipts.skills !== 'object' || receipts.skills === null) {
    return { algorithm: ALGORITHM, skills: {} };
  }
  return receipts;
}

export async function writeReceipts(dir, receipts) {
  const skills = {};
  for (const id of Object.keys(receipts.skills).sort()) skills[id] = receipts.skills[id];
  await writeFile(join(dir, RECEIPT_FILE), `${JSON.stringify({ algorithm: ALGORITHM, skills }, null, 2)}\n`, 'utf8');
}
