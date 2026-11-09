# Configuration

Two layers, deliberately separate.

## 1. Environment (server secrets and topology)

Read once at boot by the API (`apps/api/src/common/env.ts`, validated with Zod) and by the Python
services. A missing required variable stops the process with an explicit message; nothing falls
back to a built-in value. See `.env.example` for the full annotated list.

| Group | Variables | Notes |
| --- | --- | --- |
| Core | `APP_URL`, `ALLOWED_ORIGINS`, `TIMEZONE`, `LOG_LEVEL` | `ALLOWED_ORIGINS` is an allow-list; a single `*` wildcard per entry is supported, nothing else |
| Database | `DATABASE_URL` | PostgreSQL 17 |
| Redis | `REDIS_URL`, `REDIS_PREFIX` | Queue transport + rate limits + heartbeats |
| Secrets | `SESSION_SECRET`, `CSRF_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` | 32-byte base64 key for AES-256-GCM |
| Bootstrap | `ADMIN_BOOTSTRAP_TOKEN` | One-time token for first-run setup; rotate/remove after use |
| Storage | `STORAGE_DRIVER`, `STORAGE_LOCAL_ROOT`, `S3_*`, `STORAGE_PUBLIC_BASE_URL` | `STORAGE_PUBLIC_BASE_URL` must be public HTTPS — Meta fetches Reel files from it |
| AI service | `AI_ENGINE_URL`, `AI_ENGINE_API_KEY`, `VIDEO_PROCESSOR_URL`, `VIDEO_PROCESSOR_API_KEY` | Internal service auth |
| Gemini | `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL`, `GEMINI_VISION_MODEL` | Model ids are explicit — no alias, no default |
| YouTube | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI` | Data API v3 |
| Meta | `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_GRAPH_API_VERSION` | Version must be one of the whitelisted values (`v21.0` … `v27.0`) |

`GEMINI_*`, `YOUTUBE_*` and `META_*` may be absent: the platform still runs, and the corresponding
capability reports **awaiting credentials** in the UI and returns HTTP 428 for the operations that
need it.

## 2. Workspace configuration (business values, database-backed)

Stored per workspace in `ApplicationConfiguration` and written through the settings wizard
(`PUT /api/configuration`, audited as `CONFIG_CHANGED`). Precedence: workspace row, then global row,
then nothing — *"nothing"* means `CONFIGURATION_REQUIRED`.

| Key | Required for | Meaning |
| --- | --- | --- |
| `ai.text_model` | processing | Gemini text model id |
| `ai.vision_model` | processing | Gemini vision model id |
| `ai.max_output_clips` | processing | Upper bound on clips; the model still decides within it |
| `ai.min_quality_score` | processing | Clips below this are discarded |
| `ai.max_candidates_per_call` | — | Bounds one structured response |
| `clips.duplicate_similarity_threshold` | processing | 0–1 similarity above which a candidate is suppressed |
| `content.languages` | — | Allowed transcript languages |
| `render.output_width` / `render.output_height` | processing | Output frame, validated as 9:16 |
| `render.fps` | processing | Output frame rate |
| `render.bitrate_kbps` | processing | H.264 bitrate |
| `render.framing_mode` | processing | `center_crop` \| `face_tracking` \| `fit_with_blur` |
| `render.framing_fallback` | — | Used only when face tracking finds no face; never applied silently |
| `subtitles.preset_id` | processing | Workspace/subtitle preset id — there is no implicit style |
| `subtitles.language` | processing | Caption language |
| `audio.loudness_target_lufs` | processing | Integrated loudness target (e.g. −14) |
| `storage.provider` | processing | Must agree with `STORAGE_DRIVER` |
| `retention.source_days` / `retention.asset_days` | — | Retention windows; asset window must outlive the Meta fetch |
| `processing.max_duration_seconds` | processing | Longer sources are rejected |
| `processing.max_file_size_bytes` | processing | Enforced at initiation and re-checked |
| `processing.max_concurrent_jobs` | — | Pipeline concurrency ceiling |
| `workspace.timezone` | processing | IANA name used for schedules and log rendering |
| `publishing.youtube_visibility` | publishing | `PRIVATE` \| `UNLISTED` \| `PUBLIC` |
| `publishing.auto_enabled` | publishing | Master switch for automatic publishing |

The dashboard's **Settings** page renders exactly this list with the current value, the human hint
and the raw key, and highlights anything the API reports as missing.

## Per-account publishing configuration

Enabling publishing for an account is a second, explicit step
(`POST /api/publishing/enable`) and requires:

* the account to be connected and verified,
* an explicit privacy/visibility value for YouTube (plus category, made-for-kids, language),
* `termsAccepted: true`,
* the global publishing keys above.

Nothing is enabled by connecting an account.
