# API connection audit

Cross-check of every frontend feature against the backend that is supposed to serve it. Produced by
extracting all 82 controller routes, extracting every path literal used by `apps/web`, normalising
`${…}`/`:id` segments, and diffing the two sets in both directions.

**Result of the diff: 0 frontend requests target a non-existent route.** The eight apparent misses were
Next rewrites (`/api/*`, `/media/*`) and generated types in `.next/types`. Nothing in the UI calls a
route that does not exist — the problems are the opposite direction (routes with no caller) and
*states the UI never offers* (publishing enable, recovery flows).

## 1. Feature matrix

Status vocabulary — deliberately strict:

* **VERIFIED** — exercised end-to-end by an automated suite on the live stack in this session.
* **IMPLEMENTED, NOT FULLY VERIFIED** — endpoint + UI exist and the wiring is proven, but the path
  needs third-party credentials this environment lacks (real Google/Meta OAuth, Gemini).
* **BROKEN CONNECTION** — one side exists, the other does not reach it.
* **NOT IMPLEMENTED** — no code. Must not appear in the UI as a button or a page.

| # | Feature | Frontend | Backend endpoint(s) | Database | Status | Evidence |
|---|---|---|---|---|---|---|
| 1 | Sign in (password) | `/login` | `POST /api/auth/login` | `User`, `Session`, `LoginEvent` | **VERIFIED** | `auth_security.py` 46/46 |
| 2 | Sign in (Google/Firebase) | `/login` → `lib/firebase-client.ts` | `POST /api/auth/firebase`, `GET /api/auth/providers` | `User.firebaseUid` | IMPLEMENTED, NOT FULLY VERIFIED | code path + `tests/integration/firebase-auth.test.ts` (8) with a stub verifier; no live Google tenant in this environment |
| 3 | Two-step verification (email/Telegram/dual) | `/login` step-up screen, `/security` | `POST /api/auth/security/otp/step-up/complete`, `/otp/resend`, `PUT /otp-mode` | `OtpChallenge`, `User.otpMode` | **VERIFIED** | `auth_security.py` + real SMTP sink + Playwright screen capture |
| 4 | Password recovery | — | `POST /forgot-password`, `/reset-password`, `/recovery-codes/redeem` | `OtpChallenge`, `RecoveryCode` | **BROKEN CONNECTION** (UI missing) — API verified | API proven by `auth_security.py`; `/login` has no link or form |
| 5 | Devices & sign-in history | `/security` | `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all`, `GET /login-history` | `Session`, `LoginEvent` | **VERIFIED** | 46/46 suite, browser screenshot |
| 6 | Session lifecycle | shell, all pages | `GET /api/auth/session`, `POST /logout`, `GET /csrf` | `Session` | **VERIFIED** | `scenarios.py` 04, `auth_security.py` |
| 7 | Upload a source video | `/create` | `POST /api/sources/upload/{initiate,part,complete}` | `SourceVideo`, `StorageObject` | **VERIFIED** | `scenarios.py` 05/06, `full_workflow.py` (validates 35 s 1280×720) |
| 8 | Import from direct URL | `/create` | `POST /api/sources/import` | `SourceVideo` | **VERIFIED (guard)** | `scenarios.py` 07 (SSRF blocked); a successful import needs an external host |
| 9 | Create processing job | `/create` | `POST /api/jobs` | `ProcessingJob` | **VERIFIED (creation + state machine)** | `scenarios.py` 08/12/13/14; the AI stage is blocked here by a missing `GEMINI_API_KEY` (recorded, not hidden) |
| 10 | Job list / detail / progress | `/jobs`, `/jobs/[id]` | `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events` | `ProcessingJob`, `JobStage` | **VERIFIED** | telegram suite + `ui_responsive` |
| 11 | Cancel / retry a job | `/jobs/[id]` | `POST /api/jobs/:id/{cancel,retry}` | `ProcessingJob`, `JobStage` | **VERIFIED** | `scenarios.py` 13/14, telegram suite 3 |
| 12 | Clip library, preview, download, metadata edit | `/clips` | `GET /api/clips`, `GET /api/clips/:id/{preview,download}`, `PATCH /api/clips/:id/metadata` | `GeneratedClip`, `ClipVariant`, `ClipMetadata` | **VERIFIED** | `scenarios.py` 11/15 |
| 13 | Publishing jobs & history | `/publishing` | `GET /api/publishing/jobs`, `/history`, `POST /api/publishing/:id/retry` | `PublishingJob`, `PublishingAttempt`, `PublishedPost` | **VERIFIED (creation/eligibility)**, publish to a real platform NOT VERIFIED | `scenarios.py` 16, telegram suite |
| 14 | Enable/disable automation per account | — | `POST /api/publishing/{enable,disable}` | `ConnectedAccount.publishingConfig` | **BROKEN CONNECTION** (no caller) | route exists, `publishing.service.ts:157` requires it, `grep` finds no UI use |
| 15 | Connect YouTube / Instagram | `/accounts` | `POST /api/accounts/{youtube,instagram}/connect`, callbacks, `select-channel`, `verify`, `DELETE` | `ConnectedAccount`, `OAuthCredential` | IMPLEMENTED, NOT FULLY VERIFIED | needs a real Google Cloud / Meta app; `authorization_matrix` proves only the refusal paths |
| 16 | Workspace configuration (25 keys) | `/settings`, `/brand` | `GET/PUT /api/configuration` | `ApplicationConfiguration` | **VERIFIED** | `full_workflow.py` writes all keys; 428 path in `scenarios.py` 08 |
| 17 | Brand profiles, assets, subtitle presets | `/brand` | `POST /api/brand-profiles`, `POST /api/brand-assets`, `POST /api/subtitle-presets` | `BrandProfile`, `MediaAsset`, `SubtitlePreset` | **VERIFIED** | `full_workflow.py` (preset + logo/intro/outro render) |
| 18 | Telegram notifications (settings, test, history) | `/admin` panel | `GET /status`, `PUT /settings`, `POST /test`, `GET /history`, `GET /categories` | `NotificationDelivery` | **VERIFIED** | `telegram_notifications.py` 36/36 (8 live scenarios) |
| 19 | Dashboard summary | `/` | `GET /api/dashboard/summary` | aggregates | **VERIFIED**, but incomplete fields (B5) | dashboard renders counts/jobs/clips/activity |
| 20 | System health / workers / queues / diagnostics | `/admin`, `/` (operators) | `GET /api/system/{overview,diagnostics,health,readiness}` | `SystemHealthEvent` | **VERIFIED** | `scenarios.py` 01, `admin` page |
| 21 | Audit trail | `/activity` | `GET /api/activity` | `AuditLog` | **VERIFIED** | `authorization_matrix`, dashboard activity card |
| 22 | Usage & cost reporting | — | `GET /api/usage/{summary,daily,records}` | `UsageRecord` | **BROKEN CONNECTION** (no consumer) — backend verified by `scenarios.py` 17 | data is written, never read by any client |
| 23 | Media streaming (HTTP Range) | `/clips` player | `GET /media/clips/:id`, `/media/sources/:id` | `StorageObject` | **VERIFIED** | `scenarios.py` 11 |
| 24 | Deployment self-diagnosis | `/healthz` | `GET /api/system/health` | — | **VERIFIED** | route + `ui_responsive` |
| 25 | Analytics (views/likes/watch-time) | — | — | — | **NOT IMPLEMENTED** | no models, no route |
| 26 | Workflow builder | — | — | — | **NOT IMPLEMENTED** | no models, no route |
| 27 | AI Studio (titles/hashtags/thumbnails) | `/clips` shows generated metadata only | generation happens inside the pipeline | `ClipMetadata` | **PARTIALLY IMPLEMENTED** — no authoring surface, no thumbnail/hook/script generation | — |
| 28 | Publishing calendar | — | scheduling exists in workers | `PublishingJob.scheduledFor` | **PARTIALLY IMPLEMENTED** (no calendar UI) | — |
| 29 | User management / invites | — | — | `WorkspaceMember` exists | **NOT IMPLEMENTED** | no route; a workspace is effectively single-user |
| 30 | Database health | — | — | — | **NOT IMPLEMENTED** (readiness covers reachability only) | — |

