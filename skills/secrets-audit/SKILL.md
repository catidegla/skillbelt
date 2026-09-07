---
name: secrets-audit
description: Find committed credentials, API keys, and tokens in a repository, including in git history, and handle them correctly once found. Use before making a repository public, when preparing a release, when onboarding an unfamiliar codebase, or whenever the user asks about leaked secrets, hardcoded credentials, or scrubbing git history.
---

# Secrets audit

Two jobs that get confused with each other. Finding a secret in the working tree is easy. Getting it out of git history, and understanding that finding it means it is already burned, is the part people get wrong.

**A committed secret is a compromised secret.** Rotation comes first. History rewriting is cleanup, not remediation. If the repository was ever public, ever cloned, or ever pushed to a service that indexes code, assume the value is known.

## Scan the working tree

High-confidence patterns, low false-positive rate:

```bash
rg -n --glob '!node_modules' --glob '!vendor' --glob '!*.lock' \
  -e 'AKIA[0-9A-Z]{16}' \
  -e 'ASIA[0-9A-Z]{16}' \
  -e 'gh[pousr]_[A-Za-z0-9]{36,}' \
  -e 'github_pat_[A-Za-z0-9_]{22,}' \
  -e 'sk_live_[A-Za-z0-9]{20,}' \
  -e 'rk_live_[A-Za-z0-9]{20,}' \
  -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
  -e 'sk-ant-[A-Za-z0-9_-]{20,}' \
  -e 'sk-proj-[A-Za-z0-9_-]{20,}' \
  -e 'AIza[0-9A-Za-z_-]{35}' \
  -e 'SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}' \
  -e '-----BEGIN [A-Z ]*PRIVATE KEY-----'
```

Connection strings, which carry credentials inline and are missed by keyword scans:

```bash
rg -n --glob '!node_modules' --glob '!vendor' \
  -e '(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp)://[^:@\s/]+:[^@\s]+@'
```

Assignment-shaped matches. Noisier, so read every hit:

```bash
rg -n -i --glob '!node_modules' --glob '!vendor' --glob '!*.lock' \
  '\b(api[_-]?key|secret|passwd|password|token|credential|private[_-]?key)\b\s*[:=]\s*["'"'"'][^"'"'"'\$\{]{12,}["'"'"']'
```

The `[^"\$\{]` part excludes `env('KEY')`, `${VAR}` and `process.env.X`, which is most of the noise.

Files that should not be tracked at all:

```bash
git ls-files | rg -i '(\.env($|\.)|\.pem$|\.p12$|\.pfx$|\.keystore$|id_rsa|\.ppk$|credentials(\.json)?$|service-account.*\.json$)'
```

## Scan git history

The working tree being clean means nothing. Check every blob that ever existed:

```bash
# Every version of a path that looks sensitive.
git log --all --full-history --oneline -- '*.env' '*.pem' '*credentials*' '*secret*'

# Search the content of all commits.
git rev-list --all | while read -r commit; do
  git grep -I -n -e 'AKIA[0-9A-Z]\{16\}' -e 'sk_live_' -e 'gh[pousr]_' "$commit" 2>/dev/null
done | head -50
```

That loop is slow on large repositories. `gitleaks detect --no-git=false` and `trufflehog git file://.` do the same job faster and verify some key types against the provider, which removes false positives. Use them when available.

## Triage each hit

For every candidate, answer three questions before acting:

1. **Is it real, or a placeholder?** `sk_test_`, `example`, `changeme`, `xxx`, and obvious dummy values in fixtures are not incidents. Test keys for payment providers are usually safe by design, but confirm the prefix rather than assuming.
2. **Is it live?** A rotated key in history is already handled. Check the provider dashboard for last-used timestamps.
3. **What does it reach?** A read-only analytics key and a production database password need different responses.

## Remediation, in order

**1. Rotate.** Always first, always before touching history. Revoke the old credential at the provider. If the secret is a database password, rotate it and check for connections still using the old one.

**2. Check for use.** Provider audit logs will show whether the key was used from an address you do not recognize. AWS CloudTrail, GitHub audit log, Stripe events.

**3. Remove from the working tree.** Move the value to environment configuration, add the file to `.gitignore`, commit.

**4. Rewrite history, if it is worth it.** For a private repository with a rotated key, this is often optional and disruptive. For a repository about to go public, do it.

```bash
# git-filter-repo is the maintained tool. filter-branch is deprecated.
pip install git-filter-repo

git filter-repo --path .env --invert-paths
# or replace the literal value everywhere it appears
echo 'literal:AKIAIOSFODNN7EXAMPLE==>REMOVED' > replacements.txt
git filter-repo --replace-text replacements.txt

git push --force --all
git push --force --tags
```

Rewriting changes every commit hash after the touched commit. Every collaborator must re-clone, and open pull requests will need rebasing. Say so before doing it.

**5. Ask the host to purge caches.** GitHub keeps unreferenced objects reachable through the API for a while, and forks keep their own copies. Contact support to have cached views of the old commits removed. Forks are not rewritten by your force push, so check whether any exist.

## Prevent recurrence

- `.gitignore` covering `.env`, `.env.*`, `*.pem`, `*.p12`, `credentials.json`, and any local override file the framework uses. Keep `.env.example` tracked with empty values.
- Enable the host's secret scanning and push protection. On GitHub this is free for public repositories and blocks the push rather than reporting after the fact.
- A pre-commit hook running `gitleaks protect --staged`.
- Move real values into a secret manager rather than developer machines.

## Reporting

For each confirmed secret give: the file and line or the commit hash, the type of credential, what it grants access to, whether it appears in history, and whether it has been rotated yet. Lead with anything still live.

State plainly when the working tree is clean but history is not. That distinction decides whether the repository can safely be made public.
