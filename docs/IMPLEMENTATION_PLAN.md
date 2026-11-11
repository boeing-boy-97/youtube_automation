# Implementation plan

Derived from `ARCHITECTURE_REPORT.md`, `FRONTEND_AUDIT.md`, `BACKEND_AUDIT.md`, `SECURITY_AUDIT.md`
and `API_CONNECTION_AUDIT.md`. Ordered so that each phase leaves the application in a working,
testable state, and so that security holes close before anything is restyled.

**Rules that govern every phase** (restating your constraints as enforceable gates):

1. A page, button or badge ships only if a real endpoint and real data back it. No placeholders.
2. Every server-side rule is enforced on the server; the UI may only *explain* it.
3. Every phase ends with: `typecheck` + `lint` + `unit` + `integration` + the affected E2E suites,
   run on the live stack, with results recorded in the docs.
4. A finding is only closed when the test that would catch a regression exists.
5. Nothing that works today is deleted without a replacement connected first.

---

## Phase 3 — Critical security and correctness (small, surgical, first)

| Work | Closes | Files | Proof |
|---|---|---|---|
| `helmet` on the API with a JSON-only CSP (`default-src 'none'; frame-ancestors 'none'`), HSTS in production, `Referrer-Policy`, nosniff | S1 | `apps/api/src/main.ts` | `curl -D -` shows the headers; a new assertion in `scenarios.py` |
| Security headers **and a real CSP** for the web app from `next.config.ts` (not only on Vercel): `script-src 'self'`, `style-src 'self' 'unsafe-inline'` (Tailwind runtime), `img-src 'self' data:`, `connect-src 'self'`, `frame-ancestors 'none'` | S1 | `apps/web/next.config.ts` | headers on `next start`; Playwright loads every page with the CSP active and no console violations |
| One password policy: export `passwordSchema` from `packages/validation`, use it in reset, recovery redemption, register, bootstrap | S3, F3 | `packages/validation/src/index.ts`, `apps/api/src/auth/security.controller.ts`, `apps/web/lib/auth-messages.ts` (message text only) | unit test on the schema + an E2E that a 10-char reset is refused |
| Default rate limit per session when no `@RateLimit()` is present (120/min, burst 30), decorator limits keep overriding | S2, S6 | `common/guards/rate-limit.guard.ts` | E2E: the 121st request in a minute returns 429 on a previously unlimited route |
| Gate OpenAPI to non-production (or admin session) | S4 | `main.ts` | anonymous `GET /api/docs/openapi.json` → 404 in production mode |
| Remove `eslint.ignoreDuringBuilds` | S5 | `apps/web/next.config.ts` | `next build` fails on a deliberately bad lint input, then passes clean |
| Fix `worker:ai` script name; keep `run-workers.sh` as the only supervisor | A6 | `apps/api/package.json` | the script starts the real pipeline worker |
| Configurable `TRUST_PROXY` (default 1) | S8 | `main.ts`, `env.ts` | unit |

## Phase 4 — Repair connections (make existing features reachable)

| Work | Closes | Notes |
|---|---|---|
| Enable/disable automatic publishing per account, wired to `/api/publishing/{enable,disable}` on `/accounts` and `/publishing` | F1, B6 | shows the account's `publishingConfig` state; the credential-existence check happens server-side |
| Forgot-password, reset-password and recovery-code flows on `/login` | F5 | three small steps: identify → code → new password; recovery-code entry as an alternative |
| Pagination + search on `/clips` and `/jobs` using the parameters the API already accepts | F4 | cursor-free `page/pageSize`, debounce 300 ms, keep URL state |
| Brand profile read-back in the editor (`GET /api/brand-profiles/:id`) | API_CONNECTION §2 | |
| Consolidate the four duplicate `/api/system/*` read models into `/api/system/overview`; delete the unused ones | B2, A5 | keeps the admin page working from one call |
| Surface usage/cost in the admin page (`/api/usage/summary`, `/daily`) | B3, A5 | this is real measured data, not a new system |
| Dashboard completeness: connected accounts + health, upcoming scheduled publishes, latest notification deliveries, worker/queue strip | B5, A9 | extends `system.service.ts:225` with real aggregates |
| Deterministic typing for the web from `@clipforge/shared-types` (import types instead of re-declaring; config field list derived from `CONFIG_KEYS`) | F2 | unit test asserting the form and the API agree, which is the anti-drift gate |

## Phase 5 — Premium UI transformation (no behaviour change)

The existing design language is already light-first and coherent; this is an upgrade, not a rewrite.

1. **Design system first** (`components/ui.tsx` + `globals.css` + `tailwind.config.ts`):
   add `Table`, `Tabs`, `Dialog`, `Pagination`, `Tooltip`, `Sparkline`, `StatDelta`, `Timeline`;
   tighten type scale, spacing rhythm and motion (120–180 ms, `prefers-reduced-motion` respected).
2. **Shell**: regrouped sidebar with only real destinations —
   Overview · Create · Processing · Clip library · Publishing · Accounts · Brand · Security ·
   Settings · Activity · (Admin: System) — with section labels, an active indicator, a workspace
   switcher slot and a compact mobile drawer. **No entries are added for Analytics, Workflows,
   AI Studio, Calendar, Notifications, User Management or Database Health until their backends exist**
   (see Phase 7 for the ones I will build).
