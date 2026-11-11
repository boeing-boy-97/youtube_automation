# What is kept in the workspace

The workspace is deliberately small (~7 MB). It holds the source, the docs and the screenshots that
document them — nothing that can be regenerated in a minute.

## Kept

| Path | Why |
| --- | --- |
| `apps/`, `packages/`, `services/`, `infrastructure/`, `tests/`, `docs/` | the product itself |
| `render.yaml`, `render.pipeline.yaml`, `docker-compose*.yml`, `.env.example` | deployment definitions |
| `artifacts/ui/*.png` | the visual record referred to by `docs/VERIFICATION.md` |
| `.git/` | full history, pushed to GitHub anyway |

## Not kept (regenerate when needed)

| Path | Size | How to get it back |
| --- | --- | --- |
| `node_modules/` | ~700 MB | `npm ci` |
| `.next/` | ~50 MB | produced by `npm run dev:web` / `next build` |
| `local-storage/` | ~94 MB of uploaded and rendered test media | created on the next upload; `mkdir -p local-storage/{ws,work}` |
| `/home/user/testdata/` | 21 MB of source video, WAVs and a talking-head image | `bash scripts/make-testdata.sh` |
| `/home/user/screenshots/` | 9 MB of older UI captures | superseded by `artifacts/ui/` |
| source dumps (`clipforge-ai-code.html`, `*-source.tar.gz`) | 2.9 MB | `python3 scripts/build-code-bundle.py` |
| `dump.rdb` | 40 KB | Redis writes its own dump |

Deleting any of these breaks nothing: no test asserts on them and none is committed. `local-storage/`
and `node_modules/` are already in `.gitignore`.
