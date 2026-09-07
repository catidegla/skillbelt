# Grep patterns

Run from the project root. Each command produces candidates to read, not findings to report.

## Server Actions

Find every action file, then check each exported function for auth, authorization and validation:

```bash
rg -l "^\s*['\"]use server['\"]" --glob '!node_modules'
rg -n "^\s*export\s+async\s+function" $(rg -l "^\s*['\"]use server['\"]" --glob '!node_modules') -A 6
```

Actions that never mention a session:

```bash
for f in $(rg -l "['\"]use server['\"]" --glob '!node_modules'); do
  rg -q '(auth\(|getServerSession|currentUser|getUser)' "$f" || echo "no auth call: $f"
done
```

Actions with no schema validation:

```bash
for f in $(rg -l "['\"]use server['\"]" --glob '!node_modules'); do
  rg -q '(z\.|zod|valibot|yup|superstruct|safeParse)' "$f" || echo "no validation: $f"
done
```

## Route handlers

```bash
rg -n 'export async function (GET|POST|PUT|PATCH|DELETE)' --glob '**/route.ts' --glob '**/route.js' -A 8
```

Handlers with no authorization call:

```bash
for f in $(rg -l 'export async function (GET|POST|PUT|PATCH|DELETE)' --glob '**/route.*'); do
  rg -q '(auth\(|getServerSession|currentUser|can\(|authorize)' "$f" || echo "no auth call: $f"
done
```

Queries by id that are not scoped to the caller:

```bash
rg -n 'findUnique\(\s*\{\s*where:\s*\{\s*id' --glob '!node_modules' -A 2
```

## Middleware

```bash
cat middleware.ts 2>/dev/null || cat src/middleware.ts 2>/dev/null
rg -n 'matcher' middleware.* src/middleware.* 2>/dev/null
```

Compare the matcher against the actual route tree. Anything under `app/` that the matcher does not cover is unprotected by middleware.

```bash
find app -name 'route.*' -o -name 'page.*' | sort
```

Check the installed version against the middleware bypass advisory:

```bash
node -p "require('./package.json').dependencies.next"
npm audit --omit=dev
```

## Environment variables

```bash
rg -n 'NEXT_PUBLIC_' --glob '!node_modules' --glob '!.next'
rg -n 'process\.env\.[A-Z_]+' --glob '**/*.tsx' --glob '!node_modules'
```

Anything secret-looking behind `NEXT_PUBLIC_` is already public. After a build, confirm what shipped:

```bash
rg -o '(sk_live_|rk_live_|AKIA|ghp_|xox[baprs]-)[A-Za-z0-9_\-]+' .next/static -r '$0' 2>/dev/null
```

Server-only modules should be marked:

```bash
rg -n "import 'server-only'" --glob '!node_modules'
```

## Client boundary

```bash
rg -l "^\s*['\"]use client['\"]" --glob '!node_modules'
```

For each client component, check what its parent passes. Whole-record props are the leak:

```bash
rg -n '<[A-Z][A-Za-z]*\s+[a-z]+=\{(user|account|customer|profile|record|row)\}' --glob '!node_modules'
```

Selects that return every column:

```bash
rg -n '\.(findUnique|findFirst|findMany)\(' --glob '!node_modules' -A 3 | rg -v 'select:'
```

## XSS

```bash
rg -n 'dangerouslySetInnerHTML' --glob '!node_modules'
rg -n 'href=\{(?!["\x27]/)' --glob '!node_modules' --pcre2
rg -n '(marked|markdown-it|remark-html)' package.json
```

## SSRF and redirects

```bash
rg -n 'fetch\(\s*(req|request|searchParams|params|body|input)' --glob '!node_modules'
rg -n 'redirect\(\s*(searchParams|req|params|body)' --glob '!node_modules'
rg -n "\.get\(['\"](next|redirect|returnTo|callbackUrl|url)['\"]\)" --glob '!node_modules'
```

## Caching

```bash
rg -n "export const (dynamic|revalidate|fetchCache)" --glob '**/route.*' --glob '**/page.*'
rg -n 'unstable_cache\(' --glob '!node_modules' -A 4
rg -n 'revalidate(Path|Tag)\(' --glob '!node_modules'
```

A route handler returning user-specific data with no `dynamic = 'force-dynamic'` and no `cookies()` call is a candidate for serving one user's data to another.

## Rate limiting

```bash
rg -n '(ratelimit|rateLimit|@upstash/ratelimit|limiter)' --glob '!node_modules'
```

If auth and password reset routes produce no hits, there is no throttle.
