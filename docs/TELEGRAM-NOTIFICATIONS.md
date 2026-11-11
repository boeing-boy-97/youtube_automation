# Telegram notifications

Free, server-side notifications for automation events. No paid service, no SMS provider, no
webhook endpoint: the API and the workers call `https://api.telegram.org` directly with a bot token
you create in Telegram in about two minutes.

**The one rule that shapes everything here:** a notification describes a fact the backend has already
committed — a job row that reached `FAILED`, a `PublishedPost` row that exists. Nothing is sent from
the browser, and nothing is predicted. If the message says "upload completed", a platform returned a
URL.

---

## 1. Create the bot and get a chat id (2 minutes)

1. In Telegram, message **@BotFather** → `/newbot` → name it → copy the token
   (looks like `8123456789:AAH8xQ3…`).
2. Send your new bot any message (a bot cannot start a conversation).
3. Get your chat id from the token you now have:

   ```bash
   curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates" | grep -o '"chat":{"id":-\?[0-9]*'
   ```

   That number is your `TELEGRAM_CHAT_ID`. For a group, add the bot to the group first; group ids are
   negative (`-1001234567890`). A public channel can be addressed as `@channelusername`.

## 2. Configure the API

```bash
# .env (local) or the API service's environment (Render / Docker / systemd)
TELEGRAM_BOT_TOKEN=8123456789:AAH8xQ3...
TELEGRAM_CHAT_ID=-1001234567890
```

Optional tuning, all with sane defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Only changed by tests, which point it at a local fake |
| `TELEGRAM_TIMEOUT_MS` | `5000` | Per-attempt timeout; a hung connection can never hold a pipeline stage open |
| `TELEGRAM_MAX_ATTEMPTS` | `3` | Attempts per message, including the first |

Both values are validated at boot: a malformed token or chat id stops the API with an error naming
the fix, instead of failing silently on the first notification hours later. **Leaving both unset is
valid** — notifications report themselves as unconfigured and every other feature is unaffected.

Restart the API (and the workers, if they run separately).

## 3. Turn it on in the dashboard

`/admin` → **Telegram notifications**:

1. Tick **Send Telegram notifications for this workspace**.
2. Choose categories (the list below).
3. Optionally set a **chat id override** — the dashboard value wins over the environment, so one
   deployment can route different workspaces to different chats.
4. **Test connection** sends a real message through the real delivery path and reports the attempt
   count. A test message deliberately ignores the enable toggle: verifying credentials *before*
   turning the channel on is the point of the button.
5. **Save settings**.

The same panel shows bot identity (from `getMe`), the masked chat id, last delivery time, the last
24-hour sent/failed counters and the delivery history.

---

## 4. What is notified, and from where

Every row is a real call site, not a switch that can be flipped from the UI.

| Category | Emitted in | Triggered by | Dedupe key |
| --- | --- | --- | --- |
| `WORKFLOW_STARTED` | `apps/api/src/jobs/jobs.service.ts` (`create`) | the job row is committed and its outbox intent written | `job:<id>:started` |
| `SOURCE_DETECTED` | `apps/api/src/workers/pipeline.worker.ts` (PROBING) | `ffprobe` succeeded and the SourceVideo row was updated | `job:<id>:source-detected` |
| `SOURCE_DOWNLOADED` | pipeline worker (PROBING) | the object was fetched into the work directory | `job:<id>:source-downloaded` |
| `AI_STARTED` | pipeline worker (TRANSCRIBING) | transcription is about to be requested | `job:<id>:ai-started` |
| `AI_COMPLETED` | pipeline worker (AI_ANALYSIS) | transcript and highlight analysis are stored | `job:<id>:ai-completed` |
| `METADATA_COMPLETED` | pipeline worker (CLIP_SELECTION) | caption/hashtag rows were written (reports partial failure honestly) | `job:<id>:metadata-completed` |
| `UPLOAD_STARTED` | `apps/api/src/workers/publish.worker.ts` | the PublishingJob moved to `UPLOADING` | `publish:<id>:upload-started:<n>` |
| `PUBLISH_COMPLETED` | publish worker (`recordPublished`) | the platform returned a URL and `PublishedPost` exists | `publish:<id>:published` |
| `WORKFLOW_FAILED` | pipeline worker failure path, publish worker permanent failure | `exhausted` = no retryable path left | `job:<id>:failed` / `publish:<id>:failed` |
| `AUTH_EXPIRED` | `accounts.service.ts` (refresh failure), `scheduler.worker.ts` (Instagram refresh), publish worker (`TOKEN_EXPIRED`) | the account row became `EXPIRED` | `account:<id>:expired` |
| `QUOTA_ERROR` | pipeline worker, publish worker | a model/platform API answered quota or rate limit (429 / `RESOURCE_EXHAUSTED`) | `job:<id>:quota:<stage>:<attempt>` |
| `SCHEDULED_STARTED` | `scheduler.worker.ts` (`watchScheduledPublishing`) | a scheduled PublishingJob reached its time while still queued | `publish:<id>:scheduled-started` |
| `SCHEDULE_MISSED` | scheduler worker | the same job is >30 min overdue and still queued (workers down, or the upload keeps failing) | `publish:<id>:missed` |
| `WORKFLOW_STOPPED` | `jobs.service.ts` (`cancel`) | the job is committed as `CANCELLED` | `job:<id>:stopped` |
| `DAILY_SUMMARY` | scheduler worker (`dailySummaries`) | once per local day, in the configured hour | `daily:<YYYY-MM-DD>` |
| `CONNECTION_TEST` | `notifications.service.ts` (`test`) | an operator pressed the button | randomised on purpose |

