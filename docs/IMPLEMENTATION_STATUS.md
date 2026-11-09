# Implementation status — independent audit round

Date: **2026-11-09** (Asia/Kolkata). Scope: a fresh, adversarial audit of the delivered system —
code reading plus live probing against the running stack. The previous verification round was
explicitly *not* trusted; every claim below is either a command that was executed in this round with
its real output, or is marked **BLOCKED** / **NOT IMPLEMENTED**. Nothing is marked "passed" because it
was written earlier.

Legend:

| Status | Meaning |
| --- | --- |
| **VERIFIED** | Exercised in this round against the running system; the evidence is quoted. |
| **BLOCKED** | Cannot be exercised here (no credentials / no Docker daemon / no public DNS). Not a pass. |
| **GAP** | Required behaviour is missing or partially implemented. Fixing was in scope and is recorded. |
| **LIMITATION** | Working as designed, but the behaviour is a deliberate trade-off worth knowing. |

Environment: PostgreSQL 17.11, Redis 7, Node 20.20.2, Python 3.13.16, FFmpeg 7.1.5, Next 15.5.29,
NestJS API on `:4000`, dashboard on `:3000`, AI engine on `:8100` (`AI_PROVIDER=fixture TEST_MODE=1`),
video processor on `:8200`, five workers (ai/pipeline, render, publish, scheduler, recovery).

---

## 1. Defects found in this round, and what was done

Every item below was reproduced first, then fixed, then re-tested. Fixes are committed with the code.

