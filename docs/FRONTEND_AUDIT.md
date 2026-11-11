# Frontend audit

Applies to `apps/web` (Next.js 15 App Router, React 19, TanStack Query 5, Tailwind 3). Evidence is
`file:line` from the current tree.

## 1. Inventory

15 route files, 8 components, 5 client libs, 39 data hooks, 0 dead components, 0 dead hooks.

| Item | Count | Verified how |
|---|---|---|
| Pages | 13 + `/healthz` server route + root layout | `find apps/web/app -name page.tsx` |
| Components | 8 | each referenced at least once (`grep -rl`) |
| Hooks | 39 exported | every hook used in ≥1 page/component |
| Direct `fetch()` outside the wrapper | 1 | `app/healthz/route.ts:38` (server route, legitimate) |
| `process.env` reads | 5 | all server-side (`healthz/route.ts`, `next.config.ts`) |
| `localStorage`/`sessionStorage`/`document.cookie` | 0 | only mentioned in copy/comments |
| Hardcoded credentials, mock data, fake progress | 0 | `grep -niE "mock|dummy|fake|placeholder|todo|fixme"` → no hits in `app|components|lib` |

## 2. Per-page state coverage

Legend: **L** loading, **E** error, **∅** empty, **OK** success, **P** permission-aware.

| Page | L | E | ∅ | OK | P | Data | Gaps found |
|---|---|---|---|---|---|---|---|
| `/` dashboard | ✓ | ✓ | ✓ | ✓ | ✓ (system card hidden for MEMBER) | `/api/dashboard/summary`, `/api/system/overview` | no connected-accounts, no upcoming schedules, no latest notifications, no worker/API status strip |
| `/login` | ✓ | ✓ | n/a | ✓ | n/a | auth endpoints | — (two-step screen added in phase 2) |
| `/create` | ✓ | ✓ | n/a | ✓ | n/a | upload + jobs | no client-side file-size pre-check against `processing.max_file_size_bytes`; no resume of an interrupted upload |
| `/jobs` | ✓ | ✓ | ✓ | ✓ | n/a | `/api/jobs` | no pagination control (fixed `pageSize=50`), no status filter, no search |
| `/jobs/[id]` | ✓ | ✓ | ✓ | ✓ | n/a | `/api/jobs/:id` | events embedded in the detail payload, so no independent refresh of a long job |
| `/clips` | ✓ | ✓ | ✓ | ✓ | n/a | `/api/clips` | duration filter only; **no pagination, no search** even though the API supports `page/pageSize/platform/status/jobId` |
| `/publishing` | ✓ | ✓ | ✓ | ✓ | ✓ | publishing jobs/history | **cannot enable/disable automation** (API exists, UI missing) |
| `/accounts` | ✓ | ✓ | ✓ | ✓ | ✓ | accounts | no quota/expiry surfacing beyond status badge |
| `/brand` | ✓ | ✓ | ✓ | ✓ | ✓ | config, brand, presets | brand profile list not read back (`GET /api/brand-profiles/:id` unused) |
| `/security` | ✓ | ✓ | ✓ | ✓ | ✓ | security endpoints | recovery-code redemption and forgot/reset password have API + copy but no UI entry (login page links nothing) |
| `/settings` | ✓ | ✓ | ✓ | ✓ | ✓ (read-only for MEMBER) | configuration | 5 workspace keys in `shared-types` missing from the form |
| `/activity` | ✓ | ✓ | ✓ | ✓ | n/a | `/api/activity` | no filters/pagination |
| `/admin` | ✓ | ✓ | ∅ | ✓ | ✓ | system overview, diagnostics, notifications | worker/queue/events rendered from one aggregate call; usage/cost endpoints unused |
| `/healthz` | n/a | ✓ | n/a | ✓ | n/a | API health | — |

## 3. Findings

### F1 — Automatic publishing has no UI (HIGH)
`POST /api/publishing/enable` and `/disable` exist (`apps/api/src/publishing/publishing.controller.ts:14,23`)
and the create-publishing-job path refuses with *"Connect the account and enable publishing first"*
(`publishing.service.ts:157`). `grep -r "publishing/enable" apps/web` returns nothing, so a user cannot
reach the state the API requires. **Status: broken connection, to be repaired.**

### F2 — Domain types duplicated instead of shared (MEDIUM)
The web app imports **no** `@clipforge/*` package (verified: `grep "from '@clipforge" apps/web` → 0).
Consequences measured by diffing key sets:

* in `packages/shared-types` but missing from the settings form: `notifications.enabled`,
  `notifications.telegram_chat_id`, `notifications.categories`, `notifications.daily_summary_hour`
