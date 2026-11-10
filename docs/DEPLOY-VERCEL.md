# Deploying ClipForge AI

## The short answer about Vercel

**Only the dashboard (`apps/web`) can run on Vercel.** The rest of the platform physically cannot,
and it is better to know that before spending a day fighting it:

| Part | Runs on Vercel? | Why |
| --- | --- | --- |
| `apps/web` (Next.js 15 dashboard) | **Yes** | built for it |
| `apps/api` (NestJS, HTTP) | No | Vercel runs serverless functions; the API holds a Redis connection pool and long request lifecycles |
| 5 BullMQ workers (`pipeline`, `render`, `publish`, `scheduler`, `recovery`) | **No** | serverless functions do not stay alive between requests, so a queue consumer never consumes |
| `services/ai-engine` (faster-whisper + Gemini) | **No** | CPU-heavy, needs ~2 GB and long execution; function limits are memory-, time- and payload-bound |
| `services/video-processor` (FFmpeg) | **No** | FFmpeg encoding for a 30 s clip takes 10–60 s of sustained CPU |
| PostgreSQL / Redis | No | use Neon / Upstash |
| File storage | No | Vercel's filesystem is read-only and ephemeral; use Cloudflare R2 / S3 |

This is not a limitation of this codebase — it is what serverless is for. The standard split is:

```
        Browser
           │
           ▼
   ┌───────────────┐        ┌──────────────────────────────┐
   │    Vercel     │ /api/* │  Render (Docker, always-on)  │
   │  apps/web     ├───────▶│  clipforge-api   :4000       │
   │  (dashboard)  │ /media │  clipforge-workers (BullMQ)  │
   └───────────────┘        │  clipforge-ai-engine   :8100 │
                            │  clipforge-video-proc. :8200 │
                            └───────┬──────────────┬───────┘
                                    │              │
                             Neon Postgres   Upstash Redis + R2 storage
```

The browser only ever talks to the Vercel origin; Next.js rewrites `/api` and `/media` to the API.
Session cookies therefore stay **first-party** — no CORS, no token in localStorage.

---

## What is already prepared in this repo

| File | Purpose |
| --- | --- |
| `apps/web/vercel.json` | pins the framework, region `bom1` (Mumbai), and security headers |
| `apps/web/next.config.ts` | fails a hosted build that has no `API_INTERNAL_URL` (the proxy target is baked in at build time — a wrong value would ship a dashboard that calls `127.0.0.1`) |
| `render.yaml` | all four backend services as a Render blueprint, using the existing Dockerfiles |
| `apps/api/scripts/run-workers.sh` | runs the five worker roles in one container and restarts them as a group |
| `UPLOAD_PART_SIZE_MIB` (new env var) | chunk size the API advertises to the browser, default 16 MiB |
| `scripts/deploy-vercel.sh` | one command: validates the API origin, builds locally with it, sets the env var and deploys |
| `apps/web/app/healthz/route.ts` | **`/healthz`** on the dashboard — reports the baked-in API origin and probes it live (`ok`, upstream status, latency, region, commit) |
| `apps/web/components/backend-down.tsx` | the screen shown when the API is unreachable, with the three settings to check and a self-check button |
| `/admin` → “Dashboard → API link” | the same probe inside the app, refreshed every 30 s |

---

## Step 1 — managed database and queue (10 min)

