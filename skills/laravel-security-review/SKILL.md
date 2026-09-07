---
name: laravel-security-review
description: Review Laravel and PHP code for security defects before it ships. Use when reviewing a diff, a pull request, or a controller, model, route, migration, or Blade template, and whenever the user asks about Laravel security, mass assignment, SQL injection, IDOR, authorization gaps, or unsafe file uploads.
---

# Laravel security review

Find the defects that actually reach production in Laravel apps. Framework defaults handle a lot, so the real bugs cluster where a developer stepped outside them: a raw query, a manual `find()` without an authorization check, a `{!! !!}` in a Blade template.

## How to run a review

1. **Scope it.** Prefer the diff over the whole app. `git diff main...HEAD -- '*.php' '*.blade.php'`. Reviewing everything produces noise and misses the change that introduced the bug.
2. **Grep for the high-signal patterns below.** Each one is a place the framework stops protecting you.
3. **Verify before reporting.** Read enough surrounding code to confirm the input is attacker-controlled and reaches the sink. A `whereRaw` with a hardcoded string is not an injection.
4. **Report with a concrete failure path.** "User A sends `?user_id=2` and reads User B's invoice" beats "possible IDOR".

Rank findings by exploitability, not by category. One confirmed authorization gap matters more than ten hardened-header suggestions.

## The patterns that matter

### Authorization gaps

The single most common real vulnerability in Laravel apps. Authentication is usually correct because middleware handles it. Authorization is per-action and gets forgotten.

```php
// Vulnerable: any authenticated user can read any invoice.
public function show($id)
{
    return view('invoices.show', ['invoice' => Invoice::findOrFail($id)]);
}

// Fixed: the policy runs before the record is returned.
public function show(Invoice $invoice)
{
    $this->authorize('view', $invoice);

    return view('invoices.show', ['invoice' => $invoice]);
}
```

Check for:
- Controller actions that load a model by id from the request without a matching `authorize`, `can`, or policy call.
- Route model binding that is scoped globally rather than to the current user. `Route::get('/invoices/{invoice}')` binds any invoice, not just the caller's.
- `Gate::allows` results that are computed and then ignored.
- Policies registered but never invoked, which looks safe in review and is not.

Nested resources deserve extra attention. `/projects/{project}/tasks/{task}` must verify that `$task` actually belongs to `$project`, or an attacker swaps one id and walks the whole table. Use `->scopeBindings()` or check the relationship explicitly.

### Mass assignment

```php
// Vulnerable: $guarded = [] plus a request body containing is_admin=1.
class User extends Model
{
    protected $guarded = [];
}

$user->update($request->all());
```

`$guarded = []` disables protection entirely. It is common in seeders and then copied into real models. Prefer an explicit `$fillable`, and pass `$request->validated()` rather than `$request->all()`, so the form request defines the allowed keys in one place.

Watch for `forceFill`, which bypasses both `$fillable` and `$guarded`.

### SQL injection

Eloquent and the query builder parameterize automatically. Injection appears where a developer opts out:

```php
// Vulnerable: interpolated into raw SQL.
DB::select("SELECT * FROM users WHERE email = '{$request->email}'");
User::whereRaw("name LIKE '%{$request->q}%'")->get();

// Fixed: bindings.
DB::select('SELECT * FROM users WHERE email = ?', [$request->email]);
User::whereRaw('name LIKE ?', ["%{$request->q}%"])->get();
```

Grep targets: `DB::raw`, `whereRaw`, `havingRaw`, `orderByRaw`, `selectRaw`, `DB::statement`, `DB::unprepared`.

`orderByRaw` deserves its own pass. Column names and sort directions cannot be bound as parameters, so developers interpolate them. Validate against an allowlist:

```php
$sortable = ['created_at', 'total', 'name'];
abort_unless(in_array($request->sort, $sortable, true), 400);
$direction = $request->direction === 'desc' ? 'desc' : 'asc';

Order::orderBy($request->sort, $direction)->get();
```