3. **Dashboard**: three-tier hierarchy — headline KPIs, live pipeline panel (real `progressPercent`,
   "updates every 10 s"), then health/activity. Connected-account strip and upcoming-publish list from
   Phase 4 data.
4. **Every list page** gets the same anatomy: header with actions → filter bar → table with sticky head
   → pager → empty/error/loading states. No decorative controls.
5. **Accessibility**: focus-visible rings, `aria-live` on async panels, labelled inputs, `role="status"`
   on progress, contrast checked at the new tones.

## Phase 6 — Real-time, performance, and honesty labels

| Work | Why |
|---|---|
| Label every polling panel with its interval ("updates every 10 s") | F7 — a stale number must not read as live |
| Optimistic metadata PATCH + single-row cache update instead of a full refetch | API_CONNECTION §4 |
| Fold dashboard + system into one call for operators | removes 50 % of dashboard traffic |
| `loading="lazy"` + poster frames for clip previews; `prefetch` on nav hover | bundle/media weight |
| Verify no server-only package reaches the client bundle (budget assertion in CI) | keeps F-audit clean |
| Bundle review: `firebase` already dynamic-imported; confirm the login page stays small | measured in the build output |

## Phase 7 — Only the missing modules that pay for themselves

Sequence chosen by "does the backend already know the answer?":

1. **Analytics from real platform data** — new models `MetricSnapshot`, `AccountMetric`, a scheduler
   job that pulls YouTube Data API + Instagram Graph for published posts, an `/api/analytics/*` surface,
   CSV export (server-generated). Unavailable metrics are returned as `null` with a reason — never
   zero-filled. PDF export only if a server-side renderer is justified; otherwise CSV + a print
   stylesheet, which is honest and dependency-free.
2. **Publishing calendar** — a range query over `PublishingJob.scheduledFor` + conflict detection,
   month/week views, drag-to-reschedule behind a real `PATCH`.
3. **AI Studio authoring** — per-asset generation endpoints (titles, description, hashtags, hooks,
   ideas, script) through the existing AI engine, with provenance (`generatedBy`, `model`, `prompt
   version`) and an edit history. Thumbnails only when the AI engine can actually produce one.
4. **User management** — invites, role changes, removal, with server-side checks (OWNER only for role
   escalation) and audit rows. This also removes the "single-user workspace" limitation that forced a
   SQL fixture in the tests.
5. **Workflow builder** — last, because every node must map to a real backend action. No node ships
   without an implementation and a test.

Anything in this list that does not get built stays out of the navigation and stays listed as NOT
IMPLEMENTED in the final report.

## Phase 8 — Testing and verification

| Layer | Suites to run/extend |
|---|---|
| Unit | `vitest` — add: shared-schema/UI agreement, password policy, rate-limit default, header config |
| Integration | `vitest.integration` — add: analytics aggregation, publishing enable/disable transitions |
| E2E (live) | `scenarios.py`, `authorization_matrix.py`, `auth_security.py`, `telegram_notifications.py`, `full_workflow.py`, plus new: `publishing_toggle.py`, `password_recovery_ui.py`, `pagination_search.py`, `headers_csp.py` |
| UI | `ui_responsive.py` across the existing viewports for every page, now also asserting CSP violations = 0 and no dead buttons (click every action control and assert a network call or a navigation) |
| Security | anonymous 401 matrix, MEMBER 403 matrix, cross-tenant 404 matrix, rate-limit 429, bundle secret scan |

`full_workflow.py` needs `GEMINI_API_KEY` to reach `COMPLETED`; without it the suite records the honest
stop at `AI_ANALYSIS`. That will be reported as an environment limitation, not a pass.

## Phase 9 — Deployment and docs

* `render.yaml` free path: add a prominent readiness banner keyed off worker heartbeats so a
  no-worker deployment says *"queues are not being consumed on this plan"* instead of a silent stall (B10).
* Keep `render.pipeline.yaml` as the full path (api + workers + video-processor + ai-engine).
* `.env.example`, `render*.yaml`, `docs/` updated for every variable added (headers, `TRUST_PROXY`,
  analytics providers).
* Open questions I need from you before the final phase: the real Render `clipforge-api` host,
  whether a Gemini key will be provided, and whether Google/Meta OAuth apps exist (those three gate
  which features can be marked VERIFIED).

## Delivery classification for the final report

| Class | Meaning |
|---|---|
| IMPLEMENTED AND VERIFIED | code + UI + automated test on the live stack, passing |
| IMPLEMENTED BUT NOT FULLY VERIFIED | code + UI + wiring proven; needs third-party credentials or a human to complete |
| PARTIALLY IMPLEMENTED | some of the feature is real and tested; the rest is named |
| NOT IMPLEMENTED | no code; absent from the UI |

## Immediate next step (phase 3)

`helmet` + CSP both sides → single password policy → default rate limit → OpenAPI gate → lint gate →
`worker:ai` fix → re-run the five suites. Nothing cosmetic happens until those are green.
