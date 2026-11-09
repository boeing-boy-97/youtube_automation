# Architecture

## Shape

One Next.js front end, one NestJS API that also hosts five worker roles, two FastAPI Python
services, PostgreSQL as the only source of truth, Redis for queue transport and ephemeral
coordination.

```
browser ──▶ Next.js (single origin: /api and /media are proxied) ──▶ NestJS API ──▶ PostgreSQL
                                                                    │  ▲              Redis
                                                                    ▼  │
                                                    BullMQ queues ───┘
                                                          │
                        ┌─────────────────────────────────┼───────────────────────────┐
                        ▼                                 ▼                           ▼
                 pipeline worker                    render worker               publish worker
                 (ai-engine: probe,                 (video-processor:           (platform-connectors:
                  transcribe, analyse)               framing, subtitles,         YouTube v3, Instagram
                                                     loudness, 9:16 mp4)        Graph v27.0)
```

The browser never talks to the API host directly: `next.config.ts` rewrites `/api/*` and `/media/*`
to `API_INTERNAL_URL`. Session and CSRF cookies are therefore first-party, and no token is ever
stored in `localStorage`.

## Tenancy and identity

* `Workspace` is the tenancy boundary. Every business row carries `workspaceId`, and every query in
  the API is scoped through the authenticated membership.
* Sessions are opaque random tokens in an HttpOnly cookie; only a SHA-256 HMAC of the token is
  stored (`Session.tokenHash`), so a database leak cannot be replayed as a session.
* CSRF is a double-submit token: the raw value lives in a readable cookie, the hash in the session
  row, and every mutating request must echo it in `x-csrf-token`.
* Passwords use Argon2id. OAuth refresh/access tokens use AES-256-GCM (`CREDENTIAL_ENCRYPTION_KEY`)
  and are never returned by any endpoint.
* Every mutation appends to `AuditLog` with actor, IP, user agent and structured metadata.

## Durable job execution

The job state machine (`packages/shared-types`) is the contract:

```
CREATED → UPLOADING → QUEUED → PROBING → TRANSCRIBING → AI_ANALYSIS → CLIP_SELECTION →
RENDERING → VALIDATION → ASSET_STORAGE → PUBLISHING_QUEUED → PUBLISHING → COMPLETED
control states: RETRYING, NEEDS_CONFIGURATION, PARTIALLY_COMPLETED, FAILED, CANCELLED
```

* `transitionJob` is the only writer of job state. It validates the transition against the map,
  stamps the stage row, closes any stage that was still `RUNNING`, and writes the outbox event in
  the same transaction. Illegal transitions throw `IllegalTransitionError`.
* **Transactional outbox.** A committed business change always has a matching queue intent.
  `claimOutboxBatch` is a single atomic `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` that
  increments `attempts` and pushes `availableAt` forward — a visibility timeout. A relay crash
  cannot lose or double-claim an event; consumers are additionally idempotent because the BullMQ
  jobId is the outbox row id.
* **Leases and heartbeats.** A worker acquires a lease before running a stage, heartbeats while it
  works, and releases the lease between stages. The recovery sweep (`findAbandonedJobs`) treats a
  job as abandoned only when its heartbeat has gone stale; a released lease is normal operation and
  must never be read as abandonment.
* **Recovery.** On abandonment the sweeper moves the job to `RETRYING` and resumes from the last
  *real* successful stage (control-state rows are ignored). Jobs that already have rendered clips
  resume at `VALIDATION`; they never fall back to analysis.
* **Retries.** Attempts are bounded by `maxAttempts`. Backoff is exponential with full jitter
  (`backoffWithJitter`), and platform errors are classified `RETRYABLE | RATE_LIMIT | AUTH |
  PERMANENT` so a permanent rejection never loops.

## Service boundaries

* `ai-engine` owns everything model-related: Whisper, frame sampling, the Gemini call, JSON-schema
  validation, scoring, de-duplication and dual-duration planning. It is stateless and
  API-key protected.
* `video-processor` owns everything pixel- and audio-related: probing, framing decisions, subtitle
  rendering, loudness measurement and the final MP4. It refuses to silently substitute a framing
  strategy.
* The API never calls FFmpeg or a model directly; it coordinates, persists and enforces policy.

## Failure behaviour

* Missing configuration anywhere in the enumerated list surfaces as HTTP 428 with the exact missing
  keys and the message *"Configuration required — processing cannot start."* There are no
  code-level defaults for AI model, versions, processing settings, accounts, privacy, schedules,
  time zones, limits, subtitle style, storage provider, retention or permissions.
* Platform calls that time out ambiguously (for example a Reel container that may or may not have
  been created) are reconciled by querying the platform before retrying.
* Media that has to stay publicly reachable (Meta fetches the Reel file itself) is retained for the
  configured asset window; retention never deletes it early.
