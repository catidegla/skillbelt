#!/usr/bin/env node
/**
 * Compares translation files across locales and reports what is missing, what
 * is stale, and what will break at runtime.
 *
 * Handles the four layouts that cover most projects:
 *   lang/{locale}/*.php        Laravel PHP arrays (requires php on PATH)
 *   lang/{locale}.json         Laravel JSON translations
 *   messages/{locale}.json     next-intl
 *   locales/{locale}/*.json    react-i18next and friends
 *
 * Usage:
 *   node check-parity.mjs
 *   node check-parity.mjs --source en --dir lang
 *   node check-parity.mjs --json
 *
 * Exits 1 when a blocking problem is found. Missing keys block. Untranslated
 * values warn, because sometimes a word really is the same in both languages.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, extname, basename } from 'node:path';

const run = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const SOURCE = flag('source', 'en');
const AS_JSON = has('json');
const CANDIDATE_DIRS = flag('dir') ? [flag('dir')] : ['lang', 'messages', 'locales', 'src/locales', 'public/locales', 'resources/lang'];

// Laravel uses :name and :Name. ICU and next-intl use {name}. Vue i18n uses {name} too.
const PLACEHOLDER = /(?::[a-zA-Z_][a-zA-Z0-9_]*|\{[a-zA-Z_][a-zA-Z0-9_]*(?:,[^}]*)?\})/g;

function exists(path) {
  return stat(path).then(() => true, () => false);
}

/** Flatten nested objects into dot notation, so a.b.c compares across files. */
function flatten(value, prefix = '', out = {}) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child, path, out);
    } else {
      out[path] = Array.isArray(child) ? child.join('|') : String(child ?? '');
    }
  }
  return out;
}

/** PHP arrays are read by php itself rather than by a parser we would have to maintain. */
async function readPhpFile(path) {
  try {
    const { stdout } = await run('php', ['-r', `echo json_encode(require ${JSON.stringify(path)});`], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function readLocale(dir, locale) {
  const messages = {};

  // lang/{locale}.json or messages/{locale}.json
  const flatFile = join(dir, `${locale}.json`);
  if (await exists(flatFile)) {
    Object.assign(messages, flatten(JSON.parse(await readFile(flatFile, 'utf8'))));
  }

  // lang/{locale}/*.php and locales/{locale}/*.json
  const localeDir = join(dir, locale);
  if (await exists(localeDir)) {
    for (const entry of await readdir(localeDir)) {
      const path = join(localeDir, entry);
      const namespace = basename(entry, extname(entry));

      if (entry.endsWith('.json')) {
        Object.assign(messages, flatten(JSON.parse(await readFile(path, 'utf8')), namespace));
      } else if (entry.endsWith('.php')) {
        const parsed = await readPhpFile(path);
        if (parsed === null) {
          messages[`${namespace}.__unreadable__`] = '';
        } else {
          Object.assign(messages, flatten(parsed, namespace));
        }
      }
    }
  }

  return messages;
}

async function detectLocales(dir) {
  const found = new Set();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[a-z]{2}(_[A-Z]{2}|-[A-Z]{2})?$/.test(entry.name)) found.add(entry.name);
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const name = basename(entry.name, '.json');
      if (/^[a-z]{2}(_[A-Z]{2}|-[A-Z]{2})?$/.test(name)) found.add(name);
    }
  }
  return [...found].sort();
}

function placeholders(text) {
  return (text.match(PLACEHOLDER) ?? []).map((p) => p.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*),.*\}/, '{$1}')).sort();
}