| # | Severity | Defect (as observed) | Fix | Re-test evidence |
| --- | --- | --- | --- | --- |
| D1 | **High** | HTTP Range requests were answered with the **head of the file**. `Range: bytes=20000000-20000099` returned the first 100 bytes while advertising `206` + `content-range: bytes 20000000-20000099/22954423`. Seeking/scrubbing in any player silently decoded the wrong frames. | Added `StorageService.statSize()` and `getStreamRange()` (local `createReadStream({start,end})`, S3 `GetObjectCommand` with a `Range` header); the controller now streams the requested window. | Served bytes at offset 20 000 000 hash-match the file (`4edf191f3d193912…`); tail request `bytes=22954300-` returns 123 bytes matching the file tail; `bytes=99999999-` → **416**. |
| D2 | **High** | Multipart upload appended parts **in arrival order**, ignoring `partNumber`, so any concurrent/retried part corrupted the staged file. No total-size cap was enforced either (declared 1 MB, upload 10 GB → disk exhaustion). | Parts are written at `(partNumber-1) * partSize` with a positional handle (`r+`), duplicates are idempotent, `partNumber` beyond the declared part count is rejected, and the final staged size must equal the declared size. | Uploaded a 26 303 712-byte file as parts **2 → 1 → 1 (retry)**; staged file is **byte-identical** (`sha256 8343689b…`). A missing part yields `400 "Upload is incomplete: 16777216 of 26303712 bytes were received"`; the completed upload then validates (`31.92s 1280x720 h264`). |
| D3 | **High** | `attempt` (the retry budget) was incremented on **every worker-lease acquisition**, so a healthy job burned its whole budget just moving pipeline → render → publish; a single transient failure then failed the job immediately. | `acquireJobLease()` no longer touches `attempt`; entering `RETRYING` is what consumes exactly one attempt. | Integration test asserts three lease acquisitions leave `attempt = 0` and two retries leave `attempt = 2`; a live job completed with `attempt = 0`. |
| D4 | **High** | The recovery sweeper had **no retry-budget guard** and would reclaim a dead job forever. Publishing recovery likewise re-queued stalled jobs without bound. | Before reclaiming, `attempt >= maxAttempts` now transitions the job to `FAILED` with `RETRY_BUDGET_EXHAUSTED` (audit entry written); the same guard added to stalled publishing jobs. | A job left at `attempt=3/max=3` with a 10-minute-stale heartbeat became `FAILED/RETRY_BUDGET_EXHAUSTED` at the next sweep; a sibling job with budget left was reclaimed, resumed from `PROBING`, ran to **COMPLETED**. |
| D5 | **High** | `POST /api/jobs/:id/retry` returned **HTTP 500 on every failed job**: the resume point was computed from `JobStage` rows that include control states (`FAILED`, `RETRYING`), producing an illegal `RETRYING → FAILED` transition. Jobs could get stuck in `RETRYING` with no way out. | Resume point is now the last **pipeline** stage that succeeded; the state machine allows `RETRYING → FAILED / CANCELLED / NEEDS_CONFIGURATION` so a retry that cannot be planned (or exhausts its budget) is never stranded. | `POST /api/jobs/{failed}/retry` → **201**, job re-entered the pipeline and reached **COMPLETED**; unit test `RETRYING is never a dead end` covers the transitions. |
| D6 | **High** | The job's chosen `brandProfileId` was **ignored** — the render worker always applied `isDefault: true`. Selecting a brand in the UI produced someone else's logo, intro and outro. | Resolution uses `configuration.brandProfileId` when present (404-style failure if the profile was deleted) and only falls back to the workspace default when the job did not choose. | Job with the non-default "Alt Brand" rendered a **green logo top-left, no intro/outro** (27.98 s); the default brand's job rendered a **red logo bottom-right, 1.2 s intro + 1.0 s outro** (30.185 s = 27.98 + 1.2 + 1.0). |
| D7 | **High** | "Brand assets" existed in the schema and in the renderer, but there was **no way to upload** a logo/intro/outro: the UI accepted only a raw `storageKey`, so the feature was unusable end-to-end. | New `POST /api/brand-assets?kind=LOGO|INTRO|OUTRO` (mime + size validated, workspace-scoped key, audit row `BRAND_ASSET_UPLOADED`, object deleted if the audit write fails) and file pickers in Brand studio. | `201` for PNG logo / INTRO / OUTRO MP4; wrong mime → `400`. A job using those assets rendered watermark + intro + outro (frames inspected). |
| D8 | **Medium** | `POST /api/auth/register` was public **and CSRF-exempt** with no operator gate: anyone on the internet could mint a workspace, contradicting the project's bootstrap-token-only posture. | `ALLOW_SELF_REGISTRATION` (default **false**) gates the endpoint with `403 FORBIDDEN`; CSRF is now required; the capability is advertised through `GET /api/auth/session` so the login screen only shows "Create account" when the deployment allows it. | With the flag off: `403` and `{authenticated:false, selfRegistrationEnabled:false}`. With it on: `201`, and a CSRF-less POST gets `403 CSRF_FAILED`. Login screen renders two tabs, not three, in the default posture. |
| D9 | **Medium** | Roles (`OWNER/ADMIN/MEMBER`) existed in the schema but were **never enforced**: every member could read `/api/system/*` (worker ids, queue depths, integration state). | `@Roles()` decorator + guard enforcement; `@Roles('OWNER','ADMIN')` on the system controller; "System admin" hidden from the nav for members; the dashboard degrades to "visible to owners and admins" instead of erroring. | Member session: `/api/system/overview` → **403** `"requires one of: OWNER, ADMIN. Your role is MEMBER."`, `/api/clips` → 200, `/api/dashboard/summary` → 200. Owner unchanged (200). Screenshots `member-dashboard.png`, `member-admin-blocked.png`. |
| D10 | **Medium** | Operator actions were unreachable from the UI: the job page had **no Retry/Cancel**, and per-platform metadata was **read-only** even though `PATCH /api/clips/:id/metadata` existed. | Added Retry/Cancel to the job page (with error surface) and an inline metadata editor (title/description/hashtags/tags per platform) in the clip detail panel. | Retry → `201` from the browser; metadata save → `200 PATCH` and the new title renders (and was picked up by the E2E run: `youtube title: 'Audited title from the dashboard'`). |
| D11 | **Low** | `POST /api/jobs/:id/retry`-adjacent write: `BRAND_ASSET_UPLOADED` was missing from `AuditAction`, so the first asset upload returned **500** after the object had already been written. | Enum value added (migration `brand_asset_audit_action`), and my own follow-up fix makes the endpoint delete the object if the audit write fails. | Upload → `201` + audit row present (`Activity log`). |
| D12 | **Low** | `/media/health/probe.mp4` answered **404 JSON** while being advertised as the public media pre-flight URL — it proved the URL resolved, not that media could be served. | The endpoint now serves a real embedded 0.2 s 64×64 H.264 MP4 with correct headers. | `200`, `content-type: video/mp4`, 1605 bytes, `ffprobe`: `h264 64x64 0.200000`. |

