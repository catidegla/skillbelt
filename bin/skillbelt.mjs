#!/usr/bin/env node
/**
 * Installs SKILL.md skills into whichever agent harnesses are on this machine.
 *
 * The skills themselves are plain directories. This exists so you do not have
 * to remember five different install paths, and so updating is one command
 * rather than five copy operations.
 */

import { readdir, readFile, cp, rm, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'skills');

// Confirmed install locations. Each harness reads SKILL.md from the same
// structure, which is the entire point of the format being a standard.
const HARNESSES = {
  claude: { label: 'Claude Code', global: join(homedir(), '.claude', 'skills'), project: join('.claude', 'skills') },
  codex: { label: 'OpenAI Codex', global: join(homedir(), '.codex', 'skills'), project: join('.codex', 'skills') },
  cursor: { label: 'Cursor', global: join(homedir(), '.cursor', 'skills'), project: join('.cursor', 'skills') },
  gemini: { label: 'Gemini CLI', global: join(homedir(), '.gemini', 'skills'), project: join('.gemini', 'skills') },
  antigravity: { label: 'Antigravity', global: null, project: join('.agents', 'skills') },
};

const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const has = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const exists = (p) => stat(p).then(() => true, () => false);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

async function readSkills() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!(await exists(manifest))) continue;

    const front = (await readFile(manifest, 'utf8')).match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const meta = {};
    if (front) {
      for (const line of front[1].split(/\r?\n/)) {
        const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
        if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }

    skills.push({
      id: entry.name,
      name: meta.name ?? entry.name,
      description: meta.description ?? '',
      path: join(SKILLS_DIR, entry.name),
    });
  }

  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

/** Which harnesses look present, judged by their config directory existing. */
async function detect() {
  const found = [];
  for (const [key, h] of Object.entries(HARNESSES)) {
    if (!h.global) continue;
    if (await exists(dirname(h.global))) found.push(key);
  }
  return found;
}

async function resolveTargets() {
  const requested = value('harness');
  const project = has('project');

  let keys;
  if (!requested || requested === 'all') {
    keys = requested === 'all' ? Object.keys(HARNESSES) : await detect();
    if (!keys.length) {
      console.error(c.red('No agent harness detected on this machine.'));
      console.error('Pass one explicitly, for example --harness claude, or --harness all.');
      process.exit(1);
    }
  } else {
    keys = requested.split(',').map((k) => k.trim());
    const unknown = keys.filter((k) => !HARNESSES[k]);
    if (unknown.length) {
      console.error(c.red(`Unknown harness: ${unknown.join(', ')}`));
      console.error(`Known: ${Object.keys(HARNESSES).join(', ')}`);
      process.exit(1);
    }
  }

  const targets = [];
  for (const key of keys) {
    const h = HARNESSES[key];
    const dir = project ? h.project : h.global;
    if (!dir) {
      if (!project) console.log(c.yellow(`  skipping ${h.label}, it only supports project-level skills, use --project`));
      continue;
    }
    targets.push({ key, label: h.label, dir });
  }
  return targets;
}

async function cmdList() {
  const skills = await readSkills();
  console.log(`\n${c.bold('Available skills')}\n`);
  for (const s of skills) {
    console.log(`  ${c.bold(s.id)}`);
    // Descriptions are long by design, they are what the agent matches on.
    const words = s.description.split(' ');
    let line = '   ';
    for (const w of words) {
      if ((line + w).length > 76) {
        console.log(c.dim(line));
        line = '   ';
      }
      line += ` ${w}`;
    }
    if (line.trim()) console.log(c.dim(line));
    console.log('');
  }
  const detected = await detect();
  console.log(detected.length
    ? `Detected: ${detected.map((k) => HARNESSES[k].label).join(', ')}`
    : 'No harness detected. Use --harness to name one.');
  console.log(`\nInstall with: ${c.bold('skillbelt add <name>')} or ${c.bold('skillbelt add --all')}\n`);
}