/** Laravel pipe syntax: "one apple|many apples". Counts the branches. */
function pluralBranches(text) {
  if (/\{\s*\w+\s*,\s*plural\s*,/.test(text)) return null; // ICU, structure differs by design
  return text.includes('|') ? text.split('|').length : 1;
}

async function main() {
  let dir = null;
  for (const candidate of CANDIDATE_DIRS) {
    if (await exists(candidate)) {
      dir = candidate;
      break;
    }
  }

  if (!dir) {
    console.error(`No translation directory found. Looked in: ${CANDIDATE_DIRS.join(', ')}`);
    console.error('Pass one explicitly with --dir.');
    process.exit(2);
  }

  const locales = await detectLocales(dir);
  if (!locales.includes(SOURCE)) {
    console.error(`Source locale "${SOURCE}" not found in ${dir}. Found: ${locales.join(', ') || 'none'}`);
    process.exit(2);
  }

  const loaded = {};
  for (const locale of locales) loaded[locale] = await readLocale(dir, locale);

  const sourceKeys = Object.keys(loaded[SOURCE]);
  const report = { directory: dir, source: SOURCE, locales: {}, blocking: 0 };

  for (const locale of locales) {
    if (locale === SOURCE) continue;

    const target = loaded[locale];
    const targetKeys = new Set(Object.keys(target));

    const missing = sourceKeys.filter((k) => !targetKeys.has(k));
    const extra = [...targetKeys].filter((k) => !(k in loaded[SOURCE]));
    const placeholderMismatch = [];
    const pluralMismatch = [];
    const untranslated = [];
    const empty = [];

    for (const key of sourceKeys) {
      if (!targetKeys.has(key)) continue;

      const from = loaded[SOURCE][key];
      const to = target[key];

      if (!to.trim()) {
        empty.push(key);
        continue;
      }

      const a = placeholders(from).join(',');
      const b = placeholders(to).join(',');
      if (a !== b) {
        placeholderMismatch.push({ key, expected: a || '(none)', found: b || '(none)' });
      }

      const pa = pluralBranches(from);
      const pb = pluralBranches(to);
      if (pa !== null && pb !== null && pa !== pb) {
        pluralMismatch.push({ key, expected: pa, found: pb });
      }

      if (from === to && from.length > 3 && /\s/.test(from)) {
        untranslated.push(key);
      }
    }

    // A missing key throws or renders the raw key. A broken placeholder renders
    // a literal ":name" to the user. Both are visible defects, so both block.
    const blocking = missing.length + placeholderMismatch.length + empty.length;
    report.blocking += blocking;
    report.locales[locale] = {
      total: targetKeys.size,
      missing,
      extra,
      empty,
      placeholderMismatch,
      pluralMismatch,
      untranslated,
      blocking,
    };
  }

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.blocking ? 1 : 0);
  }

  console.log(`Translations in ${dir}, comparing against "${SOURCE}" (${sourceKeys.length} keys)\n`);

  for (const [locale, r] of Object.entries(report.locales)) {
    const coverage = sourceKeys.length ? Math.round(((sourceKeys.length - r.missing.length) / sourceKeys.length) * 100) : 100;
    console.log(`${locale}  ${coverage}% complete  (${r.total} keys)`);

    const section = (label, items, render) => {
      if (!items.length) return;
      console.log(`  ${label} (${items.length})`);
      for (const item of items.slice(0, 15)) console.log(`    ${render(item)}`);
      if (items.length > 15) console.log(`    ... and ${items.length - 15} more`);
    };

    section('missing', r.missing, (k) => k);
    section('empty', r.empty, (k) => k);
    section('placeholder mismatch', r.placeholderMismatch, (m) => `${m.key}: expected ${m.expected}, found ${m.found}`);
    section('plural branch mismatch', r.pluralMismatch, (m) => `${m.key}: source has ${m.expected}, target has ${m.found}`);
    section('possibly untranslated', r.untranslated, (k) => k);
    section('not in source', r.extra, (k) => k);

    if (!r.blocking && !r.untranslated.length && !r.extra.length) console.log('  clean');
    console.log('');
  }

  if (report.blocking) {
    console.log(`${report.blocking} blocking problem(s). Missing keys, empty values and placeholder mismatches are visible to users.`);
    process.exit(1);
  }

  console.log('No blocking problems.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
