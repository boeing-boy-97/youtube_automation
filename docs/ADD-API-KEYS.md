# Adding the API keys later (plain language)

**Short answer: yes, you can add them later. Nothing breaks in the meantime.**

The app is built so that a missing key is *not* a crash and *not* a silent lie — the affected feature
says "not configured" and everything else keeps working.

---

## What works today, with no keys at all

| Feature | Status with no keys |
| --- | --- |
| Upload a video (chunked, checksummed, FFprobe-validated) | works |
| Transcription with real word-level timings (faster-whisper, local) | works |
| Clip selection, scoring, de-duplication, variant planning | works — but the *candidate proposals* come from the built-in fixture provider instead of a real model |
| Vertical render with burned subtitles (FFmpeg, local) | works |
| Download clips, review, edit per-platform metadata | works |
| Publish to YouTube / Instagram | refuses, with `400 PUBLISH_ELIGIBILITY_FAILED` (and says which credential is missing) |
| Cost ledger | records real render/transcription cost; no Gemini tokens because no Gemini call was made |

The fixture provider prefixes everything it returns with
`[fixture provider — no model was called]`, so a placeholder can never be mistaken for a real result.

---

## The only key that changes the product: Gemini (AI analysis)

Everything else is optional. This one turns the *content intelligence* on — real hooks, real reasons,
real per-platform titles/captions.

**When you are ready — five steps, about five minutes:**

1. Open <https://aistudio.google.com/apikey> and sign in with any Google account.
2. Click **Create API key** (a project is offered automatically; "Create API key in new project" is fine).
3. Click **Copy** next to the key. It looks like `AIza…` and is ~39 characters.
4. Open the file `.env` in the project root and fill in these four lines (the last two are already
   there but empty — set them):
   ```bash
   AI_PROVIDER=gemini
   GEMINI_API_KEY=AIza...your key...
   GEMINI_TEXT_MODEL=gemini-2.0-flash
   GEMINI_VISION_MODEL=gemini-2.0-flash
   ```
5. Restart the AI engine (in this sandbox: `bash scripts/dev-up.sh`, or just restart the
   `ai-engine` process). Then check it:
   ```bash
   curl -s http://127.0.0.1:8100/health
   # {"status":"ok","provider":"gemini","geminiConfigured":true,"testMode":false, ...}
   ```

That is all. No code change, no rebuild — the key is read from the environment at startup.

**How to tell it worked:** run one job and look at the result. Real output has no
`[fixture provider…]` prefix, and the cost ledger will show rows of kind `gemini_tokens` /
`gemini_vision_tokens` (invoices per 1M tokens).

**Cost:** the free tier is enough to try it (rate-limited). A 30-second source costs a fraction of a
cent in paid tier terms; the app records the exact amount per job in **Usage**.

---

## Optional keys — skip until you actually want auto-posting

| Key | What it unlocks | When to bother |
| --- | --- | --- |
| `YOUTUBE_CLIENT_ID` / `_SECRET` | uploading Shorts to your channel | when you want the app to post, not just download |
| `META_APP_ID` / `_SECRET` | publishing Reels to Instagram | same, and it also needs a public HTTPS URL for the video |
| `S3_*` | cloud storage instead of the local disk | when you deploy on more than one machine |

Setup for those two is in `docs/PLATFORM-SETUP.md` (with the exact redirect URIs). Two things worth
knowing before you invest the time:

- An **unaudited** Google Cloud project can only upload YouTube videos as **private** — Google locks
  it until the project passes their audit.
- Instagram publishing needs a **Business or Creator** account and a **public HTTPS** URL for the
  video file (Meta downloads it; `localhost` will not work). For local development that means a tunnel.

---

## Checking what is configured, at any time

```bash
bash scripts/check-api-keys.sh
```

It prints one line per key — `SET` or `EMPTY` — plus the consequence of each, and asks the running AI
engine what provider it is actually using. Nothing secret is printed; only whether a value exists.
