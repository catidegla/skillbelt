/**
 * Running a skill's script with only the access it declared.
 *
 * The honest scope of this, stated once here and again in the README: it binds
 * when the script is launched through `skillbelt run`. An agent that reads
 * SKILL.md and types `node scripts/whatever.mjs` itself gets no sandbox, and
 * nothing in an installer can prevent that. What this does buy is a declared,
 * reviewable, enforced capability set for the launch path we control, and a
 * declaration that validate-skills checks against the code, so a skill cannot
 * quietly start reaching the network without the manifest saying so.
 *
 * Enforcement comes from Node's own permission model, so the guarantees are
 * exactly Node's and no stronger:
 *
 *   fs read and write   scoped to the paths we pass, genuinely enforced
 *   network             all or nothing, no per-host scoping exists
 *   child process       all or nothing, and Node itself warns that granting
 *                       it can invalidate the rest of the model
 *
 * That last one matters for honesty. A skill that declares `allow-exec: php`
 * gets the whole child process capability, not php alone, because Node has no
 * way to express the narrower grant. The binary list is disclosure that shows
 * up in a diff, not a fence.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** Node gained the model in 20, stabilised it in 22.13, and still marks --allow-net experimental. */
export function support() {
  const flags = process.allowedNodeEnvironmentFlags;
  return {
    permission: flags.has('--permission'),
    net: flags.has('--allow-net'),
    childProcess: flags.has('--allow-child-process'),
  };
}

const list = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && part !== 'none' && part !== 'no');

/**
 * Turn the four allow- keys in SKILL.md frontmatter into something checkable.
 *
 * Unset means denied. That is the whole point of the default: a skill that
 * forgets to declare something loses the capability rather than keeping it.
 */
export function declarationOf(meta) {
  const read = list(meta['allow-read']);
  const write = list(meta['allow-write']);
  const net = ['yes', 'true'].includes(String(meta['allow-net'] ?? '').trim().toLowerCase());
  const exec = list(meta['allow-exec']).filter((name) => name !== 'yes');

  return { read, write, net, exec, execAll: ['yes', 'true'].includes(String(meta['allow-exec'] ?? '').trim().toLowerCase()) };
}

/**
 * The scopes are named rather than free paths so that a skill cannot declare
 * its way to the home directory. `project` is wherever the agent is working,
 * `skill` is the installed skill's own directory.
 */
function scopePaths(scope, { skillDir, projectDir }) {
  const paths = [];
  for (const name of scope) {
    if (name === 'project') paths.push(projectDir);
    else if (name === 'skill') paths.push(skillDir);
    else throw new Error(`unknown scope "${name}", expected project, skill or none`);
  }
  return paths;
}

export function buildArgs(declaration, { skillDir, projectDir, entry, args = [] }) {
  const flags = ['--permission'];

  // The script has to be readable for Node to load it at all, so the skill
  // directory is always readable regardless of what was declared. Declaring
  // `skill` on top of that only matters for reference files it opens itself.
  const reads = new Set([skillDir, ...scopePaths(declaration.read, { skillDir, projectDir })]);
  for (const path of reads) flags.push(`--allow-fs-read=${join(path, '*')}`, `--allow-fs-read=${path}`);

  for (const path of scopePaths(declaration.write, { skillDir, projectDir })) {
    flags.push(`--allow-fs-write=${join(path, '*')}`, `--allow-fs-write=${path}`);
  }

  if (declaration.net) flags.push('--allow-net');
  if (declaration.exec.length || declaration.execAll) flags.push('--allow-child-process');

  return [...flags, join(skillDir, entry), ...args];
}

/** A line per capability, in the order a reader cares about. */
export function describe(declaration) {
  const lines = [];
  lines.push(`read   ${declaration.read.length ? declaration.read.join(', ') : 'nothing'}`);
  lines.push(`write  ${declaration.write.length ? declaration.write.join(', ') : 'nothing'}`);
  lines.push(`net    ${declaration.net ? 'yes, unscoped, Node cannot limit it by host' : 'no'}`);
  if (declaration.execAll) lines.push('exec   yes, any binary');
  else if (declaration.exec.length) lines.push(`exec   ${declaration.exec.join(', ')}, granted as the whole child process capability`);
  else lines.push('exec   no');
  return lines;
}

export function run(declaration, options) {
  const { permission } = support();
  if (!permission) {
    throw new Error(
      `this Node (${process.version}) has no --permission flag, so the declared limits cannot be enforced.\n` +
        'Node 22.13 or newer is where the permission model is stable. Run the script directly if you accept that.',
    );
  }

  if (declaration.net && !support().net) {
    throw new Error(`this Node (${process.version}) has no --allow-net, and the skill needs the network`);
  }

  const argv = buildArgs(declaration, options);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: 'inherit', cwd: options.projectDir });
    child.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}
