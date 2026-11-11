#!/usr/bin/env python3
"""End-to-end verification of the Telegram notification system against the live stack.

What makes this an end-to-end test and not a mock: the API is a real process reading real
PostgreSQL, the notification is triggered by a real HTTP call that creates a real job row, and the
only substitute is api.telegram.org — replaced by a local HTTP server (started here) that records
what the Bot API would have received.

No browser is involved at any point, which is precisely the property being tested: notifications
are produced by the backend, so they arrive whether or not anyone has the dashboard open.

Run the stack first (see docs/TELEGRAM-NOTIFICATIONS.md), then:

    .venv/bin/python tests/e2e/telegram_notifications.py

Exit code 0 means every check passed.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import (  # noqa: E402
    ADMIN,
    API,
    DATABASE_URL,
    Client,
    Results,
    flush_login_ratelimit,
    flush_rate_limits,
    multipart,
    sql,
)

FAKE_TELEGRAM_PORT = int(os.environ.get("FAKE_TELEGRAM_PORT", "8099"))
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "-1001234567890")
SOURCE = Path(os.environ.get("NOTIFICATION_SOURCE", "/home/user/testdata/light-source.mp4"))
results = Results()


# --------------------------------------------------------------------------- fake Telegram
class FakeTelegram:
    """Records what the Bot API would have received; answers like the real one."""

    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.failures_remaining = 0
        self.lock = threading.Lock()
        self.server: ThreadingHTTPServer | None = None

    def start(self) -> None:
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:  # silence the default stderr access log
                return

            def do_GET(self) -> None:
                self._respond()

            def do_POST(self) -> None:
                self._respond()

            def _respond(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length).decode() if length else "{}"
                method = self.path.rstrip("/").split("/")[-1]
                body = json.loads(raw or "{}")
                with recorder.lock:
                    if method == "getMe":
                        payload = {"ok": True, "result": {"id": 8123456789, "username": "clipforge_e2e_bot", "first_name": "ClipForge"}}
                    else:
                        recorder.messages.append({"method": method, **body})
                        if recorder.failures_remaining > 0:
                            recorder.failures_remaining -= 1
                            payload = {"ok": False, "description": "Internal Server Error"}
                            status = 500
                            self.send_response(status)
                            self.send_header("content-type", "application/json")
                            self.end_headers()
                            self.wfile.write(json.dumps(payload).encode())
                            return
                        payload = {"ok": True, "result": {"message_id": 1000 + len(recorder.messages), "chat": {"id": body.get("chat_id")}}}
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", FAKE_TELEGRAM_PORT), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        if self.server:
            self.server.shutdown()

    def reset(self) -> None:
        with self.lock:
            self.messages.clear()
            self.failures_remaining = 0

    def texts(self) -> list[str]:
        with self.lock:
            return [str(message.get("text", "")) for message in self.messages]

    def wait_for(self, needle: str, timeout: float = 45.0) -> str | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for text in self.texts():
                if needle in text:
                    return text
            time.sleep(0.25)
        return None


telegram = FakeTelegram()


# --------------------------------------------------------------------------- helpers
def admin_client() -> Client:
    """Logs in, creating the first administrator first when the database is brand new."""
    # Scripted logins from one IP trip the login rate limiter, which is working as designed.
    flush_rate_limits()
    flush_login_ratelimit()
    client = Client()
    status = client.login(*ADMIN)
    if status in (200, 201):
        return client
    if status == 429:
        time.sleep(2)
        flush_login_ratelimit()
        status = client.login(*ADMIN)
        if status in (200, 201):
            return client
    token = os.environ.get("ADMIN_BOOTSTRAP_TOKEN", "")
    if not token:
        raise AssertionError(f"admin login failed ({status}) and ADMIN_BOOTSTRAP_TOKEN is not set")
    status, body = client.post(
        "/api/auth/bootstrap",
        {
            "bootstrapToken": token,
            "email": ADMIN[0],
            "password": ADMIN[1],
            "displayName": "ClipForge Admin",
            "workspaceName": "ClipForge Demo",
        },
    )
    # 409 means someone already bootstrapped this database: clear the limiter and log in.
    assert status in (200, 201, 409), f"bootstrap failed: {status} {body}"
    flush_login_ratelimit()
    status = client.login(*ADMIN)
    assert status in (200, 201), f"admin login after bootstrap failed: {status}"
    return client


def ensure_configuration(client: Client) -> None:
    """A brand-new database has no workspace configuration; the setup wizard writes it through the
    same two endpoints used here, so this is the real path, not a database shortcut."""
    status, config = client.get("/api/configuration")
    assert status == 200, f"configuration read failed: {status}"
    if not config.get("missingForProcessing"):
        return
    presets = config.get("subtitlePresets") or []
    if presets:
        preset_id = presets[0]["id"]
    else:
        status, preset = client.post(
            "/api/subtitle-presets",
            {
                "name": "E2E Bold",
                "style": {
                    "fontFamily": "DejaVu Sans",
                    "fontSizePx": 48,
                    "fontWeight": 800,
                    "primaryColor": "#ffffff",
                    "highlightColor": "#ffd400",
                    "outlineColor": "#000000",
                    "outlineWidth": 3,
                    "shadow": 1,
                    "position": "lower-third",
                    "safeMarginXPx": 60,
                    "safeMarginBottomPx": 180,
                    "backgroundOpacity": 0,
                    "uppercase": True,
                    "maxCharsPerLine": 22,
                    "maxLines": 2,
                },
            },
        )
        assert status < 300, f"preset create failed: {status} {preset}"
        preset_id = preset["id"]
    status, body = client.put(
        "/api/configuration",
        {
            "entries": [
                {"key": "ai.text_model", "value": "gemini-2.0-flash"},
                {"key": "ai.vision_model", "value": "gemini-2.0-flash"},
                {"key": "ai.max_output_clips", "value": 3},
                {"key": "ai.min_quality_score", "value": 40},
                {"key": "processing.max_duration_seconds", "value": 1800},
                {"key": "processing.max_file_size_bytes", "value": 524288000},
                {"key": "render.output_width", "value": 1080},
                {"key": "render.output_height", "value": 1920},
                {"key": "render.fps", "value": 30},
                {"key": "render.bitrate_kbps", "value": 6000},
                {"key": "render.framing_mode", "value": "center_crop"},
                {"key": "subtitles.preset_id", "value": preset_id},
                {"key": "subtitles.language", "value": "en"},
                {"key": "storage.provider", "value": "local"},
                {"key": "workspace.timezone", "value": "Asia/Kolkata"},
                {"key": "clips.duplicate_similarity_threshold", "value": 0.87},
                {"key": "audio.loudness_target_lufs", "value": -14},
                {"key": "publishing.auto_enabled", "value": False},
                {"key": "publishing.youtube_visibility", "value": "PRIVATE"},
            ]
        },
    )
    assert status < 300, f"configuration write failed: {status} {body}"


def upload_source(client: Client, path: Path) -> dict:
    data = path.read_bytes()
    status, initiation = client.post(
        "/api/sources/upload/initiate", {"fileName": path.name, "mimeType": "video/mp4", "sizeBytes": len(data)}
    )
    assert status < 300, f"initiate failed: {status} {initiation}"
    source_id = initiation["sourceVideoId"]
    part_size = initiation["partSizeBytes"]
    for index in range(0, len(data), part_size):
        body, content_type = multipart({}, "chunk", "part.bin", data[index : index + part_size])
        status, payload = client.request(
            "POST",
            f"/api/sources/upload/part?sourceVideoId={source_id}&partNumber={index // part_size + 1}",
            headers={"content-type": content_type},
            raw=body,
        )
        assert status < 300, f"part failed: {status} {payload}"
    status, complete = client.post(
        "/api/sources/upload/complete",
        {
            "sourceVideoId": source_id,
            "rightsDeclaration": {
                "accepted": True,
                "statement": "I own this recording or hold a licence that permits repurposing and publishing clips of it.",
            },
        },
    )
    assert status < 300, f"complete failed: {status} {complete}"
    return complete


def create_job(client: Client, source_id: str) -> tuple[int, dict]:
    status, config = client.get("/api/configuration")
    assert status == 200, f"configuration read failed: {status}"
    preset = config["subtitlePresets"][0]["id"]
    return client.post(
        "/api/jobs",
        {
            "sourceVideoId": source_id,
            "configuration": {
                "framingMode": "center_crop",
                "framingFallback": "center_crop",
                "subtitlePresetId": preset,
                "subtitleLanguage": "en",
                "contentLanguages": ["en"],
                "targetDurations": [15, 30],
                "maxClips": 2,
                "minQualityScore": 40,
                "autoPublish": False,
                "platforms": [],
            },
        },
    )


def history(client: Client, category: str | None = None) -> list[dict]:
    query = "/api/notifications/history?page=1&pageSize=50" + (f"&category={category}" if category else "")
    status, body = client.get(query)
    assert status == 200, f"history failed: {status} {body}"
    return body["items"]


def wait_for_delivery(client: Client, category: str, timeout: float = 30.0) -> dict | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for row in history(client, category):
            if row["status"] == "SENT":
                return row
        time.sleep(0.5)
    return None


# --------------------------------------------------------------------------- scenarios
def scenario_connection(client: Client) -> None:
    print("\n=== 1. Telegram connection and status surface")
    client.put("/api/notifications/settings", {"enabled": True, "chatId": CHAT_ID, "categories": [
        "WORKFLOW_STARTED", "SOURCE_DETECTED", "SOURCE_DOWNLOADED", "AI_STARTED", "AI_COMPLETED",
        "METADATA_COMPLETED", "UPLOAD_STARTED", "PUBLISH_COMPLETED", "WORKFLOW_FAILED",
        "AUTH_EXPIRED", "QUOTA_ERROR", "SCHEDULED_STARTED", "SCHEDULE_MISSED",
        "WORKFLOW_STOPPED", "DAILY_SUMMARY", "CONNECTION_TEST",
    ]})
    status, body = client.get("/api/notifications/status")
    results.check("status endpoint answers", status == 200, f"{status} {body if status != 200 else ''}")
    results.check("bot token reported as configured", body.get("tokenConfigured") is True, str(body.get("tokenConfigured")))
    results.check("bot identity resolved through getMe", body.get("bot", {}).get("username") == "clipforge_e2e_bot", str(body.get("bot")))
    results.check("chat id is masked, never returned in full", body.get("chatIdMasked") == "-••••7890", str(body.get("chatIdMasked")))
    results.check("can send", body.get("canSend") is True, str(body.get("blockingReason")))

    status, sent = client.post("/api/notifications/test", {"note": "E2E connection test"})
    results.check("test message delivered", status in (200, 201) and sent.get("delivered") is True, f"{status} {sent}")
    text = telegram.wait_for("E2E connection test", 10)
    results.check("test message reached the Bot API", text is not None, text or "no message captured")
    results.check(
        "test message carries the requesting operator and chat",
        bool(text) and ("admin@clipforge.local" in text and "7890" in text),
        (text or "")[:200],
    )


def scenario_workflow(client: Client) -> None:
    print("\n=== 2. Workflow started (BACKEND EVENT, no browser involved)")
    telegram.reset()
    if not SOURCE.exists():
        results.check("source fixture exists", False, f"missing {SOURCE} — run scripts/make-testdata.sh")
        return
    ensure_configuration(client)
    source = upload_source(client, SOURCE)
    status, job = create_job(client, source["id"])
    results.check("job created", status in (200, 201), f"{status} {job if status >= 300 else ''}")
    if status >= 300:
        return
    job_id = job["id"]
    text = telegram.wait_for("Workflow queued", 30)
    results.check("WORKFLOW_STARTED sent to Telegram", text is not None, text or "not received")
    results.check("message carries the execution id", bool(text) and job_id[:8] in text, (text or "")[:200])

    row = wait_for_delivery(client, "WORKFLOW_STARTED")
    results.check("delivery logged as SENT", row is not None, json.dumps(row)[:200] if row else "no row")
    results.check("delivery row references the job", bool(row) and row.get("jobId") == job_id, str(row.get("jobId") if row else None))

    # ------------------------------------------------ duplicate prevention (live)
    # The worker retries and the outbox relay redeliver the same event; the unique dedupe key is
    # what stops a second message. Waiting out a redelivery window proves the live behaviour.
    time.sleep(3)
    rows = [row for row in history(client, "WORKFLOW_STARTED") if row.get("jobId") == job_id]
    results.check("exactly one WORKFLOW_STARTED delivery for this job", len(rows) == 1, f"{len(rows)} rows")

    print("\n=== 3. Workflow stopped manually")
    telegram.reset()
    # A job can only be cancelled while it is still running. On a stack where the AI provider is not
    # configured the pipeline fails within a second, so a single attempt would test the race rather
    # than cancellation: retry with a fresh job until one is still live (bounded).
    status, detail = 0, ""
    for attempt in range(1, 4):
        status, body = client.post(f"/api/jobs/{job_id}/cancel", {})
        if status in (200, 201):
            break
        detail = f"attempt {attempt}: {status} {json.dumps(body)[:120] if body else ''}"
        status, live = create_job(client, source["id"])
        if status in (200, 201):
            job_id = live["id"]
            time.sleep(0.2)
    results.check("cancel accepted", status in (200, 201), detail or str(status))
    text = telegram.wait_for("Workflow stopped", 20)
    results.check("WORKFLOW_STOPPED sent", text is not None, text or "not received")
    results.check("stop message names the actor", bool(text) and "admin@clipforge.local" in text, (text or "")[:200])


def scenario_failure(client: Client) -> None:
    print("\n=== 4. Workflow failure (worker-detected, with execution id)")
    telegram.reset()
    # A job whose source file is gone fails inside the pipeline worker: the AI engine is never
    # reached, so this exercises the worker's own failure path.
    if not SOURCE.exists():
        results.check("source fixture exists", False, "skipped")
        return
    ensure_configuration(client)
    ensure_configuration(client)
    source = upload_source(client, SOURCE)
    status, job = create_job(client, source["id"])
    if status >= 300:
        results.check("job created for failure test", False, f"{status} {job}")
        return
    job_id = job["id"]
    sql(f"UPDATE \"SourceVideo\" SET \"storageKey\" = NULL WHERE \"id\" = '{source['id']}'")
    text = telegram.wait_for("Workflow failed", 240)
    results.check("WORKFLOW_FAILED sent by the worker", text is not None, (text or "not received after 240s — is the pipeline worker running?")[:300])
    if text:
        results.check("failure message carries the execution id", job_id[:8] in text, text[:200])
        results.check("failure message carries a reason", ("Failed" in text) or ("failed" in text), text[:200])
    row = wait_for_delivery(client, "WORKFLOW_FAILED", 10)
    results.check("failure delivery logged", row is not None, json.dumps(row)[:200] if row else "none")


def scenario_retry(client: Client) -> None:
    print("\n=== 5. Temporary Telegram outage: retry with backoff, then success")
    telegram.reset()
    with telegram.lock:
        telegram.failures_remaining = 2  # two 500s, then the real send succeeds
    status, sent = client.post("/api/notifications/test", {"note": "E2E retry check"})
    results.check("test still reports a result after two failures", status in (200, 201), f"{status} {sent}")
    results.check("message eventually delivered", sent.get("delivered") is True, json.dumps(sent))
    results.check("attempt count proves the retries", sent.get("attempts", 0) >= 3, str(sent.get("attempts")))
    row = next((r for r in history(client, "CONNECTION_TEST") if "E2E retry check" in r["message"]), None)
    results.check("delivery logged with attempts", bool(row) and row["attempts"] >= 3, json.dumps(row)[:200] if row else "none")


def scenario_restart(client: Client) -> None:
    print("\n=== 6. Backend restart and recovery")
    # Leave a PENDING row behind, as a crash between insert and send would.
    token = uuid.uuid4().hex[:12]
    sql(
        "INSERT INTO \"NotificationDelivery\" (id, \"workspaceId\", category, status, \"dedupeKey\", message, attempts, \"createdAt\") "
        "SELECT gen_random_uuid(), w.id, 'WORKFLOW_STARTED', 'PENDING', 'restart:" + token + "', '<b>pending before restart</b>', 0, now() - interval '30 seconds' "
        "FROM \"Workspace\" w LIMIT 1"
    )
    pending = sql("SELECT count(*) FROM \"NotificationDelivery\" WHERE status = 'PENDING'")
    results.check("a PENDING row exists before the restart", pending.strip() not in ("", "0"), pending.strip())

    print("   restarting the API…")
    subprocess.run(["pkill", "-f", "apps/api/dist/main.js"], check=False)
    time.sleep(3)
    started = subprocess.Popen(
        # Same command an operator uses: load .env, then start the compiled API.
        ["bash", "-lc", "set -a && . ./.env && set +a && exec node apps/api/dist/main.js"],
        cwd=str(Path(__file__).resolve().parents[2]),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    deadline = time.time() + 90
    ready = False
    while time.time() < deadline:
        try:
            status, _ = client.get("/api/system/health")
            if status == 200:
                ready = True
                break
        except OSError:
            pass
        time.sleep(1)
    results.check("API back up after restart", ready, "healthy" if ready else "did not become healthy in 90s")
    assert started.poll() is None or ready

    client.refresh_csrf()
    attempts = 0
    delivered = False
    while attempts < 20 and not delivered:
        delivered = sql("SELECT status FROM \"NotificationDelivery\" WHERE \"dedupeKey\" = 'restart:" + token + "'").strip() == "SENT"
        attempts += 1
        time.sleep(1)
    results.check(
        "interrupted delivery recovered on boot",
        delivered,
        "PENDING row was delivered after boot"
        if delivered
        else "still not SENT after 20s: " + sql("SELECT status FROM \"NotificationDelivery\" WHERE \"dedupeKey\" = 'restart:" + token + "'").strip(),
    )
    status, body = client.get("/api/notifications/status")
    results.check("status survives the restart", status == 200 and body.get("lastDeliveryAt") is not None, f"{status}")
    rows_after = history(client)
    results.check("history survives the restart", len(rows_after) > 0, f"{len(rows_after)} rows")


def scenario_frontend_closed(client: Client) -> None:
    print("\n=== 7. Delivery with no frontend attached")
    telegram.reset()
    # Nothing in this suite ever opens the dashboard. The API call below is made directly, and the
    # message must still arrive: the notification is produced by the backend, not by the page.
    status, _ = client.post("/api/notifications/test", {"note": "E2E no-frontend check"})
    text = telegram.wait_for("E2E no-frontend check", 15)
    results.check("delivered with no browser session", status in (200, 201) and text is not None, text or "not received")

    print("\n=== 8. The enabled toggle governs automation events")
    # A manual test is deliberately exempt from the toggle: verifying credentials before turning
    # the channel on is the whole point of the button. Automation events are what must obey it.
    telegram.reset()
    client.put("/api/notifications/settings", {"enabled": False})
    status, _ = client.post("/api/notifications/test", {"note": "manual test while disabled"})
    results.check(
        "manual test still works while disabled (it is how you verify config)",
        telegram.wait_for("manual test while disabled", 10) is not None,
        "no message",
    )

    telegram.reset()
    source = upload_source(client, SOURCE)
    status, job = create_job(client, source["id"])
    quiet_job = job.get("id") if status < 300 else None
    suppressed = telegram.wait_for("Workflow queued", 8) is None
    results.check("disabled toggle suppresses a real workflow event", suppressed, "a workflow message was sent while disabled")
    if quiet_job:
        rows = [row for row in history(client, "WORKFLOW_STARTED") if row.get("jobId") == quiet_job]
        results.check("suppressed event leaves no delivery row", len(rows) == 0, f"{len(rows)} rows")

    status, body = client.get("/api/notifications/status")
    results.check(
        "status explains why nothing is sent",
        body.get("canSend") is False and bool(body.get("blockingReason")),
        str(body.get("blockingReason")),
    )

    # Re-enable: the next real event flows again, proving the toggle is the only switch.
    telegram.reset()
    client.put("/api/notifications/settings", {"enabled": True})
    source = upload_source(client, SOURCE)
    status, job = create_job(client, source["id"])
    text = telegram.wait_for("Workflow queued", 20)
    results.check("re-enabling restores delivery for the next event", text is not None, text or "not received")
    if job.get("id"):
        client.post(f"/api/jobs/{job['id']}/cancel", {})


def main() -> int:
    telegram.start()
    print(f"fake Bot API listening on 127.0.0.1:{FAKE_TELEGRAM_PORT} · API {API} · chat {CHAT_ID}")
    try:
        status, health = None, None
        client = admin_client()
        scenario_connection(client)
        scenario_workflow(client)
        scenario_failure(client)
        scenario_retry(client)
        scenario_restart(client)
        scenario_frontend_closed(client)
    finally:
        telegram.stop()
    return results.report()


if __name__ == "__main__":
    sys.exit(main())
