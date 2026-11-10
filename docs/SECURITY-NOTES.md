# Dependency security notes

Measured with `npm audit` against the committed lockfile. Re-run and re-date this file whenever the
lockfile moves; a stale advisory list is worse than none.

```
npm audit --json | jq '.metadata.vulnerabilities'
```

## Current position — 2026-11-09

| Severity | Count | Where it comes from |
| --- | --- | --- |
| critical | 3 | `vitest` → `tinypool`, `@aws-sdk/core` → `fast-xml-parser` |
| high | 12 | `express`/`@nestjs/platform-express` → `body-parser`, `multer`, `path-to-regexp`; `@nestjs/swagger` → `js-yaml`, `lodash`; `zod`; `nodemailer`; `postcss`; `vite` |
| moderate | 29 | transitive, mostly dev-server and framework internals |
| low | 2 | transitive |

## What was fixed rather than accepted

- `compression` was installed at `1.7.5`; the lockfile now resolves **1.8.2**, which carries the fix
  for the premature-close memory leak. Verified: `node -p "require('compression/package.json').version"`.
- `npm audit fix` (non-breaking) was applied and the tree re-verified end to end afterwards — a
  dependency bump that is not followed by the full suite is not a fix.
- `path-to-regexp` and `body-parser` advisories need **major** versions of *different* parents
  (`express` 5, `nest` 11). Overriding them under Express 4 breaks routing and body parsing
  silently, so they were deliberately not forced. `@nestjs/core` (routing) and
  `@nestjs/swagger` ship `path-to-regexp@3.3.0`, not the vulnerable 0.1.x line, and the
  `0.1.12` copy is only reachable through Express's own router.

## Accepted risk, with the reason

Every remaining advisory falls into one of three buckets. None of them is reachable with attacker
input in this architecture, and each has a concrete mitigation already in the code:

1. **Dev-only tooling** — `vitest`, `vite`, `tinypool`, `postcss` (build), `nodemailer` (unused at
   runtime unless SMTP is configured). These never ship to the API container: the production image
   installs `--omit=dev`. The `vitest` advisory requires exposing the Vitest API server on a network
   interface; tests run headless in CI.
2. **Denial of service on request bodies** — `body-parser`, `multer`, `fast-xml-parser`. Mitigated by
   the API's global `2 MB` JSON/urlencoded limit, per-route upload part caps
   (`UPLOAD_PART_SIZE_MIB`, hard range 1–64), Redis-backed rate limits (login 10/300 s, job create
   10/60 s), and the fact that no XML is parsed anywhere in the request path. `fast-xml-parser` is
   only used inside `@aws-sdk` for S3 XML responses, which come from a bucket we control.
3. **Prototype pollution / template injection** — `lodash`, `js-yaml`. Neither is called with
   user-supplied templates or YAML. `lodash` is pulled in by `@nestjs/swagger`'s UI bundler, and
   `js-yaml` parses the Swagger documents we generate ourselves.

## The upgrade queue (planned, not rushed)

| Package | Current | Fix requires | Why it is a project, not a bump |
| --- | --- | --- | --- |
| `express` / `@nestjs/platform-express` | 4.21.2 / 10.4.15 | Express 5 + Nest 11 | Route wildcard syntax, error-handler signatures and `@types/express` 5 change together |
| `fast-xml-parser` | 4.4.1 (via AWS SDK) | 5.6.1 | Pinned by `@aws-sdk/core`; needs an SDK bump to 3.8xx+ |
| `zod` | 3.24.1 | 4.6.6+ | v4 changes error shape and `.strict()` semantics; every DTO and shared schema must be revisited |
| `vitest` / `vite` | 2.1.8 / 5.4.21 | vitest 4 / vite 7 | Test config, coverage and mocking APIs change |

Each of these lands as its own change with the full suite re-run, not as a drive-by lockfile edit.

## Standing rules

- `npm audit fix --force` is never run against this repository: it rewrites majors and has already
  been shown to break the tree here (extraneous/invalid packages). Fixes go through explicit bumps.
- After any dependency change, run, in order: `tsc` for all six workspaces → `npm run test:unit` →
  `npm run test:integration` → `npm run test:python` → `npm run test:e2e` →
  `tests/e2e/scenarios.py` → `tests/e2e/ui_responsive.py`.
- The lockfile is committed. A sandbox install with `--omit=optional` needs
  `npm i --no-save @rollup/rollup-linux-x64-gnu @esbuild/linux-x64` before Vitest can run, because
  Rollup and esbuild ship platform binaries as optional dependencies.
