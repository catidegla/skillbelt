---
name: nextjs-security-review
description: Review Next.js and TypeScript code for security defects before it ships. Use when reviewing a diff, pull request, App Router page, route handler, Server Action, or middleware, and whenever the user asks about Next.js security, the server and client boundary, leaked environment variables, or authorization in route handlers.
---

# Next.js security review

Most Next.js vulnerabilities come from one mistake: forgetting which side of the network boundary a piece of code runs on. The App Router makes that boundary invisible by design, which is excellent for productivity and unforgiving in review.

Start every review by asking, for each file in the diff, does this run on the server, on the client, or both.

## How to run a review

1. **Scope to the diff.** `git diff main...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx'`
2. **Classify each changed file.** Look for `'use client'` and `'use server'` at the top. A file with neither, imported by a client component, ships to the browser.
3. **Trace attacker-controlled input** to the sinks below.
4. **Report with a working request.** A `curl` that demonstrates the bug is worth more than a paragraph.

## The patterns that matter

### Server Actions are public endpoints

This is the most misunderstood part of the framework. Every exported function in a `'use server'` file is a callable HTTP endpoint. Being able to reach it does not require rendering the component that calls it, and the arguments are entirely attacker-controlled.

```ts
// Vulnerable: reachable by anyone who can guess the action id.
'use server'

export async function deleteProject(id: string) {
  await db.project.delete({ where: { id } })
}
```

```ts
// Fixed: authenticate, authorize, then validate. In that order.
'use server'

import { z } from 'zod'

const schema = z.object({ id: z.string().uuid() })

export async function deleteProject(input: unknown) {
  const session = await auth()
  if (!session?.user) throw new Error('Unauthorized')

  const { id } = schema.parse(input)

  const project = await db.project.findUnique({ where: { id } })
  if (project?.ownerId !== session.user.id) throw new Error('Forbidden')

  await db.project.delete({ where: { id } })
}
```

Every Server Action needs all three. Hidden form fields, disabled buttons and conditional rendering are not access control, they are suggestions.

Also check that `'use server'` files export only actions. An exported helper in that file becomes an endpoint too.

### Route handlers without authorization

```ts
// Vulnerable: authenticated, but not authorized.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session) return new Response('Unauthorized', { status: 401 })

  return Response.json(await db.invoice.findUnique({ where: { id: params.id } }))
}
```

The session check proves who the caller is and says nothing about whether this invoice is theirs. Scope the query:

```ts
const invoice = await db.invoice.findFirst({
  where: { id: params.id, userId: session.user.id },
})
if (!invoice) return new Response('Not found', { status: 404 })
```

Returning 404 rather than 403 also avoids confirming that the record exists.

### Middleware is not an authorization layer

Middleware runs before the route and is the wrong place to enforce access control on its own.

- The `matcher` config silently skips paths. A new route outside the matcher is unprotected and nothing warns you.
- CVE-2025-29927 allowed a crafted `x-middleware-subrequest` header to bypass middleware entirely. Anything below a version carrying that fix is exposed, and the deeper lesson stands regardless of version.

Use middleware for redirects and coarse gating. Enforce authorization in the route handler, the Server Action, or the data layer, where it cannot be skipped.

### Environment variables leaking to the client

```ts
// Vulnerable: NEXT_PUBLIC_ is inlined into the browser bundle at build time.
const STRIPE_SECRET = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY
```

Anything prefixed `NEXT_PUBLIC_` is public. Permanently, in the built assets, for every visitor.

Subtler version: a server-only module that reads `process.env.DATABASE_URL` and gets imported by a client component. The value resolves to `undefined` in the browser, which usually surfaces as a confusing runtime error, but any constant derived from it at module scope may be inlined. Mark server-only modules with the `server-only` package so the import fails at build time instead.

```bash
# Check what actually shipped.
rg -n 'NEXT_PUBLIC_' --glob '!node_modules'
grep -ro 'sk_live_[A-Za-z0-9]*' .next/static 2>/dev/null
```

### Server components leaking data into props

A server component can fetch a full user record and pass it to a client component. Everything in those props is serialized into the HTML payload and readable in view source, including the fields you did not render.

```tsx
// Vulnerable: passwordHash, stripeCustomerId and email all reach the browser.
const user = await db.user.findUnique({ where: { id } })
return <Profile user={user} />

// Fixed: select explicitly.
const user = await db.user.findUnique({
  where: { id },
  select: { id: true, displayName: true, avatarUrl: true },
})
```

Prisma and Drizzle both return every column by default. This is the quietest data leak in the framework and it is common.

### XSS

```tsx
<div dangerouslySetInnerHTML={{ __html: post.body }} />
```

Sanitize server side with a real HTML sanitizer before it reaches the component. Also check:

- `href={userValue}`, which accepts `javascript:` URLs. Validate the protocol.
- Markdown renderers configured to allow raw HTML.
- `next/script` with an interpolated `src`.

### SSRF

```ts
// Vulnerable: fetches whatever the caller asks for, from inside your network.
const res = await fetch(searchParams.get('url')!)
```

Server components, route handlers and Server Actions all run somewhere with access to cloud metadata endpoints and internal services. Allowlist the host, resolve the DNS name and reject private address ranges, and do not follow redirects blindly.

### Open redirect

```ts
redirect(searchParams.get('next') ?? '/')
```

Accept only same-origin relative paths:

```ts
const next = searchParams.get('next') ?? '/'
redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/')
```

The `//` check matters. `//evil.com` is protocol-relative and leaves your origin.

### Caching and revalidation

- A route handler returning per-user data that is statically cached serves one user's response to everyone. Set `export const dynamic = 'force-dynamic'` or use `cookies()` so the route opts out.
- `revalidatePath` and `revalidateTag` called from an unauthenticated action let anyone force cache churn.
- `unstable_cache` keyed without the user id mixes tenants.

### Uploads and rate limiting

- Presigned upload URLs generated without checking who is asking, or without constraining content type and size.
- No rate limiting on auth, password reset, or any route that sends mail. Route handlers have no built-in throttle, so if you cannot find one, it does not exist.

## Reference

`references/patterns.md` has the grep commands for each of the above.

## Reporting

For each finding give the file and line, the request that triggers it, what the attacker gets, and the fix. Separate live defects from hardening suggestions, and lead with anything that crosses a tenant or privilege boundary.