### Blade and XSS

`{{ }}` escapes. `{!! !!}` does not.

```blade
{{-- Vulnerable when $post->body contains user input --}}
<div>{!! $post->body !!}</div>
```

Every `{!! !!}` needs a reason. If it renders user-supplied HTML, it needs sanitizing first with a real HTML sanitizer, not a regex. Also check `@json` and `Js::from` when injecting data into inline scripts, and any attribute built by string concatenation, since escaping rules inside a `<script>` block or an `href` differ from body text.

### Command injection

```php
// Vulnerable
exec("convert {$request->file} output.png");

// Fixed: no shell, arguments passed as an array.
use Symfony\Component\Process\Process;

$process = new Process(['convert', $path, 'output.png']);
$process->run();
```

Grep targets: `exec`, `shell_exec`, `system`, `passthru`, `proc_open`, `popen`, and backticks. `escapeshellarg` is a fallback, not a fix, and it is easy to misuse when the value lands inside a quoted string.

### File uploads

```php
// Vulnerable: trusts the client-supplied MIME type and original name.
$request->file('avatar')->storeAs('public', $request->file('avatar')->getClientOriginalName());

// Fixed: validate real content, let the framework generate the name.
$request->validate([
    'avatar' => ['required', 'file', 'mimes:jpg,png,webp', 'max:2048'],
]);

$path = $request->file('avatar')->store('avatars', 'public');
```

`mimes` checks actual file content. `mimetypes` trusts the request header. Never reuse `getClientOriginalName`, which carries traversal sequences and double extensions. Store uploads outside the web root, or in a disk that does not execute PHP.

### Unsafe deserialization

`unserialize()` on request data is remote code execution when a gadget chain exists in the dependency tree, and Laravel apps have large dependency trees. Use `json_decode`. If you must unserialize, pass `['allowed_classes' => false]`.

Also check `Crypt::decrypt` on attacker-supplied strings and any signed-URL handling that skips signature verification.

### Secrets and configuration

- `APP_DEBUG=true` in production leaks environment variables, database credentials and full stack traces through the Ignition error page. Confirm `APP_ENV` and `APP_DEBUG` for the deployed environment, not just `.env.example`.
- API keys, tokens and passwords committed in config files or migrations. `config/services.php` should read `env()`, and `env()` should only ever be called inside `config/`, because `config:cache` makes `env()` return null everywhere else.
- `.env` reachable over HTTP because the document root points at the project root instead of `public/`.

### Authentication details

- `Hash::check` for passwords, never `==` or `===`. For non-password token comparison use `hash_equals`.
- Password reset and email verification links that do not expire or are not single use.
- Rate limiting on login, password reset and any endpoint that sends mail or SMS. `throttle` middleware or a `RateLimiter` definition.
- Session fixation: Laravel regenerates on login through the starter kits, but hand-rolled login flows often skip `$request->session()->regenerate()`.

### CSRF

`VerifyCsrfToken` covers session-authenticated routes. Look for:
- Routes added to the `$except` array, which is occasionally correct for webhooks and usually not.
- Webhook endpoints that skip CSRF and then also skip signature verification, which is the actual bug.
- State-changing actions served over `GET`.

### Mail and SSRF

- User-controlled URLs passed to `Http::get` without an allowlist reach internal metadata endpoints and localhost services.
- Redirects built from `$request->input('next')`. Validate against known paths or use `URL::signedRoute`.

## Reference

`references/patterns.md` holds the grep commands for each pattern above, ready to run against a working tree.

## Reporting

For each finding give:

- **File and line.**
- **What an attacker sends** and what they get back.
- **The fix**, as a diff where it is short enough.
- **Severity**, judged by what the attacker actually gains.

State clearly when something is a hardening suggestion rather than a live defect. Mixing the two trains people to ignore the whole report.
