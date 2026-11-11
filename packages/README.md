# packages/ — code shared by more than one app

Nothing here runs on its own. A package exists only because `apps/api`, `apps/web` and the Python
services would otherwise duplicate it. If a package is used by exactly one consumer, it belongs in
that consumer instead.

| Package | Owns | Imported by |
| --- | --- | --- |
| `database` | Prisma schema and migrations, the generated client, transactions, repositories, field crypto | `apps/api` |
| `shared-types` | enums, the job/clip state machine, config keys, API response shapes | `apps/api`, `apps/web`, `platform-connectors` |
| `validation` | every zod schema for a request or response body | `apps/api`, `apps/web` |
| `platform-connectors` | YouTube and Instagram clients plus their error classification | `apps/api` |

Rules:

1. **Types and schemas are shared; behaviour is not.** A package may not import from `apps/` or
   `services/` — the dependency arrow only ever points down into `packages/`.
2. **No I/O at import time.** No database connection, no `fetch`, no reading of environment
   variables when the module loads; pass configuration in.
3. **Build before consuming.** `npm run build:packages` compiles these to `dist/`; the root `build`
   and `typecheck` scripts do that for you in dependency order.
4. **One public entry point.** Everything a consumer may use is re-exported from `src/index.ts`;
   deep imports into `dist/` are a bug.
