/**
 * Content digests for skill directories.
 *
 * A skill is executable content. SKILL.md tells the agent what to do and the
 * scripts beside it run on your machine, so copying one into five harness
 * directories with no record of what was copied means a later change looks
 * exactly like the original. That change might be yours, a bad merge, or a
 * tampered release, and without a digest none of them are distinguishable.
 *
 * The digest is a sha256 over a sorted listing of `<file sha256>  <path>`, one
 * line per file. Sorting makes it independent of the order the filesystem
 * hands back entries, and hashing the listing rather than the concatenated
 * bytes means renaming a file changes the result even when no content did.
 *
 * This is only reproducible across machines because .gitattributes pins the
 * working tree to `eol=lf`. Remove that line and every digest computed on a
 * Windows checkout stops matching the one computed on Linux.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

export const ALGORITHM = 'sha256';

export function hashBytes(bytes) {
  return createHash(ALGORITHM).update(bytes).digest('hex');
}

/**
 * Every file under `dir` as a relative POSIX path plus its content hash.
 *
 * Symbolic links are refused rather than followed. A link inside a skill can
 * point anywhere on the machine and the installer copies recursively, so
 * following one would drop arbitrary files into the directory an agent reads.
 */
export async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relative = prefix ? posix.join(prefix, entry.name) : entry.name;

    if (entry.isSymbolicLink()) {
      throw new Error(`${relative} is a symbolic link, and skills may not contain those`);
    }

    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(dir, entry.name), relative)));
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(`${relative} is neither a regular file nor a directory`);
    }

    files.push({ path: relative, hash: hashBytes(await readFile(join(dir, entry.name))) });
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function listingOf(files) {
  return files.map((file) => `${file.hash}  ${file.path}\n`).join('');
}

export async function digestDirectory(dir) {
  const files = await listFiles(dir);
  return { digest: hashBytes(listingOf(files)), files };
}

/** Enough of a digest to compare by eye, and short enough to sit in a column. */
export const short = (digest) => digest.slice(0, 12);
