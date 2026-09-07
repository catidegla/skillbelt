#!/usr/bin/env node
/**
 * Checks every skill in skills/ before it ships.
 *
 * A skill with malformed frontmatter does not fail loudly at runtime, it just
 * never triggers. So the frontmatter rules are enforced here instead.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DESCRIPTION_MIN = 40;
const DESCRIPTION_MAX = 1024;
// Skills are read in terminals and piped through tools with inconsistent
// encoding handling. Windows consoles in particular mangle these to mojibake,
// so keep punctuation to ASCII.
const SMART_PUNCTUATION = /[–—‘’“”…]/;

const errors = [];
const warnings = [];

const exists = (p) => stat(p).then(() => true, () => false);

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const meta = {};
  let key = null;

  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      meta[key] = kv[2].replace(/^["']|["']$/g, '');
    } else if (key && /^\s+\S/.test(line)) {
      // Folded continuation of the previous value.
      meta[key] += ` ${line.trim()}`;
    }
  }
  return meta;
}

const entries = await readdir(SKILLS, { withFileTypes: true });
const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

if (!dirs.length) errors.push('skills/ contains no skill directories');

for (const dir of dirs) {
  const skillPath = join(SKILLS, dir);
  const manifest = join(skillPath, 'SKILL.md');
  const label = `skills/${dir}`;

  if (!(await exists(manifest))) {
    errors.push(`${label} has no SKILL.md`);
    continue;
  }

  const source = await readFile(manifest, 'utf8');
  const meta = parseFrontmatter(source);

  if (!meta) {
    errors.push(`${label}/SKILL.md has no YAML frontmatter block`);
    continue;
  }

  if (!meta.name) {
    errors.push(`${label} frontmatter is missing "name"`);
  } else {
    if (meta.name !== dir) errors.push(`${label} frontmatter name "${meta.name}" does not match its directory`);
    if (!NAME_PATTERN.test(meta.name)) errors.push(`${label} name must be lowercase kebab-case`);
  }

  if (!meta.description) {
    errors.push(`${label} frontmatter is missing "description"`);
  } else {
    const d = meta.description;
    if (d.length < DESCRIPTION_MIN) errors.push(`${label} description is too short to match reliably`);
    if (d.length > DESCRIPTION_MAX) errors.push(`${label} description exceeds ${DESCRIPTION_MAX} characters`);
    // The description is the only thing an agent sees when deciding whether to
    // load the skill, so it has to say when to use it, not just what it is.
    if (!/\buse when\b|\bwhenever\b|\bwhen the user\b/i.test(d)) {
      warnings.push(`${label} description does not say when to use the skill`);
    }
  }

  const allowed = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata']);
  for (const key of Object.keys(meta)) {
    if (!allowed.has(key)) warnings.push(`${label} has non-standard frontmatter key "${key}", other harnesses may reject it`);
  }

  const body = source.slice(source.indexOf('---', 3) + 3);
  if (!body.trim()) errors.push(`${label} has frontmatter but no body`);
  const smart = source.match(SMART_PUNCTUATION);
  if (smart) errors.push(`${label} contains non-ASCII punctuation (${JSON.stringify(smart[0])}), use the ASCII equivalent`);

  // Any references/ or scripts/ path named in the body must actually exist.
  for (const [, ref] of body.matchAll(/`((?:references|scripts)\/[A-Za-z0-9._-]+)`/g)) {
    if (!(await exists(join(skillPath, ref)))) {
      errors.push(`${label} refers to ${ref}, which does not exist`);
    }
  }
}

for (const w of warnings) console.log(`warning: ${w}`);

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`ok: ${dirs.length} skills validated`);
