# `tests/`

Four kinds, deliberately separated by what they need to run.

| suite | command | needs | covers |
| --- | --- | --- | --- |
| `unit/` | `npm run test:unit` | nothing | state machine, validation, crypto, platform connectors, cost maths, diagnostics |
| `integration/` | `npm run test:integration` | Postgres + Redis | outbox transactionality, repository behaviour, concurrency |
| `python/` | `npm run test:python` | ffmpeg | render validation parser + real verdicts (silent/black/frozen/wrong-size) |
| `e2e/` | `npm run test:e2e` | full stack running | upload → transcript → selection → render → download |
| `e2e/scenarios.py` | `.venv/bin/python tests/e2e/scenarios.py` | full stack running | 19 scenarios (health, CSRF, limits, pipeline, quality, usage, restart) |
| `e2e/authorization_matrix.py` | `.venv/bin/python tests/e2e/authorization_matrix.py` | full stack running | 27 anonymous / role / cross-tenant checks |

`e2e/harness.py` holds the shared CSRF-aware client and the throwaway-tenant helpers — use it rather
than writing another HTTP client.

Rules: a scenario asserts with evidence (status, id, measured value) in its output line; a test that
cannot fail is not a test.
