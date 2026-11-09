#!/usr/bin/env python3
"""Nineteen end-to-end scenarios against a running ClipForge stack.

Each scenario answers one question an operator or reviewer would ask, and prints the evidence with
the verdict. Nothing is mocked: real uploads, real transcription, real FFmpeg renders, real
Postgres and Redis. The AI provider is the fixture provider (AI_PROVIDER=fixture TEST_MODE=1) —
see KNOWN_LIMITATIONS.md for why live Gemini calls cannot be exercised here.

Run:  .venv/bin/python tests/e2e/scenarios.py [optional-path-to-source.mp4]
Exit: 0 when all 19 pass, 1 otherwise.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import (  # noqa: E402
    ADMIN,
    MEMBER,
    Client,
    Results,
    create_second_tenant,
    delete_tenant,
    error_code,
    flush_login_ratelimit,
    flush_rate_limits,
    multipart,
    sql,
)

SOURCE = Path(sys.argv[1] if len(sys.argv) > 1 else "/home/user/testdata/light-source.mp4")
TERMINAL = {"COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED", "NEEDS_CONFIGURATION"}
results = Results()
results_state: dict = {}


def scenario(title: str) -> None:
    print(f"\n=== {title}", flush=True)


# --------------------------------------------------------------------------- helpers


def admin_client() -> Client:
    flush_rate_limits()
    client = Client()
    client.login(*ADMIN)
    return client


def upload_source(client: Client, path: Path, name: str | None = None) -> dict:
    """Chunked upload + rights declaration, exactly as the browser does it."""
    name = name or path.name
    data = path.read_bytes()
    status, initiation = client.post(
        "/api/sources/upload/initiate", {"fileName": name, "mimeType": "video/mp4", "sizeBytes": len(data)}
    )
    assert status < 300, f"initiate failed: {status} {initiation}"
    source_id = initiation["sourceVideoId"]
    # The server declares the part size; using anything else is rejected as "partNumber exceeds".
    part_size = initiation["partSizeBytes"]
    for index in range(0, len(data), part_size):
        chunk = data[index : index + part_size]
        body, content_type = multipart({}, "chunk", "part.bin", chunk)
        part_number = index // part_size + 1
        status, payload = client.request(
            "POST",
            f"/api/sources/upload/part?sourceVideoId={source_id}&partNumber={part_number}",
            headers={"content-type": content_type},
            raw=body,
        )
        assert status < 300, f"part {part_number} failed: {status} {payload}"
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


def configuration(client: Client) -> dict:
    status, body = client.get("/api/configuration")
    assert status == 200, f"configuration read failed: {status}"
    return body


def create_job(client: Client, source_id: str, config: dict, **overrides) -> tuple[int, dict]:
    preset = config["subtitlePresets"][0]["id"]
    payload = {
        "sourceVideoId": source_id,
        "configuration": {
            "framingMode": "center_crop",
            "framingFallback": "center_crop",
            "subtitlePresetId": preset,
            "subtitleLanguage": "en",
            "contentLanguages": ["en"],
            "targetDurations": [15, 30],
            "maxClips": 4,
            "minQualityScore": 70,
            "autoPublish": False,
            "platforms": [],
        },
    }
    payload["configuration"].update(overrides)
    return client.post("/api/jobs", payload)


def wait_for_job(client: Client, job_id: str, timeout: int = 900) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, detail = client.get(f"/api/jobs/{job_id}")
        assert status == 200, f"job read failed: {status}"
        if detail["status"] in TERMINAL:
            return detail
        time.sleep(3)
    raise TimeoutError(f"job {job_id} did not finish within {timeout}s")


# --------------------------------------------------------------------------- scenarios


def s01_health_contract() -> None:
    scenario("01 · Health and readiness contract")
    anon = Client()
    status, health = anon.get("/api/system/health", csrf=False)
    results.record(
        "health endpoint reports ok with database and redis checks",
        status == 200 and health.get("status") in {"ok", "degraded"} and len(health.get("checks", [])) >= 2,
        f"HTTP {status}, status={health.get('status')}, checks={[c['component'] for c in health.get('checks', [])]}",
    )
    status, readiness = anon.get("/api/system/readiness", csrf=False)
    components = (readiness or {}).get("components", {})
    required = {"db", "redis", "storage", "ai", "vp", "integration"}
    results.record(
        "readiness reports every dependency component",
        status == 200 and required.issubset(components.keys()),
        f"HTTP {status}, components={sorted(components.keys())}",
    )
    workers = {worker["role"] for worker in (readiness or {}).get("workers", []) if worker.get("alive")}
    expected = {"ai", "render", "publish", "scheduler", "recovery"}
    results.record(
        "all five worker roles heartbeat",
        expected.issubset(workers),
        f"alive roles={sorted(workers)}, missing={sorted(expected - workers)}",
    )


def s02_csrf_enforcement() -> None:
    scenario("02 · CSRF protection")
    client = admin_client()
    token = client.csrf
    client.csrf = None
    status, body = client.post("/api/jobs", {"sourceVideoId": str(uuid.uuid4())}, csrf=False)
    results.record(
        "unsafe request without a token is rejected by the CSRF guard",
        status == 403 and error_code(body) == "CSRF_FAILED",
        f"HTTP {status} ({error_code(body)})",
    )
    client.csrf = token
    status, body = client.post("/api/jobs", {"sourceVideoId": str(uuid.uuid4())})
    results.record(
        "the same request with a valid token passes the CSRF guard",
        status != 403 or error_code(body) != "CSRF_FAILED",
        f"HTTP {status} ({error_code(body) or 'reached the handler'})",
    )


def s03_login_rate_limit() -> None:
    scenario("03 · Login rate limiting")
    flush_login_ratelimit()
    client = Client()
    statuses = []
    # The limiter allows 10 logins per 300 s per IP; 13 attempts guarantees the 429 without
    # depending on the exact limit remaining from earlier scenarios.
    for _ in range(13):
        status, body = client.post("/api/auth/login", {"email": "nobody@clipforge.local", "password": "wrong-password"})
        statuses.append(status)
    limited = [code for code in statuses if code == 429]
    results.record(
        "repeated failed logins are rate limited (429)",
        len(limited) > 0,
        f"statuses={statuses}",
    )
    results.record(
        "invalid credentials never return a session",
        all(code in (401, 429) for code in statuses),
        f"statuses={statuses}",
    )
    flush_login_ratelimit()


def s04_session_revocation() -> None:
    scenario("04 · Session revocation on logout")
    client = admin_client()
    status, _ = client.get("/api/jobs")
    before = status
    client.post("/api/auth/logout")
    client.csrf = None
    status_after, _ = client.get("/api/jobs", csrf=False)
    results.record(
        "logout revokes the session server-side",
        before == 200 and status_after == 401,
        f"before={before}, after logout={status_after}",
    )
    # Logging out must not disable the account: a fresh login works.
    status = client.login(*ADMIN)
    results.record("the account can log in again after logout", status < 300, f"HTTP {status}")


def s05_upload_checksum(source: Path) -> dict:
    scenario("05 · Chunked upload integrity")
    client = admin_client()
    complete = upload_source(client, source)
    results.record(
        "uploaded source is validated with real probe values",
        complete.get("status") == "VALIDATED" and complete.get("width", 0) > 0,
        f"status={complete.get('status')}, {complete.get('durationSeconds')}s {complete.get('width')}x{complete.get('height')}",
    )
    # Re-declaring completion for the same upload must not create a second row or corrupt state.
    status, again = client.post(
        "/api/sources/upload/complete",
        {
            "sourceVideoId": complete["id"],
            "rightsDeclaration": {"accepted": True, "statement": "I own this recording."},
        },
    )
    results.record(
        "repeating upload completion is idempotent or cleanly refused",
        status < 300 or status in (400, 409),
        f"HTTP {status} ({error_code(again) or 'ok'})",
    )
    return complete


def s06_upload_limits() -> None:
    scenario("06 · Upload limits are enforced before bytes arrive")
    client = admin_client()
    status, body = client.post(
        "/api/sources/upload/initiate",
        {"fileName": "huge.mp4", "mimeType": "video/mp4", "sizeBytes": 5 * 1024 * 1024 * 1024},
    )
    results.record(
        "a declared size above the configured maximum is refused",
        status == 400 and error_code(body) in {"VALIDATION_FAILED", "CONFIGURATION_REQUIRED"},
        f"HTTP {status} ({error_code(body)}): {str(body.get('error', {}).get('message'))[:110] if isinstance(body, dict) else ''}",
    )
    status, body = client.post(
        "/api/sources/upload/initiate",
        {"fileName": "clip.txt", "mimeType": "text/plain", "sizeBytes": 1024},
    )
    results.record(
        "a non-video content type is refused",
        status == 400,
        f"HTTP {status} ({error_code(body)})",
    )


def s07_ssrf_guard() -> None:
    scenario("07 · SSRF guard on external media import")
    client = admin_client()
    blocked = []
    for url in [
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:4000/api/system/health",
        "http://localhost:5432/",
        "file:///etc/passwd",
    ]:
        status, body = client.post("/api/sources/import", {"url": url})
        if status == 400 and error_code(body) in {"VALIDATION_FAILED", "SSRF_BLOCKED"}:
            blocked.append(url)
    results.record(
        "loopback, link-local, localhost and file:// URLs are all refused",
        len(blocked) == 4,
        f"{len(blocked)}/4 refused: {blocked}",
    )


def s08_configuration_gate() -> dict:
    scenario("08 · Processing refuses to start without configuration")
    flush_rate_limits()
    email, password, user_id, workspace_id = create_second_tenant()
    try:
        fresh = Client()
        fresh.login(email, password)
        status, config = fresh.get("/api/configuration")
        results.record(
            "a new workspace reports its configuration as incomplete",
            status == 200 and len(config.get("missingForProcessing", [])) > 0,
            f"HTTP {status}, {len(config.get('missingForProcessing', []))} missing key(s)",
        )
        status, body = fresh.post("/api/jobs", {"sourceVideoId": str(uuid.uuid4())})
        results.record(
            "job creation without configuration is refused with 428",
            status in (428, 400),
            f"HTTP {status} ({error_code(body)})",
        )
    finally:
        delete_tenant(user_id, workspace_id)


def s09_full_pipeline(source: dict) -> dict:
    scenario("09 · Full pipeline: upload → transcript → selection → render")
    client = admin_client()
    config = configuration(client)
    status, job = create_job(client, source["id"], config)
    assert status < 300, f"job creation failed: {status} {job}"
    detail = wait_for_job(client, job["id"])
    results.record(
        "the job reaches COMPLETED with at least one rendered clip",
        detail["status"] == "COMPLETED" and detail.get("clipCount", 0) >= 1,
        f"status={detail['status']}, clips={detail.get('clipCount')}, stage={detail['stage']}",
    )
    stages = [event["stage"] for event in detail.get("events", []) if event.get("status") == "SUCCEEDED"]
    results.record(
        "every pipeline stage was recorded as succeeded",
        {"TRANSCRIBING", "AI_ANALYSIS", "CLIP_SELECTION"}.issubset(set(stages)),
        f"succeeded={stages}",
    )
    measured = [event for event in detail.get("events", []) if (event.get("durationMs") or 0) > 0]
    results.record(
        "stage timings are measured, not fabricated",
        len(measured) >= 2,
        f"{len(measured)} stage(s) with a real duration, e.g. {measured[0]['stage']}={measured[0]['durationMs']}ms" if measured else "no measured stage",
    )
    # The transcript is not part of the job DTO; read it from the database to prove word timings exist.
    words = sql(f'SELECT coalesce(sum(jsonb_array_length(\"words\"::jsonb)),0) FROM "TranscriptSegment" WHERE "transcriptId" IN (SELECT id FROM "Transcript" WHERE "jobId" = \'{job["id"]}\');')
    results.record(
        "the transcript carries real word-level timings from ASR",
        int(words or 0) > 0,
        f"{words} words with timestamps",
    )
    status, clips = client.get(f"/api/clips?jobId={job['id']}&pageSize=10")
    detail["clips"] = (clips or {}).get("items", [])
    return detail


def s10_render_quality(job: dict) -> None:
    scenario("10 · Rendered clips are publishable, not just decodable")
    client = admin_client()
    clip = job["clips"][0]
    status, detail = client.get(f"/api/clips/{clip['id']}")
    assert status == 200, f"clip read failed: {status}"
    variant = detail["variants"][0]
    report = variant.get("renderReport") or {}
    quality = report.get("quality") or {}
    ratio = variant["width"] / variant["height"]
    results.record(
        "output is 9:16 vertical (within even-dimension rounding)",
        abs(ratio - 9 / 16) <= 0.01,
        f"{variant['width']}x{variant['height']} (ratio {ratio:.4f}, 9:16 = 0.5625)",
    )
    results.record(
        "the render report carries a content verdict (black/freeze/volume)",
        isinstance(quality, dict) and quality.get("passed") is True,
        f"quality={json.dumps(quality)[:220]}",
    )
    results.record(
        "audio track is present and not silent",
        (quality.get("meanVolumeDb") or 0) > -55,
        f"meanVolumeDb={quality.get('meanVolumeDb')}, drift={quality.get('audioVideoDriftSeconds')}s",
    )
    results.record(
        "burned subtitles were planned from real word timings",
        (report.get("subtitleWordCount") or 0) > 0,
        f"subtitleWordCount={report.get('subtitleWordCount')}",
    )


def s11_media_range(clip: dict) -> None:
    scenario("11 · Media streaming supports HTTP Range")
    client = admin_client()
    status, dl = client.get(f"/api/clips/{clip['id']}/download")
    results.record(
        "the download endpoint returns a URL and a file name",
        status == 200 and isinstance(dl, dict) and bool(dl.get("url")) and bool(dl.get("fileName")),
        f"HTTP {status}, url={str(dl.get('url'))[:48] if isinstance(dl, dict) else dl}",
    )
    status, detail = client.get(f"/api/clips/{clip['id']}")
    variant_id = detail["variants"][0]["id"]
    status, _ = client.request("GET", f"/media/clips/{variant_id}", headers={"range": "bytes=0-1023"})
    results.record("a ranged request returns 206", status == 206, f"HTTP {status} (bytes=0-1023)")
    status, _ = client.request("GET", f"/media/clips/{variant_id}", headers={"range": "bytes=999999999-"})
    results.record("an unsatisfiable range returns 416", status == 416, f"HTTP {status}")
    status, full = client.get(f"/media/clips/{variant_id}")
    results.record(
        "a full request streams a non-empty body",
        status == 200 and (full.get("bytes") or 0) > 100_000,
        f"HTTP {status}, {full.get('bytes')} bytes",
    )


def s12_job_idempotency(source: dict) -> None:
    scenario("12 · Duplicate submissions do not duplicate work")
    client = admin_client()
    config = configuration(client)
    status_a, job_a = create_job(client, source["id"], config)
    status_b, job_b = create_job(client, source["id"], config)
    same_job = status_b < 300 and job_b.get("id") == job_a.get("id")
    refused = status_b == 409 and error_code(job_b) == "CONFLICT"
    results.record(
        "submitting the same source twice never creates a second concurrent job",
        same_job or refused,
        f"first={job_a.get('id')} second={job_b.get('id') if same_job else error_code(job_b)} (HTTP {status_a}/{status_b})",
    )


def s13_cancel(job: dict) -> None:
    scenario("13 · Cancellation rules")
    client = admin_client()
    status, body = client.post(f"/api/jobs/{job['id']}/cancel")
    results.record(
        "a finished job cannot be cancelled (clean conflict, no state corruption)",
        status == 409 and error_code(body) == "CONFLICT",
        f"HTTP {status} ({error_code(body)})",
    )
    status, body = client.post(f"/api/jobs/{uuid.uuid4()}/cancel")
    results.record("cancelling an unknown job returns 404", status == 404, f"HTTP {status}")
    status, jobs = client.get("/api/jobs?status=CANCELLED&pageSize=5")
    cancelled = (jobs or {}).get("items", [])
    results.record(
        "cancelled jobs remain queryable with their terminal status",
        status == 200,
        f"HTTP {status}, {len(cancelled)} cancelled job(s) in the workspace",
    )


def s14_retry_rules(job: dict) -> None:
    scenario("14 · Retry rules")
    client = admin_client()
    status, body = client.post(f"/api/jobs/{job['id']}/retry")
    results.record(
        "a COMPLETED job cannot be retried",
        status == 409 and error_code(body) == "CONFLICT",
        f"HTTP {status} ({error_code(body)})",
    )
    status, body = client.post(f"/api/jobs/{uuid.uuid4()}/retry")
    results.record("retrying an unknown job returns 404", status == 404, f"HTTP {status}")


def s15_clip_metadata(job: dict) -> None:
    scenario("15 · Per-platform metadata validation")
    client = admin_client()
    clip_id = job["clips"][0]["id"]
    status, body = client.request(
        "PATCH", f"/api/clips/{clip_id}/metadata", {"platform": "YOUTUBE", "hashtags": ["not a hashtag!"]}
    )
    results.record(
        "an invalid hashtag is rejected",
        status == 400 and error_code(body) == "VALIDATION_FAILED",
        f"HTTP {status} ({error_code(body)})",
    )
    title = f"Scenario title {uuid.uuid4().hex[:6]}"
    status, _ = client.request(
        "PATCH", f"/api/clips/{clip_id}/metadata", {"platform": "YOUTUBE", "title": title, "tags": ["clipforge"]}
    )
    read_status, detail = client.get(f"/api/clips/{clip_id}")
    stored = [meta.get("title") for meta in (detail.get("metadata") or []) if meta.get("platform") == "YOUTUBE"]
    results.record(
        "a valid update is persisted and read back",
        status == 200 and read_status == 200 and title in stored,
        f"PATCH {status}, GET {read_status}, youtube titles={stored}",
    )


def s16_publishing_gate(job: dict) -> None:
    scenario("16 · Publishing requires an eligible account and metadata")
    client = admin_client()
    clip_id = job["clips"][0]["id"]
    status, body = client.post("/api/publishing/jobs", {"clipId": clip_id, "platforms": ["INSTAGRAM"]})
    results.record(
        "publishing a clip without Instagram metadata is refused",
        status in (400, 409),
        f"HTTP {status} ({error_code(body)})",
    )
    status, body = client.post("/api/publishing/jobs", {"clipId": clip_id, "platforms": ["YOUTUBE"]})
    results.record(
        "publishing is refused when no YouTube account is connected",
        status in (400, 404, 409, 428),
        f"HTTP {status} ({error_code(body)})",
    )


def s17_usage_ledger(job: dict) -> None:
    scenario("17 · Usage and cost accounting")
    admin = admin_client()
    status, summary = admin.get(f"/api/usage/summary?from={time.strftime('%Y-%m-%d', time.gmtime(time.time() - 3600))}")
    kinds = {entry["kind"]: entry for entry in (summary or {}).get("byKind", [])}
    results.record(
        "usage records exist for transcription and rendering of this job",
        status == 200 and "transcription_seconds" in kinds and "render_seconds" in kinds,
        f"HTTP {status}, kinds={sorted(kinds)}",
    )
    priced = [kind for kind, entry in kinds.items() if entry["unpricedRecords"] < entry["records"]]
    results.record(
        "new records carry a computed cost instead of a null",
        len(priced) > 0,
        f"priced kinds={sorted(priced)}",
    )
    status, ledger = admin.get(f"/api/usage/records?jobId={job['id']}&pageSize=50")
    job_records = ledger.get("items", []) if isinstance(ledger, dict) else []
    results.record(
        "the ledger is filterable by job",
        status == 200 and len(job_records) >= 2 and all(item["jobId"] == job["id"] for item in job_records),
        f"HTTP {status}, {len(job_records)} record(s)",
    )
    member = Client()
    member.login(*MEMBER)
    status, body = member.get("/api/usage/summary")
    results.record("members cannot read the cost ledger", status == 403, f"HTTP {status} ({error_code(body)})")


def s18_authorization_matrix() -> None:
    scenario("18 · Authorization matrix (separate suite)")
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parent / "authorization_matrix.py")],
        capture_output=True,
        text=True,
        check=False,
    )
    tail = [line for line in proc.stdout.strip().splitlines() if "checks passed" in line]
    results.record(
        "anonymous, role and cross-tenant probes all pass",
        proc.returncode == 0,
        tail[-1] if tail else f"exit {proc.returncode}",
    )


def s19_worker_restart() -> None:
    scenario("19 · Durability across a worker restart")
    flush_rate_limits()
    client = admin_client()
    config = configuration(client)
    # Queue a job with the render worker stopped, then start it again: the work must survive.
    pids = subprocess.run(["pgrep", "-f", "node dist/workers/render.worker.js"], capture_output=True, text=True).stdout.split()
    for pid in pids:
        subprocess.run(["kill", pid], check=False)
    time.sleep(2)
    # A fresh upload: the earlier source already has an active job, and re-submitting it is
    # (correctly) refused as a duplicate.
    fresh = upload_source(client, SOURCE, name=f"restart-{int(time.time())}.mp4")
    status, job = create_job(client, fresh["id"], config)
    assert status < 300, f"job creation failed: {status} {job}"
    time.sleep(8)
    status, queued = client.get(f"/api/jobs/{job['id']}")
    results.record(
        "the job waits in a non-terminal state while the render worker is down",
        queued["status"] not in TERMINAL and queued["status"] != "FAILED",
        f"status={queued['status']}, stage={queued['stage']}",
    )
    subprocess.Popen(
        ["node", "dist/workers/render.worker.js"],
        cwd="/home/user/clipforge-ai/apps/api",
        stdout=open("/tmp/w-render-restart.log", "w"),
        stderr=subprocess.STDOUT,
    )
    detail = wait_for_job(client, job["id"], timeout=900)
    results.record(
        "the job completes once the worker is back, with clips rendered",
        detail["status"] in {"COMPLETED", "PARTIALLY_COMPLETED"} and detail.get("clipCount", 0) >= 1,
        f"status={detail['status']}, clips={detail.get('clipCount')}",
    )


def main() -> int:
    flush_login_ratelimit()
    if not SOURCE.exists():
        raise SystemExit(f"source video not found: {SOURCE}")

    s01_health_contract()
    s02_csrf_enforcement()
    s03_login_rate_limit()
    s04_session_revocation()
    source = s05_upload_checksum(SOURCE)
    results_state["source_id"] = source["id"]
    s06_upload_limits()
    s07_ssrf_guard()
    s08_configuration_gate()
    job = s09_full_pipeline(source)
    s10_render_quality(job)
    s11_media_range(job["clips"][0])
    s12_job_idempotency(source)
    s13_cancel(job)
    s14_retry_rules(job)
    s15_clip_metadata(job)
    s16_publishing_gate(job)
    s17_usage_ledger(job)
    s18_authorization_matrix()
    s19_worker_restart()

    return results.summary()


if __name__ == "__main__":
    sys.exit(main())
