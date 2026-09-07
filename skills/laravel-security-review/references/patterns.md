# Grep patterns

Run from the project root. These are starting points that produce candidates, not findings. Every hit needs reading before it gets reported.

`rg` is assumed. Substitute `grep -rn` if ripgrep is unavailable.

## Raw SQL

```bash
rg -n --type php '\b(DB::raw|whereRaw|havingRaw|orderByRaw|selectRaw|DB::statement|DB::unprepared)\b'
```

Narrow to the dangerous subset, calls containing string interpolation:

```bash
rg -n --type php '(whereRaw|orderByRaw|selectRaw|havingRaw)\s*\(\s*["'"'"'][^"'"'"']*\$'
```

## Mass assignment

```bash
rg -n --type php 'protected \$guarded\s*=\s*\[\s*\]'
rg -n --type php '->(update|fill|create)\(\s*\$request->all\(\)'
rg -n --type php '\bforceFill\b'
```

## Blade output

```bash
rg -n --glob '*.blade.php' '\{!!'
rg -n --glob '*.blade.php' '(href|src|action)\s*=\s*"\{\{'
```

## Command execution

```bash
rg -n --type php '\b(exec|shell_exec|system|passthru|proc_open|popen)\s*\('
rg -n --type php '`[^`]*\$'
```

## Deserialization

```bash
rg -n --type php '\bunserialize\s*\('
rg -n --type php '\b(Crypt|decrypt)\b.*request'
```

## Authorization

Controllers that load a model but never authorize. Review each hit by hand:

```bash
rg -n --type php --glob '**/Http/Controllers/**' '::(find|findOrFail|where)\(' -A 4
```

Find controllers with no authorization call at all:

```bash
for f in $(rg -l --type php --glob '**/Http/Controllers/**' '' ); do
  rg -q '(authorize|Gate::|can\(|policy\()' "$f" || echo "no authorization call: $f"
done
```

Nested route bindings that may not be scoped:

```bash
rg -n --glob 'routes/*.php' '\{[a-z_]+\}/[a-z]+/\{[a-z_]+\}'
rg -n --glob 'routes/*.php' 'scopeBindings'
```

## CSRF

```bash
rg -n --type php -A 10 'class VerifyCsrfToken'
rg -n --type php 'withoutMiddleware.*Csrf'
```

## File uploads

```bash
rg -n --type php 'getClientOriginalName|getClientMimeType|getClientOriginalExtension'
rg -n --type php "'mimetypes:"
rg -n --type php '->storeAs\('
```

`mimetypes:` trusts the client header. `mimes:` inspects content. The first is almost always the wrong choice.

## Secrets and configuration

```bash
rg -n 'APP_DEBUG\s*=\s*true' --glob '.env*'
rg -n --type php '\benv\(' --glob '!config/**'
rg -n -i '(api[_-]?key|secret|password|token)\s*=>\s*["'"'"'][A-Za-z0-9_\-]{16,}'
```

The second command matters more than it looks. Once `php artisan config:cache` runs, `env()` outside `config/` returns null, so these are both a security and a correctness bug.

## SSRF and open redirect

```bash
rg -n --type php 'Http::(get|post|put|patch|delete)\(\s*\$'
rg -n --type php 'redirect\(\s*\$request->'
rg -n --type php 'Redirect::to\(\s*\$'
```

## Timing-unsafe comparison

```bash
rg -n --type php '(\$token|\$signature|\$hash|\$secret)\s*(===|==|!=|!==)\s*\$'
```

Token comparison should use `hash_equals`. Password comparison should use `Hash::check`.

## Rate limiting

Check that authentication routes carry a throttle:

```bash
rg -n --glob 'routes/*.php' -B 2 -A 2 '(login|register|password|forgot|reset)'
rg -n --type php 'RateLimiter::for'
```

## Dependencies

```bash
composer audit
```

Worth running, but treat the output as a separate concern from the code review. A transitive advisory with no reachable call path is not the finding to lead with.
