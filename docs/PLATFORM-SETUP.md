# Platform setup (Google / Meta / storage)

Official documentation consulted while implementing these connectors. Where a capability was
unclear, the integration reports *awaiting credentials* or an explicit configuration error rather
than guessing.

| Source | Consulted | What it settled |
| --- | --- | --- |
| https://developers.google.com/youtube/v3/docs/videos/insert | 2026-11-09 | `videos.insert` uses `part=snippet,status`, supports a resumable (`uploadType=resumable`) session and returns the new video id |
| https://developers.google.com/identity/protocols/oauth2/web-server | 2026-11-09 | Authorization-code flow, `access_type=offline` + `prompt=consent` for a refresh token, `state` echoed and verified |
| https://developers.google.com/youtube/terms/developer-policies | 2026-11-09 | No scraping, no credential harvesting, uploads must be user-authorised |
| https://developers.facebook.com/docs/graph-api/changelog | 2026-11-09 | Latest version is **v27.0**; v26.0 introduced 2026-07-29; v25.0 (2026-02-18) supported until 2028-07-29 |
| https://developers.facebook.com/docs/instagram-platform/content-publishing | 2026-11-09 | Container → `status_code` poll → `media_publish`; `media_type=REELS`; caption limit 2200; 100 posts / 24 h; error code 17 is a rate limit |
| https://ai.google.dev/gemini-api/docs/structured-output | 2026-11-09 | JSON schema constrained responses; `responseMimeType: application/json` |
| https://ffmpeg.org/ffmpeg-filters.html (`loudnorm`, `subtitles`, `crop`, `scale`) | 2026-11-09 | Loudness normalisation and filter-graph composition |
| https://developers.cloudflare.com/r2/api/s3/api/ | 2026-11-09 | R2 speaks the S3 API; path-style addressing via `S3_FORCE_PATH_STYLE` |

## YouTube Shorts

1. In Google Cloud Console create an OAuth 2.0 **Web application** client.
2. Authorised redirect URI: `${APP_URL}/api/accounts/youtube/callback`.
3. Enable **YouTube Data API v3**.
4. Set `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI` and restart the API.
5. In the dashboard: **Connected accounts → Connect YouTube channel**. The callback verifies the
   signed `state`, then the UI lists the authorised channels and requires you to pick exactly one —
   a channel is never guessed.
6. Enable publishing for that account and choose `PRIVATE`/`UNLISTED`/`PUBLIC` explicitly.

Scope requested: `https://www.googleapis.com/auth/youtube.upload` plus `youtube.readonly` for
channel discovery. Uploads use a resumable session; a rejected upload is classified from the API
error body (quota → retryable with backoff, invalid metadata → permanent, revoked token → auth →
re-consent).

**Assumption recorded:** Shorts eligibility is decided by YouTube; ClipForge produces 9:16 files of
15 s and 30 s and does not claim to force the Shorts surface.

## Instagram Reels

1. Create a Meta app of type *Business*, add the **Instagram** product.
2. Add the OAuth redirect: `${APP_URL}/api/accounts/instagram/callback`.
3. Request `instagram_business_basic` and `instagram_business_content_publish`.
4. Set `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_GRAPH_API_VERSION` (must be on
   the supported whitelist) and restart the API.
5. Storage must expose a **public HTTPS** URL (`STORAGE_PUBLIC_BASE_URL`, or R2/S3 public bucket):
   Meta downloads the Reel from that URL, so the file stays available for the configured asset
   retention window.
6. Connect the professional account, enable publishing, then queue clips.

Publication is: create container (`media_type=REELS`, `video_url`, `caption`, `share_to_feed`,
optional `cover_url`) → poll `status_code` until `FINISHED` (or surface `ERROR`/`EXPIRED`) →
`media_publish` → store the returned media id. An ambiguous timeout is reconciled by listing the
account's recent media before any retry, so a post is never duplicated.

**Assumption recorded:** rate-limit responses (code 17) are honoured using the
`X-Business-Use-Case-Usage` header when present and exponential backoff otherwise.

## Storage

* **Local** (`STORAGE_DRIVER=local`): verified end to end in this environment. Suitable for
  development and single-node deployments behind the same front door.
* **S3 / Cloudflare R2** (`STORAGE_DRIVER=s3`): implemented with the AWS SDK v3 and presigned URLs.
  R2 requires `S3_ENDPOINT`, `S3_REGION=auto` and `S3_FORCE_PATH_STYLE=true`. **Awaiting
  credentials** — not exercised against a live bucket.