async function cmdDoctor() {
  console.log(`\n${c.bold('Harnesses')}\n`);
  for (const [key, h] of Object.entries(HARNESSES)) {
    const present = h.global ? await exists(dirname(h.global)) : false;
    const installedDir = h.global;
    let count = 0;
    if (installedDir && (await exists(installedDir))) {
      const entries = await readdir(installedDir, { withFileTypes: true });
      const ours = await readSkills();
      const ids = new Set(ours.map((s) => s.id));
      count = entries.filter((e) => e.isDirectory() && ids.has(e.name)).length;
    }

    const mark = present ? c.green('found') : c.dim('not found');
    console.log(`  ${h.label.padEnd(16)} ${mark}`);
    console.log(c.dim(`    global   ${h.global ?? 'not supported'}`));
    console.log(c.dim(`    project  ${h.project}`));
    if (count) console.log(c.dim(`    ${count} skill(s) from this pack installed`));
    console.log('');
  }
}

async function cmdAdd() {
  const skills = await readSkills();
  const wanted = has('all')
    ? skills
    : skills.filter((s) => positional.includes(s.id));

  if (!wanted.length) {
    console.error(c.red(positional.length ? `No such skill: ${positional.join(', ')}` : 'Name a skill, or pass --all.'));
    console.error(`Available: ${skills.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  const targets = await resolveTargets();
  console.log('');

  for (const target of targets) {
    console.log(c.bold(target.label));
    await mkdir(target.dir, { recursive: true });

    for (const skill of wanted) {
      const dest = join(target.dir, skill.id);
      const existed = await exists(dest);
      await cp(skill.path, dest, { recursive: true, force: true });
      console.log(`  ${existed ? c.yellow('updated') : c.green('added  ')} ${skill.id}`);
    }
    console.log(c.dim(`  ${target.dir}`));
    console.log('');
  }

  console.log('Restart the agent, or start a new session, for it to pick these up.\n');
}

async function cmdRemove() {
  if (!positional.length && !has('all')) {
    console.error(c.red('Name a skill to remove, or pass --all.'));
    process.exit(1);
  }

  const skills = await readSkills();
  const wanted = has('all') ? skills : skills.filter((s) => positional.includes(s.id));
  const targets = await resolveTargets();
  console.log('');

  for (const target of targets) {
    console.log(c.bold(target.label));
    for (const skill of wanted) {
      const dest = join(target.dir, skill.id);
      if (await exists(dest)) {
        await rm(dest, { recursive: true, force: true });
        console.log(`  ${c.green('removed')} ${skill.id}`);
      } else {
        console.log(`  ${c.dim('absent ')} ${skill.id}`);
      }
    }
    console.log('');
  }
}

function usage() {
  console.log(`
${c.bold('skillbelt')}  portable agent skills for secure coding and i18n

  ${c.bold('list')}                    show available skills and detected harnesses
  ${c.bold('add')} <name...|--all      install skills
  ${c.bold('remove')} <name...|--all   uninstall skills
  ${c.bold('doctor')}                  show every install path and what is present

Options
  --harness <a,b>         claude, codex, cursor, gemini, antigravity, or all
                          defaults to whatever is detected on this machine
  --project               install into the current project instead of your home directory

Examples
  npx github:catidegla/skillbelt list
  npx github:catidegla/skillbelt add --all
  npx github:catidegla/skillbelt add i18n-parity --harness claude,cursor
  npx github:catidegla/skillbelt add laravel-security-review --project
`);
}

const commands = { list: cmdList, add: cmdAdd, remove: cmdRemove, doctor: cmdDoctor };

if (!command || has('help') || command === 'help') {
  usage();
} else if (commands[command]) {
  commands[command]().catch((error) => {
    console.error(c.red(error.message));
    process.exit(1);
  });
} else {
  console.error(c.red(`Unknown command: ${command}`));
  usage();
  process.exit(1);
}