Every workflow message carries the execution id (the job UUID), the stage, and — on failure — the
error code and the reason text.

## 5. Delivery guarantees

**At-most-once.** Each event has a stable `dedupeKey`. The delivery row is inserted *before* the HTTP
call against a unique `(workspaceId, dedupeKey)`. A retried BullMQ job, a redelivered outbox message,
a second worker and a process restart all hit that constraint and return `SKIPPED_DUPLICATE` instead
of sending again.

**Retries with exponential backoff.** `PERMANENT` failures (400 bad chat id, 403 bot blocked, 401 bad
token) stop immediately — retrying would fail identically forever. `RETRYABLE` failures (network,
timeout, 5xx) and `RATE_LIMIT` (429, honouring Telegram's own `retry_after`) use 500 ms → 1 s → 2 s…
capped at 8 s, with up to 25% jitter.

**A notification can never break the work it reports on.** `notify()` returns a result object and
never throws; delivery happens off the caller's critical path (`void deliver(row)`), so a pipeline
stage does not wait on Telegram and does not fail because of it.

**Restart-safe.** Attempts, errors and the retry horizon are database columns. On boot the API and
the scheduler worker call `retryPending()`: rows left `PENDING` by a crash are retried once, and rows
older than two minutes are marked `FAILED` with `abandoned: process stopped before delivery
completed` — a three-day-old "Workflow started" is worse than no message.

**Logged.** Every attempt is a `NotificationDelivery` row: category, status (`PENDING`, `SENT`,
`FAILED`, `SKIPPED`), attempts, last error, Telegram message id, chat-id suffix, timestamps. The admin
panel and `GET /api/notifications/history` read the same rows.

## 6. Security

* **The token never leaves the server process.** It is read from the environment, never written to the
  database, never included in an API response, and never logged: a delivery row stores the last four
  characters of the *chat id* at most. `redactToken()` strips anything token-shaped from an error
  string before it is stored, because a proxy error page can echo the URL it was asked for.
* **Settings are operator-only.** `GET/PUT/POST /api/notifications/*` are guarded by
  `@Roles('OWNER','ADMIN')`, workspace-scoped, rate limited (settings 30/min, test 10/min), and every
  change is written to `AuditLog` (`NOTIFICATION_SETTINGS_CHANGED`, `NOTIFICATION_SENT`,
  `NOTIFICATION_FAILED`). The audit entry records the chat-id suffix, never the id itself.
* **No inbound webhook exists**, so there is nothing to authenticate. Notifications are outbound only;
  the bot does not accept commands. If a webhook is ever added, it must verify
  `X-Telegram-Bot-Api-Secret-Token` and be served only over HTTPS — until then this paragraph is the
  note that says the surface does not exist rather than unexploited.

## 7. API surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/notifications/status` | bot identity, masked chat, last delivery, 24-hour counters, and what (if anything) blocks sending |
| `PUT` | `/api/notifications/settings` | `{ enabled, chatId?, categories?, dailySummaryHour? }` |
| `POST` | `/api/notifications/test` | `{ note? }` → sends a real message, returns `{ delivered, attempts, error }` |
| `GET` | `/api/notifications/history` | paginated delivery log, filterable by `category` and `status` |
| `GET` | `/api/notifications/categories` | the closed category set with labels and defaults |

## 8. Tests

```bash
# 20 unit tests: retry schedule, 429 retry_after, permanent vs retryable, token redaction,
# message rendering, chat-id masking, env validation. No network, no database.
npm run test:unit -- telegram-notifications

# 19 integration tests against real PostgreSQL: dedupe via the unique constraint, retry counts,
# permanent failure, restart recovery, history/status, settings round-trip.
DATABASE_URL=... npm run test:integration -- notifications

# 36 live checks: real API process, real workers, real job lifecycle, fake Bot API only.
.venv/bin/python tests/e2e/telegram_notifications.py
```

The end-to-end suite starts a local HTTP server that plays `api.telegram.org` and records exactly what
the Bot API would have received — the only substitute in the whole chain. It drives the real `/api/jobs`
endpoint, so the `WORKFLOW_STARTED` message is caused by a real job row, and the failure case is
produced by a real worker failing a real job.

It also covers the properties that are easy to claim and hard to prove: duplicate suppression on a
live event, recovery of a `PENDING` row across an API restart, delivery with no browser attached, and
the enable toggle suppressing a real workflow event (while a manual test message still works).

## 9. Deployment notes

* **Render:** both blueprints (`render.yaml`, `render.pipeline.yaml`) already declare
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `TELEGRAM_API_BASE` with `sync: false`, so Render
  prompts for them once. Add the same two variables to the **workers** service if you use
  `render.pipeline.yaml` — the workers send their own events and do not read the API's environment.
* **Workers are separate processes.** `WORKFLOW_STARTED`, `WORKFLOW_STOPPED` and `CONNECTION_TEST` come
  from the API; everything else comes from the worker fleet. With no workers running you get the first
  three and nothing else — which is exactly what the free Render stack does.
* **No extra infrastructure.** No queue for notifications, no cron, no inbound port. The scheduler
  worker's existing tick drives scheduled-publish checks and the daily summary.
* **Cost:** $0. Telegram's Bot API is free at any volume this system will produce.
