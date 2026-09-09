<div align="center">

# skillbelt

Portable agent skills for secure coding and translation parity.

Works in Claude Code, Codex, Cursor, Gemini CLI and Antigravity. Same files, one install command.

[![CI](https://github.com/catidegla/skillbelt/actions/workflows/ci.yml/badge.svg)](https://github.com/catidegla/skillbelt/actions/workflows/ci.yml)
[![Skills](https://img.shields.io/badge/skills-4-7c3aed)](#the-skills)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

Agent skills are just directories with a `SKILL.md` in them, and since late 2025 every major harness reads the same format. What none of them agree on is where the directory goes. Claude Code wants `~/.claude/skills`, Codex wants `~/.codex/skills`, Cursor wants `~/.cursor/skills`, and so on.

So this is two things: four skills worth having, and a small installer that puts them wherever they need to go.

The installer half is not a novel idea and it would be odd to pretend otherwise. [`agent-install`](https://www.npmjs.com/package/agent-install) does the same job and also handles MCP servers and `AGENTS.md`, and the [`skills`](https://www.npmjs.com/package/skills) package is building a general registry for the format. If you want a package manager for skills, use one of those. What is here is a curated set of four that are maintained together and validated as a suite, with installation attached because the skills are useless sitting in a repository. Checked on npm on 8 September 2026.

## Install

```bash
npx github:catidegla/skillbelt add --all
```

That detects which harnesses are on your machine and installs into each. No clone, no `npm install`, no dependencies.

```bash
# Just one skill, just one harness
npx github:catidegla/skillbelt add i18n-parity --harness claude

# Into the current project instead of your home directory
npx github:catidegla/skillbelt add --all --project

# See where everything would go
npx github:catidegla/skillbelt doctor
```

Start a new agent session afterwards so it picks them up.

<details>
<summary>As a Claude Code plugin instead</summary>

```
/plugin marketplace add catidegla/skillbelt
/plugin install skillbelt@skillbelt
```

</details>

## The skills

| Skill | What it does |
| :--- | :--- |
| **`laravel-security-review`** | Reviews Laravel and PHP for the defects that actually ship: missing authorization on route model binding, `$guarded = []`, interpolated `orderByRaw`, `{!! !!}` on user input, `mimetypes:` instead of `mimes:`. Comes with a grep sheet for each pattern. |
| **`nextjs-security-review`** | Covers the server and client boundary, which is where Next.js bugs come from. Server Actions as unauthenticated public endpoints, whole Prisma records serialized into client props, `NEXT_PUBLIC_` leaks, middleware treated as an authorization layer. |
| **`i18n-parity`** | Ships a working checker. Finds missing keys, empty values, translated placeholders, and lost plural branches across locale files. Plus the English and French rules a key diff cannot catch. |
| **`secrets-audit`** | Finds committed credentials in the working tree and in git history, then walks the remediation in the right order. Rotate first, rewrite history second. |

Each one is a procedure with real code, not a list of principles. The security skills open by telling the agent to scope to the diff and verify before reporting, because the failure mode for this kind of tool is forty low-confidence findings nobody reads.

### The i18n checker

`i18n-parity` includes a script that runs on its own:

```bash
node ~/.claude/skills/i18n-parity/scripts/check-parity.mjs
```

```
Translations in lang, comparing against "en" (6 keys)

fr  83% complete  (6 keys)
  missing (1)
    farewell
  empty (1)
    nav.settings
  placeholder mismatch (1)
    welcome: expected :count,:name, found :count,:nom
  plural branch mismatch (1)
    items: source has 2, target has 1

3 blocking problem(s). Missing keys, empty values and placeholder mismatches are visible to users.
```

That third one is the bug worth having a tool for. A translator sees `:name` inside a French sentence, treats it as a word, and writes `:nom`. Nothing throws. The placeholder never substitutes and the user reads a literal `:nom` on the page.

It auto-detects Laravel PHP arrays, Laravel JSON, next-intl and react-i18next layouts, exits non-zero on anything a user would see, and takes `--json` for CI.

## Where things get installed

| Harness | Global | Project |
| :--- | :--- | :--- |
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| OpenAI Codex | `~/.codex/skills` | `.codex/skills` |
| Cursor | `~/.cursor/skills` | `.cursor/skills` |
| Gemini CLI | `~/.gemini/skills` | `.gemini/skills` |
| Antigravity | not supported | `.agents/skills` |

## Skills are code, so installs are pinned

A skill is not documentation. `SKILL.md` tells the agent what to do and the scripts beside it run on your machine, which makes copying one into five directories a supply chain decision rather than a file copy.

Two records make that checkable.

`skills.lock.json` ships with the package and records the sha256 of every skill as released. Installing compares against it and refuses on a mismatch, because at that point the files on disk are demonstrably not the ones the lock describes:

```
  secrets-audit does not match its pinned digest
    expected 0bf6bd9dbbbf, found 5efbb2d5a4ed

If you edited these skills, run npm run lock to repin them.
If you did not, the files in skills/ are not the ones that shipped.
```

`.skillbelt.json` is written beside the installed skills and records what was actually put there. That is what `verify` reads, and it answers the question the lock cannot, which is whether anything has touched the copy since you installed it:

```bash
skillbelt verify --harness all
```

```
Claude Code
  modified i18n-parity
    installed 720e35a4bbfe, on disk 7bf8cec63b3f
```

`verify` exits non-zero when something is modified, so it works in CI. A skill that simply has a newer version available is reported as `outdated` instead and does not fail the run.

The digest is a sha256 over a sorted listing of `<file sha256>  <path>`, so a rename is caught even when no file content changed. Symbolic links inside a skill are refused rather than followed, since the installer copies recursively and a link can point anywhere on the machine.

Pinning tells you the code is the code that was published. It does not tell you the code is safe, which is what the next part is for.

## Skills declare what they may reach, and run inside it

A skill that ships scripts has to say what those scripts may touch, in its frontmatter:

```yaml
entry: scripts/check-parity.mjs
allow-read: project, skill
allow-write: none
allow-net: no
allow-exec: php
```

`skillbelt run` launches the entry script with exactly that and nothing more, through Node's permission model:

```bash
skillbelt run i18n-parity
```

```
skillbelt: running i18n-parity/scripts/check-parity.mjs with
  read   project, skill
  write  nothing
  net    no
  exec   php, granted as the whole child process capability
```

Anything undeclared is denied, so a skill that forgets a key loses the capability rather than keeping it. The scopes are named rather than free paths, `project` being the directory you are working in and `skill` the installed skill itself, so a skill cannot declare its way to your home directory.

The declaration is checked against the code before the skill ships. `validate-skills.mjs` scans the scripts and fails when they use something the manifest does not grant:

```
skills/i18n-parity reaches the network but declares allow-net: no
```

### What is enforced, and what is only disclosed

Node's model is what does the enforcing, so the guarantees are its guarantees:

| | |
| :--- | :--- |
| filesystem read and write | enforced, scoped to the declared paths |
| network | enforced, all or nothing, no per-host limit exists |
| child process | enforced, all or nothing |

That last row is why `allow-exec: php` reads the way it does. The i18n checker shells out to `php` to read PHP locale arrays, and Node has no way to grant php alone, so the skill receives the whole child process capability. The binary list is disclosure that shows up in a diff. It is not a fence, and Node prints its own warning saying as much.

### The honest limit

This binds scripts launched through `skillbelt run`. An agent that reads SKILL.md and types `node scripts/check-parity.mjs` gets no sandbox at all, and an installer cannot prevent that. The skills here document the sandboxed invocation first for that reason.

So the three parts stand differently. Provenance is pinned and enforced. Capabilities are declared, checked against the code, and enforced on the launch path this tool controls. Containment of a script somebody else chooses to run directly is not something this can offer, and nothing here pretends otherwise.

## CLI

```
skillbelt list                    show available skills and detected harnesses
skillbelt add <name...|--all>     install
skillbelt remove <name...|--all>  uninstall
skillbelt verify                  check installed skills against their recorded digests
skillbelt run <name> [-- args]    run a skill's script with only the access it declared
skillbelt doctor                  every install path and what is present

  --harness <a,b>   claude, codex, cursor, gemini, antigravity, or all
                    defaults to whatever is detected
  --project         install into the current project
  --force           install even when a skill does not match its pinned digest
  --quiet           with run, do not print the capability banner
```

`run` asks the running Node what its permission model actually covers rather than trusting a version number, because the model gained its categories over several releases and having `--permission` does not mean having `--allow-net`. If a limit the manifest denies cannot be enforced on your runtime, `run` refuses and says which one:

```
this Node (v22.x) cannot enforce allow-net: no.
Upgrade to a Node whose permission model covers it, or pass --allow-unenforced
to run anyway, knowing that limit will not hold.
```

That is the whole reason the check exists. A sandbox that silently is not one is worse than no sandbox, so the banner never prints a limit the runtime is not applying.

## Contributing

New skills are welcome. `node scripts/validate-skills.mjs` enforces the rules: frontmatter `name` matching the directory, a `description` that says *when* to use the skill rather than only what it is, and every `references/` or `scripts/` path mentioned in the body actually existing.

That description rule matters more than it looks. It is the only text an agent sees when deciding whether to load a skill, so "use when reviewing a diff, a pull request, or a controller" pulls its weight and "a skill for Laravel security" does not.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
