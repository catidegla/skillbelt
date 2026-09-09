#!/usr/bin/env node
/**
 * Tests that the sandbox actually contains, rather than that it was configured.
 *
 * A permission flag that is passed but not enforced looks identical to one that
 * works, right up until it matters, so each of these plants a script that tries
 * the forbidden thing and asserts it was refused. If Node ever changes what the
 * model covers, these fail rather than quietly becoming decorative.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { declarationOf, buildArgs, describe, support, unenforceable } from '../bin/sandbox.mjs';
import { detect, reconcile, stripComments } from '../bin/capabilities.mjs';

const AVAILABLE = support();
const CAN_ENFORCE = AVAILABLE.permission;

// Printed so a CI log records what this runtime actually covers. The model
// gained its categories over several releases and the version number does not
// tell you which are in, so the log is the only place that fact is written down.
console.log(`# node ${process.version} permission=${AVAILABLE.permission} net=${AVAILABLE.net} child=${AVAILABLE.childProcess}`);

async function skillWith(entrySource) {
  const dir = await mkdtemp(join(tmpdir(), 'skillbelt-sbx-'));
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(join(dir, 'scripts', 'entry.mjs'), entrySource, 'utf8');
  return dir;
}

function launch(meta, skillDir, projectDir) {
  const argv = buildArgs(declarationOf(meta), { skillDir, projectDir, entry: 'scripts/entry.mjs' });
  return spawnSync(process.execPath, argv, { encoding: 'utf8', cwd: projectDir });
}

const DENIED = /ERR_ACCESS_DENIED/;

test('reading outside the declared scope is refused', { skip: !CAN_ENFORCE && 'this Node has no --permission' }, async () => {
  const skill = await skillWith(`
    import { readFileSync } from 'node:fs';
    try { readFileSync(process.argv[2] ?? ${JSON.stringify(join(homedir(), '.gitconfig'))}); console.log('READ_OK'); }
    catch (e) { console.log('READ_DENIED', e.code); }
  `);
  const project = await mkdtemp(join(tmpdir(), 'skillbelt-proj-'));

  const result = launch({ 'allow-read': 'project, skill', 'allow-write': 'none', 'allow-net': 'no', 'allow-exec': 'no' }, skill, project);
  assert.match(result.stdout, /READ_DENIED/, result.stdout + result.stderr);
  assert.match(result.stdout, DENIED);

  await rm(skill, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

test('reading inside the project is allowed', { skip: !CAN_ENFORCE && 'this Node has no --permission' }, async () => {
  const skill = await skillWith(`
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    console.log(readFileSync(join(process.cwd(), 'inside.txt'), 'utf8').trim());
  `);
  const project = await mkdtemp(join(tmpdir(), 'skillbelt-proj-'));
  await writeFile(join(project, 'inside.txt'), 'READ_OK\n', 'utf8');

  const result = launch({ 'allow-read': 'project, skill', 'allow-write': 'none', 'allow-net': 'no', 'allow-exec': 'no' }, skill, project);
  assert.match(result.stdout, /READ_OK/, result.stdout + result.stderr);

  await rm(skill, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

test('writing is refused when allow-write is none', { skip: !CAN_ENFORCE && 'this Node has no --permission' }, async () => {
  const skill = await skillWith(`
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    try { writeFileSync(join(process.cwd(), 'out.txt'), 'x'); console.log('WRITE_OK'); }
    catch (e) { console.log('WRITE_DENIED', e.code); }
  `);
  const project = await mkdtemp(join(tmpdir(), 'skillbelt-proj-'));

  const result = launch({ 'allow-read': 'project', 'allow-write': 'none', 'allow-net': 'no', 'allow-exec': 'no' }, skill, project);
  assert.match(result.stdout, /WRITE_DENIED/, result.stdout + result.stderr);
  assert.match(result.stdout, DENIED);

  await rm(skill, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

test('a child process is refused when allow-exec is no', { skip: (!CAN_ENFORCE && 'this Node has no --permission') || (!AVAILABLE.childProcess && 'this Node has no --allow-child-process') }, async () => {
  const skill = await skillWith(`
    import { execFileSync } from 'node:child_process';
    try { execFileSync(process.execPath, ['-e', '0']); console.log('EXEC_OK'); }
    catch (e) { console.log('EXEC_DENIED', e.code ?? String(e.message).slice(0, 40)); }
  `);
  const project = await mkdtemp(join(tmpdir(), 'skillbelt-proj-'));

  const result = launch({ 'allow-read': 'project', 'allow-write': 'none', 'allow-net': 'no', 'allow-exec': 'no' }, skill, project);
  assert.match(result.stdout, /EXEC_DENIED/, result.stdout + result.stderr);

  await rm(skill, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

test('the network is refused when allow-net is no', { skip: (!CAN_ENFORCE && 'this Node has no --permission') || (!AVAILABLE.net && 'this Node has no --allow-net, so the model does not cover network') }, async () => {
  // A raw socket rather than fetch, because it fails without needing the host
  // to resolve, so the test does not depend on the machine being online.
  const skill = await skillWith(`
    import { connect } from 'node:net';
    const s = connect(9, '127.0.0.1');
    s.on('connect', () => { console.log('NET_OK'); s.destroy(); });
    s.on('error', (e) => console.log('NET_DENIED', e.code));
  `);
  const project = await mkdtemp(join(tmpdir(), 'skillbelt-proj-'));

  const result = launch({ 'allow-read': 'project', 'allow-write': 'none', 'allow-net': 'no', 'allow-exec': 'no' }, skill, project);
  assert.match(result.stdout, /NET_DENIED/, result.stdout + result.stderr);
  assert.match(result.stdout, DENIED);

  await rm(skill, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

test('an undeclared capability defaults to denied', () => {
  const declaration = declarationOf({ name: 'x' });
  assert.deepEqual(declaration.read, []);
  assert.deepEqual(declaration.write, []);
  assert.equal(declaration.net, false);
  assert.deepEqual(declaration.exec, []);
});

test('an unknown scope name is rejected rather than ignored', () => {
  assert.throws(
    () => buildArgs(declarationOf({ 'allow-read': 'home' }), { skillDir: '/s', projectDir: '/p', entry: 'e.mjs' }),
    /unknown scope/,
  );
});

test('the skill directory is always readable, since Node must load the entry', () => {
  const argv = buildArgs(declarationOf({ 'allow-read': 'none' }), { skillDir: '/s', projectDir: '/p', entry: 'e.mjs' });
  assert.ok(argv.some((a) => a.startsWith('--allow-fs-read=') && a.includes('/s')));
  assert.ok(!argv.some((a) => a.startsWith('--allow-fs-read=') && a.includes('/p')));
});

test('describe says plainly that exec is not narrowed to the named binary', () => {
  const lines = describe(declarationOf({ 'allow-exec': 'php' }));
  assert.ok(lines.some((l) => l.includes('php') && l.includes('whole child process capability')));
});

test('the capability scan sees through to real calls and ignores comments', () => {
  assert.equal(detect("import { execFile } from 'node:child_process';").exec, true);
  assert.equal(detect('// we deliberately avoid child_process here').exec, false);
  assert.equal(detect('/* fetch( is mentioned in this block comment */').net, false);
  assert.equal(detect('const r = await fetch(url);').net, true);
  assert.equal(detect('await writeFile(p, data);').write, true);
  assert.ok(!stripComments('a // b\nc').includes('b'));
});

