# `apps/web` — dashboard

Next.js (App Router, client components). It is a pure API consumer: no database access, no server
actions that bypass the API.

## Routes

| route | purpose |
| --- | --- |
| `/` | overview: counts, recent jobs, quota/limit warnings, operator panel |
| `/create` | upload (chunked) or URL import, then submit a processing job |
| `/jobs`, `/jobs/[id]` | job list and the live stage timeline |
| `/clips` | clip browser, per-platform metadata editor, download |
| `/publishing` | publishing queue, attempts, retry |
| `/accounts` | connect YouTube / Instagram, verify, disconnect (operators) |
| `/settings` | workspace configuration (operators; read-only for members) |
| `/brand` | brand profiles, subtitle presets, assets (operators) |
| `/admin` | system health, workers, queues, diagnostics (operators) |
| `/activity` | audit log |
| `/login` | sign in |

## Layout

```
app/          one folder per route, each with page.tsx
components/   shared UI primitives (Card, Field, Badge, Skeleton, ErrorState…)
lib/          api client (CSRF-aware), react-query hooks, config schema
```

## Rules

* All data access goes through `lib/api.ts`, which attaches the session CSRF token automatically.
* Anything operator-only is gated with `useIsOperator()` so a member never sees a control that can
  only return 403.
* No hard-coded copy for state that the API knows — render what the API returns.