## 2. Backend routes with no caller, and why

| Route | Reason | Action |
|---|---|---|
| `GET /api/accounts/{youtube,instagram}/callback` | OAuth redirect target, hit by the browser after Google/Meta | keep (correct) |
| `GET /api/system/{worker-status,queue-status,events,readiness}` | duplicated by `GET /api/system/overview` | consolidate (B2) |
| `GET /api/usage/*` | no page consumes it | surface in Analytics/Admin or remove (B3) |
| `POST /api/publishing/{enable,disable}` | **missing UI** | add the control (F1) |
| `POST /api/auth/security/{forgot-password,reset-password,recovery-codes/redeem}` | **missing UI** | add recovery flows (F5) |
| `GET /api/brand-profiles/:id` | brand page never reads a profile back | use it in the editor |
| `GET /api/sources/:id`, `GET /api/clips/:id` (direct) | covered by list payloads | keep for detail deep-links |
| `GET /media/health/probe.mp4` | manual/hosted pre-flight asset | keep, document |

## 3. Contract consistency

* **Envelope**: every error is `{ error: { code, message, details?, missingConfiguration?, requestId } }`
  (`all-exceptions.filter.ts:73`). The client wrapper classifies on `code`, never on message text
  (`lib/api.ts:47`). One exception was found and fixed in phase 2: `attemptsRemaining` was dropped by
  the filter until it was moved into `details`.
