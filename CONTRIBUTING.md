# Contributing

## Adding a skill

Create `skills/<name>/SKILL.md`. The directory name and the frontmatter `name` must match, and both must be lowercase kebab-case.

```markdown
---
name: your-skill-name
description: What it does. Use when <the situations that should trigger it>, and whenever the user asks about <the terms they would actually type>.
---

# Title

Body.
```

Keep the frontmatter to `name` and `description`. Extra keys are valid in Claude Code but not uniformly supported elsewhere, and the point of this repo is that one directory works everywhere.

Supporting files go in `references/` for documents the agent reads on demand, and `scripts/` for anything executable. Reference them from the body in backticks, and the validator will confirm they exist.

## Writing a description that works

This is the part people get wrong. The description is the only text an agent sees when deciding whether to load your skill. It is a trigger, not a summary.

Weak:

> A skill for reviewing Laravel security.

Strong:

> Review Laravel and PHP code for security defects before it ships. Use when reviewing a diff, a pull request, or a controller, model, route, migration, or Blade template, and whenever the user asks about Laravel security, mass assignment, SQL injection, IDOR, authorization gaps, or unsafe file uploads.

The second lists the artifacts a user would be looking at and the words they would actually type. The validator warns if a description contains no "use when" style clause.

## Writing the body

- Give a procedure, not principles. "Scope to the diff, grep these patterns, verify the input is attacker-controlled, then report" beats "be thorough".
- Show vulnerable code and fixed code side by side. Short and real.
- Say what to do with the output. A review skill that does not define its reporting format produces inconsistent reviews.
- Tell the agent when *not* to flag something. False positives are what makes people uninstall a security skill.
- No em dashes. The validator rejects them.

## Before opening a pull request

```bash
npm test
```

Runs the skill validator and the parity checker's test suite. Both must pass.

If you changed `check-parity.mjs`, add a case to `scripts/test-parity.mjs`. It builds real fixtures in a temp directory and asserts on the JSON output, so a new defect class is usually about ten lines.

Smoke test the installer against a scratch directory:

```bash
mkdir /tmp/scratch && cd /tmp/scratch
node /path/to/skillbelt/bin/skillbelt.mjs add --all --project --harness claude
```

## Adding a harness

Add an entry to `HARNESSES` in `bin/skillbelt.mjs` with its global and project paths, then add a row to the table in `README.md`. Set `global` to `null` if the harness only supports project-level skills.

Please link to documentation for the path in the pull request. Paths that turn out to be wrong make the installer silently do nothing, which is the worst possible failure for this tool.
