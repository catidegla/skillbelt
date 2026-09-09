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

## CLI

```
skillbelt list                    show available skills and detected harnesses
skillbelt add <name...|--all>     install
skillbelt remove <name...|--all>  uninstall
skillbelt doctor                  every install path and what is present

  --harness <a,b>   claude, codex, cursor, gemini, antigravity, or all
                    defaults to whatever is detected
  --project         install into the current project
```

## Contributing

New skills are welcome. `node scripts/validate-skills.mjs` enforces the rules: frontmatter `name` matching the directory, a `description` that says *when* to use the skill rather than only what it is, and every `references/` or `scripts/` path mentioned in the body actually existing.

That description rule matters more than it looks. It is the only text an agent sees when deciding whether to load a skill, so "use when reviewing a diff, a pull request, or a controller" pulls its weight and "a skill for Laravel security" does not.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
