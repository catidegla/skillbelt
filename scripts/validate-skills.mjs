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

import { declarationOf, buildArgs } from '../bin/sandbox.mjs';
import { detect, reconcile } from '../bin/capabilities.mjs';

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

/**
 * Every file in a skill, so the line ending rule can reach the scripts too.
 */
async function filesUnder(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesUnder(join(dir, entry.name), relative)));
    else if (entry.isFile()) found.push({ relative, full: join(dir, entry.name) });
  }
  return found;
}

/**
 * A skill that ships code has to say what that code may reach.
 *
 * The declaration is what `skillbelt run` enforces, so a wrong one is not a
 * documentation bug, it is a permission grant nobody reviewed. The scan that
 * checks it is a pattern match and can be fooled deliberately, which is why it
 * only ever errors in the direction of demanding a declaration.
 */
async function checkDeclaration(dir, meta, label) {
  const scriptsDir = join(SKILLS, dir, 'scripts');
  if (!(await exists(scriptsDir))) return;

  const scripts = (await filesUnder(scriptsDir)).filter((f) => f.relative.endsWith('.mjs') || f.relative.endsWith('.js'));
  if (!scripts.length) return;

  if (!meta.entry) {
    errors.push(`${label} ships scripts but declares no "entry", so skillbelt run cannot launch it`);
  } else if (!(await exists(join(SKILLS, dir, meta.entry)))) {
    errors.push(`${label} entry "${meta.entry}" does not exist`);
  }

  for (const key of ['allow-read', 'allow-write', 'allow-net', 'allow-exec']) {
    if (meta[key] === undefined) errors.push(`${label} ships scripts but does not declare ${key}`);
  }

  let declaration;
  try {
    declaration = declarationOf(meta);
    // Reject a scope name now rather than at run time, where it would surface
    // as a failure in front of whoever was trying to use the skill.
    buildArgs(declaration, { skillDir: SKILLS, projectDir: SKILLS, entry: meta.entry ?? 'x' });
  } catch (error) {
    errors.push(`${label} has an unusable declaration: ${error.message}`);
    return;
  }

  const detected = { exec: false, net: false, write: false, read: false };
  for (const script of scripts) {
    const found = detect(await readFile(script.full, 'utf8'));
    for (const key of Object.keys(detected)) detected[key] ||= found[key];
  }

  const { errors: bad, warnings: untidy } = reconcile(detected, declaration);
  for (const message of bad) errors.push(`${label} ${message}`);
  for (const message of untidy) warnings.push(`${label} ${message}`);
}

const entries = await readdir(SKILLS, { withFileTypes: true });
const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

if (!dirs.length) errors.push('skills/ contains no skill directories');

// CRLF here is not a style question. The digests in skills.lock.json are taken
// over the file bytes, so one CRLF file makes a lock generated on Windows
// disagree with the same lock generated on Linux, and the failure surfaces
// later as a pin mismatch that looks like tampering. .gitattributes keeps the
// checkout at LF; this catches an editor that wrote CRLF anyway.
for (const dir of dirs) {
  for (const file of await filesUnder(join(SKILLS, dir))) {
    const bytes = await readFile(file.full);
    if (bytes.includes('\r\n')) {
      errors.push(`skills/${dir}/${file.relative} has CRLF line endings, which change its digest`);
    }
  }
}

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

  await checkDeclaration(dir, meta, label);

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

  // The allow- keys and entry are skillbelt's own. Harnesses ignore frontmatter
  // they do not recognise, so they cost nothing in Claude Code or Cursor, but
  // they are not part of the SKILL.md format and no other tool will honour them.
  const allowed = new Set([
    'name', 'description', 'license', 'allowed-tools', 'metadata',
    'entry', 'allow-read', 'allow-write', 'allow-net', 'allow-exec',
  ]);
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
