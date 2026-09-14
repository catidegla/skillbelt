#!/usr/bin/env node
/**
 * Regression tests for the i18n parity checker.
 *
 * Builds a fixture with one of each defect planted, runs the checker against
 * it, and asserts on the JSON output. Uses node:test so there is nothing to
 * install.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'skills', 'i18n-parity', 'scripts', 'check-parity.mjs');

const EN = {
  welcome: 'Hello :name, you have :count messages',
  items: 'one item|many items',
  nav: { home: 'Home', settings: 'Account settings' },
  shared: 'Menu',
  farewell: 'See you soon',
  tagline: 'The fastest way to ship',
};

const FR = {
  welcome: 'Bonjour :nom, vous avez :count messages', // placeholder translated
  items: 'un article', // lost a plural branch
  nav: { home: 'Accueil', settings: '' }, // empty value
  shared: 'Menu', // legitimately identical, single word
  tagline: 'The fastest way to ship', // untranslated
  extra_key: 'Clef en trop', // not in source
  // farewell is missing entirely
};

async function buildFixture(en, fr) {
  const dir = await mkdtemp(join(tmpdir(), 'skillbelt-i18n-'));
  await mkdir(join(dir, 'lang'), { recursive: true });
  await writeFile(join(dir, 'lang', 'en.json'), JSON.stringify(en, null, 2));
  await writeFile(join(dir, 'lang', 'fr.json'), JSON.stringify(fr, null, 2));
  return dir;
}

async function check(dir) {
  try {
    const { stdout } = await run(process.execPath, [CHECKER, '--source', 'en', '--json'], { cwd: dir });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    // Exit code 1 means blocking problems were found, which is a valid result.
    return { code: error.code, report: JSON.parse(error.stdout) };
  }
}

test('detects every planted defect', async (t) => {
  const dir = await buildFixture(EN, FR);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { code, report } = await check(dir);
  const fr = report.locales.fr;

  assert.equal(code, 1, 'should exit 1 when blocking problems exist');

  assert.deepEqual(fr.missing, ['farewell']);
  assert.deepEqual(fr.empty, ['nav.settings']);
  assert.deepEqual(fr.extra, ['extra_key']);

  assert.equal(fr.placeholderMismatch.length, 1);
  assert.equal(fr.placeholderMismatch[0].key, 'welcome');
  assert.match(fr.placeholderMismatch[0].found, /:nom/);

  assert.equal(fr.pluralMismatch.length, 1);
  assert.equal(fr.pluralMismatch[0].key, 'items');
  assert.equal(fr.pluralMismatch[0].expected, 2);
  assert.equal(fr.pluralMismatch[0].found, 1);

  assert.deepEqual(fr.untranslated, ['tagline'], 'multi-word identical values are flagged');
});

test('a single identical word is not reported as untranslated', async (t) => {
  const dir = await buildFixture({ shared: 'Menu' }, { shared: 'Menu' });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { code, report } = await check(dir);
  assert.equal(code, 0);
  assert.deepEqual(report.locales.fr.untranslated, []);
});

test('a complete translation passes', async (t) => {
  const en = { greeting: 'Hello :name', count: 'one file|many files' };
  const fr = { greeting: 'Bonjour :name', count: 'un fichier|plusieurs fichiers' };

  const dir = await buildFixture(en, fr);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { code, report } = await check(dir);
  assert.equal(code, 0);
  assert.equal(report.blocking, 0);
  assert.deepEqual(report.locales.fr.missing, []);
  assert.deepEqual(report.locales.fr.placeholderMismatch, []);
});

test('ICU plural syntax is not compared as pipe branches', async (t) => {
  const en = { items: '{count, plural, one {# item} other {# items}}' };
  const fr = { items: '{count, plural, =0 {Aucun article} one {# article} other {# articles}}' };

  const dir = await buildFixture(en, fr);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { report } = await check(dir);
  assert.deepEqual(report.locales.fr.pluralMismatch, [], 'ICU branches differ by design between languages');
});

/**
 * The unsandboxed spawn refusal.
 *
 * `allow-exec: php` is only enforced when skillbelt run starts the script under
 * Node's permission model. Run directly, the grant is unbounded and nobody
 * reviewed it, so the spawn fails closed rather than printing a warning and
 * carrying on. The distinction matters because a report built without php is
 * not a smaller report, it is a wrong one: every key in a PHP locale file
 * reads as missing.
 */
test('reading a PHP locale unsandboxed is refused rather than warned about', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'parity-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'lang', 'en'), { recursive: true });
  await writeFile(join(dir, 'lang', 'en', 'm.php'), '<?php\nreturn ["a" => "A"];\n');

  const result = await run(process.execPath, [CHECKER, '--dir', join(dir, 'lang')], { cwd: dir })
    .then(() => ({ code: 0, stderr: '' }), (error) => ({ code: error.code, stderr: error.stderr }));

  assert.equal(result.code, 3, 'refusing to start is exit 3, not the 1 that means problems were found');
  assert.match(result.stderr, /Refused to run php/);
  assert.match(result.stderr, /skillbelt run i18n-parity/);
});

test('the refusal can be overridden deliberately, and says how', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'parity-optin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'lang', 'en'), { recursive: true });
  await writeFile(join(dir, 'lang', 'en', 'm.php'), '<?php\nreturn ["a" => "A"];\n');

  const env = { ...process.env, SKILLBELT_ALLOW_UNSANDBOXED_EXEC: '1' };
  const result = await run(process.execPath, [CHECKER, '--dir', join(dir, 'lang'), '--json'], { cwd: dir, env })
    .then((r) => r.stdout, (error) => error.stdout);

  assert.doesNotMatch(String(result), /unsandboxed_exec_refused/);
});

test('a JSON-only project still runs directly, which is the documented path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'parity-json-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'lang'), { recursive: true });
  await writeFile(join(dir, 'lang', 'en.json'), JSON.stringify({ a: 'A' }));
  await writeFile(join(dir, 'lang', 'fr.json'), JSON.stringify({ a: 'A' }));

  const out = await run(process.execPath, [CHECKER, '--dir', join(dir, 'lang'), '--json'], { cwd: dir })
    .then((r) => r.stdout, (error) => error.stdout);

  assert.doesNotMatch(String(out), /unsandboxed_exec_refused/);
});
