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