1. **Neon** (https://neon.tech) → create a project → copy the connection string, add
   `?sslmode=require`. This becomes `DATABASE_URL`.
2. **Upstash** (https://console.upstash.com) → create a Redis database → copy the `rediss://` URL.
   This becomes `REDIS_URL`.
3. **Cloudflare R2** (https://dash.cloudflare.com → R2) → create a bucket, an API token with
   object read/write, and note the S3 endpoint. Optional but required for Instagram publishing,
   which needs a public HTTPS URL for the video.

Run the migrations against Neon once, from your machine:

```bash
cd clipforge-ai
DATABASE_URL='postgresql://…neon…?sslmode=require' npm run db:deploy
```

## Step 2 — backend on Render (15 min)

1. Push this repository to GitHub (SSH key already configured).
2. https://dashboard.render.com → **New → Blueprint** → pick the repo. Render reads `render.yaml`
   and offers four services.
3. Fill the `sync: false` values:
   `AI_ENGINE_API_KEY` and `VIDEO_PROCESSOR_API_KEY` (generate with `openssl rand -hex 24`),
   `S3_*`, `GEMINI_API_KEY`, and `APP_URL` / `ALLOWED_ORIGINS` (you can put the Vercel URL here
   after step 3, then redeploy the API).
4. Apply. Wait for `clipforge-api`, `clipforge-ai-engine` and `clipforge-video-processor` to report
   healthy, and for `clipforge-workers` to log `started pipeline worker …` five times.
5. Note the API URL, e.g. `https://clipforge-api.onrender.com`. Check it:
   ```bash
   curl -s https://clipforge-api.onrender.com/api/system/health
   ```

### What "backend deployed" costs, honestly

| Goal | What you need | Monthly |
| --- | --- | --- |
| Build goes green, dashboard loads, sign-in works | API only (`clipforge-api`) + free Neon + free Upstash | $0 (instance sleeps; first request ~30 s) |
| Upload → transcript → clip → download actually runs | + `clipforge-workers`, `clipforge-ai-engine`, `clipforge-video-processor` | ~$7–21 depending on instance sizes |
| Media survives a redeploy | + Cloudflare R2 (`STORAGE_DRIVER=s3`) | ~$0 at demo volume |

Without the workers the pipeline stalls at `QUEUED` by design — the API does not fake progress. For a
first demo you can run `STORAGE_DRIVER=local` with `WORK_DIR=/tmp/clipforge`, understanding that
uploads disappear on the next deploy.

**Note on plans:** Render's free instance type sleeps after 15 minutes and does not include
background workers. `starter` for the API/workers and `standard` for the two Python services is the
honest minimum for a working pipeline.

## Step 3 — dashboard on Vercel (5 min)

### Option A — one command

```bash
cd clipforge-ai
./scripts/deploy-vercel.sh https://clipforge-api.onrender.com          # preflight, build, then print the steps
./scripts/deploy-vercel.sh https://clipforge-api.onrender.com --deploy # same, then `vercel --prod`
```

It refuses a localhost/`http` origin, refuses a dead API (it curls `/api/system/health` first), runs
a real `next build` with that origin before spending a deploy, and finally prints the two API-side
variables you still have to set. Without the Vercel CLI it prints the dashboard clicks below instead.

### Option B — Vercel dashboard (no CLI)

1. https://vercel.com/new → import the same repository.
2. **Root Directory: `apps/web`** ← the one setting people get wrong. Vercel then detects Next.js
   and installs from the repository root automatically.
3. **Environment Variables** (Production *and* Preview *and* Development):

   | Name | Value | When it is read |
   | --- | --- | --- |
   | `API_INTERNAL_URL` | `https://clipforge-api.onrender.com` | **build time** — baked into the `/api` and `/media` rewrites |
   | `NEXT_PUBLIC_APP_NAME` | `ClipForge AI` (optional) | build + runtime |

   Firebase needs **nothing** on Vercel: the login page asks the API for the public web config at
   runtime (`GET /api/auth/providers`). Put the `FIREBASE_*` service-account values on the API
   instead — `docs/FIREBASE-AUTH.md` steps 5–9.

4. Deploy. The build fails on purpose if `API_INTERNAL_URL` is missing or points at localhost —
   that is the guard doing its job.
5. Copy the deployment URL (e.g. `https://youtube-automation.vercel.app`) and put it into the Render
   API service as `APP_URL` **and** `ALLOWED_ORIGINS`, then redeploy the API. Until you do, the API
   rejects the dashboard's `Origin` header (CSRF/origin checks are strict by design).
6. Open `https://<your-app>.vercel.app/healthz`. `ok:true` with `upstream.status 200` means the
   proxy works; `ok:false` names the origin it tried, so the fix is one env var, not a hunt.

## Step 4 — first run

1. Open the Vercel URL → the app asks for the bootstrap token.
2. On Render, read `ADMIN_BOOTSTRAP_TOKEN` from the API service's environment (it was generated).
3. Create the admin account, then go to **Configuration** and fill the workspace settings
   (the setup screen lists every missing key; nothing is silently defaulted).
4. Upload a short MP4, wait for the pipeline, download the vertical clip.

## Step 5 — verification checklist

```bash
curl -s https://clipforge-api.onrender.com/api/system/health      # status ok, postgres + redis healthy
curl -s https://clipforge-api.onrender.com/api/system/readiness   # every dependency + worker roles
curl -sI https://<your-app>.vercel.app/                           # 200, security headers present
```

In the dashboard: login works, **System** shows five live workers, an upload reaches `COMPLETED`
with 2 clips, the clip downloads over `/media/…` (Range requests supported).

---

## When the dashboard is live but nothing works

The dashboard now diagnoses this instead of logging you out. Three places say the same thing:

| Where | What it tells you |
| --- | --- |
| `https://<app>.vercel.app/healthz` | the API origin baked into the build, whether it answered, how fast, and the Vercel region/commit |
| the login page / any page | “This dashboard cannot reach its API” with the failed response and a **Run self-check** button — never a login form that cannot succeed |
| `/admin` → “Dashboard → API link” | the same probe for operators, refreshed every 30 s |

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/healthz` → `ok:false`, `upstream.error: "fetch failed"` | API down, or `API_INTERNAL_URL` wrong/typo'd | start the API; correct the env var **and redeploy** (it is read at build time) |
| `/healthz` → 200, but sign-in returns 403 `CSRF_FAILED` | `APP_URL` / `ALLOWED_ORIGINS` on the API do not match the Vercel domain | set both to the exact Vercel origin, restart the API |
| `/healthz` → 200, sign-in 401 for a correct password | API was bootstrapped with different data, or login rate-limit (10 per 300 s) | check the API logs; wait out the limiter |
| build fails with “API_INTERNAL_URL is missing or unusable” | the env var is missing, set to `http://localhost:4000`, or not a URL | the build log now prints the exact clicks: Settings → Environment Variables → add `API_INTERNAL_URL` for **Production, Preview and Development** → then **redeploy** (the value is frozen at build time, editing it alone changes nothing) |
| build succeeded but every page says “cannot reach its API” | the variable points at a host that is not running (a placeholder, or the API is asleep) | open `https://<app>/healthz` — it names the origin and the failure; fix the variable and redeploy |
| images/video break but the UI is fine | `/media` rewrite target wrong, or `STORAGE_DRIVER=local` on the API | use `STORAGE_DRIVER=s3` + `S3_PUBLIC_BASE_URL` on a hosted API |

## Gotchas that bite in production

| Issue | What happens | Fix |
| --- | --- | --- |
| Vercel function payload cap (4.5 MB) | `413 FUNCTION_PAYLOAD_TOO_LARGE` on upload parts | the proxy here is a routing-level rewrite, not a function; if you add middleware that touches `/api`, bodies get buffered by a function. As a safety valve set `UPLOAD_PART_SIZE_MIB=3` on the API (local/R2 only — **S3/R2 multipart parts must be ≥ 5 MiB**, so with R2 keep 16 and do not put middleware in front of uploads) |
| `API_INTERNAL_URL` changed | rewrites are baked at build time | change the env var **and** redeploy the Vercel project |
| Wrong `Origin` | `403 CSRF_FAILED` on every POST | `APP_URL`/`ALLOWED_ORIGINS` on Render must equal the Vercel URL exactly (scheme + host, no trailing slash) |
| Local storage on a hosted API | uploads vanish on the next deploy | `STORAGE_DRIVER=s3` |
| `WORK_DIR` on a container | `/app/...` is ephemeral and may be read-only | point it at `/tmp/clipforge/...` (already set in `render.yaml`) |
| Instagram publishing | Meta cannot fetch `http://…` | set `S3_PUBLIC_BASE_URL` to a public HTTPS bucket domain |
| Vercel Hobby plan | non-commercial use only | upgrade to Pro for a commercial deployment |

## If you want everything on one platform instead

Vercel can be skipped entirely: `docker-compose.prod.yml` already defines the web container behind
Caddy (TLS, HTTP/3) plus API, workers, both Python services, Postgres and Redis. One VPS with Docker
runs the whole thing, with no cold starts and no payload caps. The only thing you give up is
Vercel's preview deployments.