---

## 2. Feature status

### 2.1 Authentication, sessions, tenancy — VERIFIED

* 9 sensitive routes probed **without** a session: `/api/jobs`, `/api/clips`, `/api/dashboard/summary`,
  `/api/publishing/jobs`, `/api/accounts`, `/api/configuration`, `/api/brand-profiles`,
  `/api/activity`, `/api/system/overview` → **401 everywhere**. `/api/docs` → 200 (intended).
* Cross-workspace reads of a job, clip, clip variant, source, `/api/sources/:id`,
  `/api/clips/:id/download`, `/api/clips/:id/preview` and `POST /api/accounts/:id/verify` from the
  second workspace → **404 on all eight** (existence is not leaked).
* Logout revokes server-side: replaying the same cookie afterwards → **401**.
* Login rate limiting: 10 attempts per 300 s → attempts 10 and 11 returned **429**.
* Error shape is uniform (`{error:{code,message,requestId}}`) for 401/403/404/416/429/500; an unknown
  API path returns `404 {"code":"NOT_FOUND"}`.
* Argon2id hashing, AES-256-GCM credential encryption, HMAC sessions and sha256 CSRF tokens unchanged
  from the previous round (unit-tested).
* **GAP (open, not fixed):** there is no invite or user-management surface. With self-registration
  disabled by default, a workspace is effectively single-user. A second member was created for the
  RBAC test directly in the database (`member@clipforge.local`, role `MEMBER`).
* **LIMITATION:** the API additionally sets `ALLOWED_ORIGINS`; the sandbox preview origin works
  because it is listed in `.env`, not because of a wildcard.

### 2.2 Ingestion — VERIFIED (upload), BLOCKED (URL import of real remote media)

* Chunked upload of 26 303 712 bytes: **out-of-order + duplicate parts produce a byte-identical
  file**; incomplete uploads are rejected with the exact received/declared byte counts; oversized
  part numbers and out-of-range byte windows are rejected; FFprobe validation succeeds
  (`31.92s 1280x720 h264`) and the rights declaration is recorded.
* Direct-URL import code path exists with an SSRF guard that resolves every DNS hop, blocks private
  ranges, re-validates manual redirects and caps bytes plus wall-clock time (**code review; not
  exercised against a hostile host in this round because no such host is reachable from the sandbox**).
* **LIMITATION:** with `STORAGE_DRIVER=s3` the browser upload path is not wired (the API returns
  presigned part URLs but the dashboard still posts parts to `/api/sources/upload/part`, which is
  local-driver-only). Only the `local` driver is verified here.

### 2.3 Processing pipeline — VERIFIED

* Full E2E run in this round: `QUEUED → TRANSCRIBING → AI_ANALYSIS → RENDERING → COMPLETED`,
  2 clips, downloaded clip re-probed as **810×1440 h264/aac 29.82 s 22 954 423 bytes**.
* `[e2e] E2E PASSED`, job `80fbfe4a-4d33-408d-9097-682bb3858382`; dashboard counts
  `{sources: 14, clips: 19, published: 0, processing: 0, failed: 0}`; workers
  `ai, publish, recovery, render, scheduler` alive; audit actions
  `AUTH_LOGIN, CLIP_RENDERED, CONFIG_CHANGED, JOB_CREATED, JOB_RETRIED, RIGHTS_DECLARED, SOURCE_UPLOADED`.
* Crash recovery is real: a job whose worker vanished mid-`TRANSCRIBING` was reclaimed by the sweeper,
  resumed at the last successful stage, and **completed**; an identical job with the retry budget
  spent was instead marked `FAILED/RETRY_BUDGET_EXHAUSTED` (no infinite loop).
