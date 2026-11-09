# Testing

Three layers, all runnable locally. Nothing in the test suites writes to a production database and
no test fabricates a result.

## Unit — `npm run test:unit`

Vitest, no external services (`tests/vitest.config.ts`), 37 tests:

* `tests/unit/state-machine.test.ts` — every state has a transition list, the happy path walks in
  order, `ASSET_STORAGE → COMPLETED` is allowed (regression: manual publishing used to dead-end),
  terminal states absorb, `RETRYING` is reachable from every started state but not from `CREATED`,
  and unknown transitions are rejected.
* `tests/unit/validation.test.ts` — rights declaration required, non-HTTPS import rejected, upload
  mime/size sanity, YouTube visibility and terms acceptance required to enable publishing, brand
  colour format, subtitle style completeness.
* `tests/unit/platform-connectors.test.ts` — 429 → `RATE_LIMIT` with `retry-after`, 5xx →
  retryable, 401/403 → `AUTH` (not auto-retried), 4xx → `PERMANENT`, platform code/subcode
  surfaced, backoff growth and jitter window, YouTube consent URL contract, unsupported Graph
  version rejected instead of defaulted.
* `tests/unit/crypto.test.ts` — AES-256-GCM round-trip, fresh IV per encryption, tamper detection,
  HMAC determinism and purpose separation, refusal when the secret is unset.

## Integration — `npm run test:integration`

Vitest against the **real PostgreSQL** (`tests/vitest.integration.config.ts`), 10 tests. A throwaway
workspace is created and deleted per run:

* full job lifecycle with stage bookkeeping (no stage left `RUNNING`),
* illegal transition rejected and row untouched,
* `FAILED → RETRYING → resume`,
* lease acquisition exclusivity, released-lease ≠ abandonment, stale heartbeat = abandonment,
* control-state rows ignored when computing the resume point,
* outbox row written in the same transaction as the job, claimed exactly once with a visibility
  timeout, failure recorded without losing the event,
* audit log captures actor/IP/metadata,
* configuration resolution reports every missing key instead of defaulting, and workspace values
  win over global rows.

Requires `DATABASE_URL` (read from `.env`). Not mocked: this is the same Prisma client the workers
use.

## End-to-end — `.venv/bin/python tests/e2e/full_workflow.py <video>`

A strict HTTP harness against a running stack (API, AI engine, video processor, all five workers).
It performs: CSRF fetch → login → explicit configuration write → chunked upload → FFprobe
validation → job creation → stage polling → clip selection → render → clip download and probe of the
downloaded file → metadata preview → dashboard/audit/worker assertions. It fails loudly on any
non-2xx, on a job that does not reach a terminal state, or on numbers that do not match the API's own
dashboard summary.

Run:

```bash
.venv/bin/python tests/e2e/full_workflow.py /home/user/testdata/light-source.mp4
```

Use a small source (1280×720, ~30 s). A 2560×1440 source makes FFmpeg pegging all cores look like
an API stall — that is CPU saturation, not a defect.

## Verification helpers

* `infrastructure/scripts/verify-pipeline.py` — drives the AI engine and the video processor
  directly and re-probes every rendered file (resolution, codecs, duration).
* `infrastructure/scripts/healthcheck.sh` — dependency smoke test.

## Preconditions for the integration suite

`npm run test:integration` talks to the same PostgreSQL/Redis the running stack uses, and one case
asserts it is the *only* consumer that claims a freshly written outbox row. **Stop the workers before
running it**, otherwise a live worker can legitimately claim the row first and the assertion fails for
environmental reasons:

```bash
pkill -f "dist/workers/"      # or stop them however you launched them
npm run test:integration      # 14 tests
```

Rounds run in this repository: **38 unit tests**, **14 integration tests**, and the E2E workflow.
Newest cases cover three defects found in the audit round (see `IMPLEMENTATION_STATUS.md`):
ranged reads honour byte offsets, multipart parts are order-independent and idempotent, and `attempt`
counts retries rather than lease acquisitions.

## Blocked-by-credentials tests

Anything that needs a third party is marked **BLOCKED — awaiting credentials** rather than skipped
silently: Gemini structured analysis (runs use the fixture provider with `TEST_MODE=1`), YouTube
upload, Instagram container publish, S3/R2 storage, and the ACME/TLS deployment path. Each has code
coverage at the unit level (request building, error classification, configuration guards) and an
explicit live test that cannot pass without real credentials.