* in the form but unknown to `shared-types`: `workspace.timezone`, `storage.provider`,
  `retention.source_days`, `retention.asset_days`, `audio.loudness_target_lufs`

`apps/web/lib/config-schema.ts` is the source of truth for the UI; nothing forces it to agree with the
API. Fix: derive the form from `shared-types` (or at minimum validate it in a unit test).

### F3 — Credential format rules live in the client and disagree with the server (MEDIUM)
`apps/web/lib/auth-messages.ts:46` requires 12 chars + upper + lower + digit for register/bootstrap.
The server agrees at registration (`packages/validation/src/index.ts:7`) but the *reset* endpoint
accepts 10 characters with no complexity (`apps/api/src/auth/security.controller.ts:24`). The UI copy
therefore promises a rule the account can later escape. Fix belongs on the server (single schema),
with the client importing the same schema.

### F4 — Lists cannot be paged or searched in the UI although the API supports it (MEDIUM)
`/api/clips` accepts `page`, `pageSize`, `platform`, `status`, `jobId`
(`packages/validation/src/index.ts:131`); `/api/jobs` accepts `page/pageSize`. The clips page passes
only `durationKind`, the jobs page hardcodes `pageSize=50`. Requirement "working filters, working
pagination, working search" is unmet on those two pages.

### F5 — No recovery-path UI on the login screen (MEDIUM)
`forgot-password`, `reset-password`, `recovery-codes/redeem` exist and are tested end-to-end
(`tests/e2e/auth_security.py`), but `/login` renders neither. A user who lost the password has to
know the API. Fix: links + minimal two-step forms (email → code + new password).

### F6 — Design system is good but thin in places (LOW)
`ui.tsx` provides Card/Section/StatCard/Badge/StatusBadge/ProgressBar/Field/EmptyState/ErrorState/
Skeleton/Toast; all pages use them consistently. Missing primitives that the redesign needs:
`Table` (all lists are hand-rolled `<ul className="divide-y">`), `Tabs`, `Dialog`, `Tooltip`,
`Pagination`, `DataGrid` skeleton, `Sparkline`. Also `eslint.ignoreDuringBuilds: true`
(`next.config.ts:113`) lets a lint regression pass `next build`.

### F7 — Real-time is polling, and it is not labelled (LOW)
Intervals: 5 s (active job), 8 s (publishing), 10 s (dashboard, system), 15 s, 30 s, 60 s. No SSE or
WebSocket. This is honest (values come from server state) but the UI should show *"updates every 10 s"*
next to live panels so nobody reads a stale number as live.

## 4. Phase 2 check — "backend logic inside the frontend"

Every candidate found, and why it is **not** a violation:

| Candidate | File | Verdict |
|---|---|---|
| Firebase SDK use | `lib/firebase-client.ts` | Legitimate. Only the *public* web config (apiKey/authDomain/projectId/appId) is used, served by `GET /api/auth/providers`; the ID token is exchanged server-side and the Firebase session is then signed out. No service-account credential anywhere. |
| Chunked upload loop | `app/create/page.tsx` → `lib/hooks.ts` | Legitimate. The browser streams bytes through `POST /api/sources/upload/part`; the server validates mime/size/duration with ffprobe and owns the storage key (`sources.service.ts:246`). No filesystem or ffmpeg work in JS. |
| CSRF token held in a module variable | `lib/api.ts:13` | Legitimate. It is a double-submit token, not a secret, and the session stays in an httpOnly cookie. |
| Config field metadata (labels/min/max) | `lib/config-schema.ts` | Legitimate *as metadata*, wrong as an authority — the API validates the values (`ConfigurationService`). Tracked as F2. |
| Password/sign-up format checks | `lib/auth-messages.ts:46` | Legitimate as UX hint; the server re-validates. Tracked as F3 for the inconsistency. |
| Permission hiding (`isOperator`) | `lib/hooks.ts:335`, `app/admin/page.tsx:18` | Legitimate as presentation. Authorisation is enforced by `@Roles()` + guard; proven by `authorization_matrix.py` (member → 403). |
| `process.env` in `next.config.ts` / `healthz/route.ts` | build/server context only | Legitimate. No `NEXT_PUBLIC_*` variable exists in the repo. |

**Result: nothing had to be moved out of the browser.** Secrets, DB access, OTP, hashing, token
refresh, ffmpeg, scheduling and permission checks are already server-side. The real frontend problems
are *missing connections* (F1, F5), *duplication* (F2, F3) and *incomplete pages* (F4, F6) — not
leaked logic.