* Usage ledger populated from real work: `render_seconds 14 rows / 368.6 s`,
  `transcription_seconds 10 / 356.8 s`, `storage_bytes 8 / 647 514 568 B`.
* **LIMITATION:** the AI engine ran in **fixture** mode (`AI_PROVIDER=fixture TEST_MODE=1`); all AI
  scoring/copy in this round is deterministic fixture output, not Gemini output. BLOCKED on a Gemini
  API key. See §3.

### 2.4 Rendering and branding — VERIFIED

* Vertical render with burned-in word-level subtitles, loudness normalisation, framing modes.
* Branding proven end-to-end **through the product**, not just the renderer library:
  default profile with an uploaded logo + intro + outro → 30.185 s clip = 27.98 s window + 1.2 s intro
  + 1.0 s outro, watermark visible bottom-right, subtitles intact.
* Brand selection honoured (D6) and assets uploadable (D7).

### 2.5 Publishing — BLOCKED (no platform credentials); guard rails VERIFIED

* `POST /api/publishing/jobs` with no enabled account → `400 PUBLISH_ELIGIBILITY_FAILED`
  ("No YOUTUBE account with publishing enabled…") — the UI surfaces this text.
* Idempotency: `idempotencyKey = clip:platform:account:operation` with a unique index; the publish
  worker reconciles a possibly-landed upload (`externalId` → `getVideoStatus`) before re-uploading,
  verifies the video after upload, retries with jittered backoff and a hard cap of 5 attempts.
* Publishing settings are no longer silently defaulted: missing `visibility`, `categoryId` or
  `madeForKids` now fails with an explicit platform error instead of guessing `private`/`22`/`false`.
* **BLOCKED:** an actual YouTube/Instagram publish, OAuth connect, token refresh and webhook handling
  cannot be exercised without client credentials and a public HTTPS media origin. The connect buttons
  are correctly disabled and explain what is missing (`awaiting credentials`).

### 2.6 Dashboard — VERIFIED

* 9 authenticated pages render with **zero console errors** for the operator role (the only 403s in
  the member session are the intended operator-endpoint refusals).
* Clicked every non-destructive control on every page: each either issues its API call or navigates.
  Verified live: settings save (`PUT /api/configuration`, disabled until a value changes, validation
  errors surfaced), metadata edit (`PATCH`, persisted), job retry (`POST`, 201), download
  (`22 954 423` bytes saved), brand asset upload (`POST /api/brand-assets`, 201), brand profile
  create (`201`), subtitle preset create.
* Screenshots refreshed in `/home/user/screenshots/` (`login`, `dashboard`, `jobs`, `clips`,
  `clip-metadata-editor`, `publishing`, `accounts`, `brand`, `settings`, `activity`, `admin`,
  `member-dashboard`, `member-admin-blocked`, plus `screenshots/audit/**`).
* **LIMITATION:** the clip detail is an inline panel on `/clips`, not a `/clips/[id]` route, so a clip
  cannot be deep-linked or bookmarked individually.

### 2.7 Configuration, audit, operations — VERIFIED

* Configuration page writes only explicit values, surfaces `missingForProcessing` /
  `missingForPublishing`, rejects out-of-range values (`ai.max_output_clips must be between 1 and 50`
  returned by the API and shown in the UI).
* Audit log records every mutation including the new `BRAND_PROFILE_CREATED`,
  `BRAND_ASSET_UPLOADED` and `JOB_RETRIED`.
* `GET /api/system/health` (public, liveness only) and `readiness` (operator) behave as designed;
  `processingReady` is false without AI credentials and the dashboard says so.
* Backup/restore scripts were exercised in the previous round; not re-run this round.

---

## 3. Blocked work (never to be reported as done)