* **Status codes**: 401 unauthenticated, 403 CSRF/role, 404 not-found **and** cross-tenant, 409 illegal
  state transition, 422 not used, 428 configuration required, 429 rate limited, 503 provider down.
  Consistent across controllers; verified by the matrices in `scenarios.py` and `authorization_matrix.py`.
* **Pagination**: `page`/`pageSize` (max 100) on clips, jobs, publishing. Enforced server-side; the UI
  only uses it on clips (and does not expose paging — F4).
* **Validation**: every mutating route parses with a zod schema from `packages/validation`; failures are
  400 with field-level `details`. Verified by `tests/unit/validation.test.ts` (in the 97).

## 4. Duplicate / unnecessary requests

* `/` polls `GET /api/dashboard/summary` **and** (for operators) `GET /api/system/overview`, both at
  10 s → two requests per 10 s per open dashboard. Folding `worker/queue/health` into the dashboard
  payload (B5) removes one.
* `/security` fetches `overview` (which already embeds `sessions` and `recoveryCodes`) plus
  `login-history` separately — justified, but the second call could be lazy (on scroll).
* `/clips` re-fetches the whole list after a metadata PATCH instead of patching the cached row — a
  visible extra request and a flash of skeleton.
* No request is issued twice for the same key (React Query de-duplicates by `queryKey`), and no page
  fires on every keystroke.

## 5. Endpoints that must be *created* for requirements that have no backend yet

These are the honest blockers. They are not "connection repairs" — they are missing systems:

| Requirement | Needs |
|---|---|
| Analytics page (views, likes, watch time, subscribers, CSV/PDF) | models for metric snapshots, a scheduler job that pulls from YouTube Data API / Graph, export endpoints |
| Workflow builder | workflow/step models, a compiler to existing queues, per-node implementations |
| AI Studio authoring | generation endpoint per asset type (title/description/hashtags/thumbnail/hooks/ideas/script), provenance + edit history |
| Publishing calendar | a query for scheduled jobs by range + conflict detection |
| User management | invite/role/remove endpoints with server-side permission checks |
| Database health | per-table size/index/kill-switch diagnostics |

Each will be built only when the backend exists, and only then will it get a nav entry.