test('using an undeclared capability is an error, declaring an unused one is a warning', () => {
  const undeclared = reconcile({ exec: true, net: false, write: false, read: false }, declarationOf({ 'allow-read': 'project' }));
  assert.equal(undeclared.errors.length, 1);
  assert.match(undeclared.errors[0], /child process/);

  const unused = reconcile({ exec: false, net: false, write: false, read: true }, declarationOf({ 'allow-read': 'project', 'allow-exec': 'php' }));
  assert.equal(unused.errors.length, 0);
  assert.equal(unused.warnings.length, 1);
});

test('a denial this Node cannot enforce is reported rather than claimed', () => {
  const denyAll = declarationOf({ 'allow-read': 'project' });

  const complete = { permission: true, net: true, childProcess: true };
  assert.deepEqual(unenforceable(denyAll, complete), []);
  assert.ok(describe(denyAll, complete).some((l) => l === 'net    no'));

  // A runtime whose model has no network category cannot deny the network, so
  // the banner has to say that instead of printing a limit that does not hold.
  const noNet = { permission: true, net: false, childProcess: true };
  assert.deepEqual(unenforceable(denyAll, noNet), ['allow-net: no']);
  assert.ok(describe(denyAll, noNet).some((l) => l.includes('NOT ENFORCED')));

  // Asking for the network is different: that grant is simply unavailable, and
  // run() rejects it separately rather than treating it as an unenforced deny.
  const wantsNet = declarationOf({ 'allow-read': 'project', 'allow-net': 'yes' });
  assert.deepEqual(unenforceable(wantsNet, noNet), []);
});