| Item | Why blocked | What would unblock it |
| --- | --- | --- |
| Real Gemini analysis (transcript insight, 10-factor scoring, metadata copy) | No API key; fixture provider is active | `GEMINI_API_KEY` + `AI_PROVIDER=gemini`, then re-run `tests/e2e/full_workflow.py` |
| YouTube upload / OAuth connect / token refresh | No Google Cloud OAuth client, no verified channel | `YOUTUBE_CLIENT_ID/SECRET`, a redirect URI on public HTTPS, a channel |
| Instagram Reels publish, container polling, webhooks | No Meta app, no Business account, no public HTTPS media origin | `INSTAGRAM_APP_ID/SECRET`, public HTTPS `STORAGE_PUBLIC_BASE_URL`, `WEBHOOK_VERIFY_TOKEN` |
| Public HTTPS media delivery / platform pre-flight | No DNS, no certificate, no Docker daemon | a host with TLS termination (`Caddyfile` is authored) |
| Docker/compose deployment | No Docker daemon in the sandbox | a host with Docker; compose files are YAML-validated only |
| Email/notification delivery | No SMTP credentials and none configured | SMTP settings + provider |

---

## 4. Known limitations (accepted, documented)

1. **No upscaling.** A 720p source renders to 404×720 in 9:16 rather than 1080×1920; the renderer
   refuses to invent pixels. Verified in the renderer log ("Source height 720 < requested 1920 —
   rendering at 404×720 (no upscaling)"). Use ≥1080p sources for full-size vertical output.
2. **Single-driver verification.** Only `STORAGE_DRIVER=local` was exercised; the S3 code paths
   (presigned parts, `HeadObject`, ranged `GetObject`) typecheck but are unverified.
3. **No user invitations.** Roles are enforced but an administrator cannot create a second user
   except by enabling self-registration.
4. **Clip detail is a panel**, not a route (§2.6).
5. **Connection pooling under restart storms.** One E2E run failed with
   `Can't reach database server at 127.0.0.1:5432` while several worker processes were being killed
   and restarted within seconds; the next run passed unchanged. Mitigation for operators: set
   `?connection_limit=` on `DATABASE_URL` and stagger worker restarts.
6. **Fixture AI provider** means AI-quality claims (hook scoring, metadata tone) are unverified in
   this environment by construction.
7. `next build` warns about a 500 kB+ first-load chunk on the settings page; it is a bundle-size
   warning, not a functional defect.

---

## 5. Test results (this round, executed)

| Suite | Command | Result |
| --- | --- | --- |
| Unit | `npm run test:unit` | **38 passed** (4 files) — includes the new `RETRYING is never a dead end` case |
| Integration | `npm run test:integration` | **14 passed** (2 files) — new: retry-budget semantics, ranged reads, out-of-order/duplicate parts |
| E2E | `.venv/bin/python tests/e2e/full_workflow.py /home/user/testdata/light-source.mp4` | **E2E PASSED** |
| Health | `bash infrastructure/scripts/healthcheck.sh` | all components ok |
| OpenAPI | `curl /api/docs/openapi.json` | 51 paths, exported to `docs/openapi.json` |

**Precondition:** `npm run test:integration` must run with the workers **stopped**. The outbox test
claims from the same durable outbox the live workers poll; with workers running, a background worker
can legitimately claim the row first and the assertion fails for environmental reasons only. This was
reproduced and then confirmed green with workers stopped.

---

## 6. What changed in this round

Code: `apps/api/src/{media/media.controller.ts, storage/storage.service.ts, sources/sources.service.ts,
jobs/jobs.service.ts, workers/{recovery,render,publish}.worker.ts, auth/auth.controller.ts,
workspace/{workspace.controller,workspace.service}.ts, system/system.controller.ts,
common/{env.ts,decorators/auth.decorators.ts,guards/session-auth.guard.ts}}`,
`packages/{shared-types/src/index.ts, database/src/repositories.ts, database/prisma/schema.prisma}`,
`apps/web/{app/{login,page,clips,jobs/[id],brand}/page.tsx, components/shell.tsx, lib/{api,hooks}.ts}`,
`tests/{unit/state-machine.test.ts, integration/{database,storage}.test.ts}`, migration
`brand_asset_audit_action`, `docs/openapi.json`, `.env.example` (`ALLOW_SELF_REGISTRATION=false`).

Verdict: the system now does what this document claims, and nothing beyond it. The pieces that remain
unproven are exactly the ones that need credentials, a public origin or a container host — they are
listed as BLOCKED above and must not be described as working.
