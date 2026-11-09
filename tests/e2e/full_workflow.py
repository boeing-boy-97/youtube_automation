#!/usr/bin/env python3
"""End-to-end workflow test against a running ClipForge stack.

Exercises the real HTTP API and the real workers:
  login → configure workspace → upload a real video (chunked) → submit job →
  wait for the durable pipeline → download a rendered clip → verify the file.

Assertions are strict; any failure exits non-zero with the server's error body.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = os.environ.get("CLIPFORGE_API", "http://127.0.0.1:4000")
EMAIL = os.environ.get("CLIPFORGE_EMAIL", "admin@clipforge.local")
PASSWORD = os.environ.get("CLIPFORGE_PASSWORD", "Sandbox-Admin-2026")
PART_BYTES = 16 * 1024 * 1024

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
csrf_token = None


def request(method: str, path: str, body: dict | None = None, headers: dict | None = None, raw: bytes | None = None) -> dict:
    url = f"{API}{path}"
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["content-type"] = "application/json"
    elif raw is not None:
        data = raw
    if method not in ("GET", "HEAD") and csrf_token:
        hdrs["x-csrf-token"] = csrf_token
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    attempts = 1 if method not in ("GET", "HEAD") else 3
    for attempt in range(1, attempts + 1):
        try:
            with opener.open(req, timeout=300) as response:
                payload = response.read()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            raise SystemExit(f"FAILED {method} {path} -> HTTP {error.code}\n{detail[:1500]}")
        except (TimeoutError, urllib.error.URLError) as error:
            # Retry only transport-level failures on idempotent reads.
            if attempt == attempts:
                raise SystemExit(f"FAILED {method} {path} -> {error}")
            time.sleep(2 * attempt)
    raise SystemExit(f"FAILED {method} {path}")


def multipart(fields: dict[str, str], file_field: str, filename: str, content: bytes) -> tuple[bytes, str]:
    boundary = "----clipforge" + str(int(time.time() * 1000))
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n".encode()
        + content
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def step(message: str) -> None:
    print(f"[e2e] {message}", flush=True)


def main() -> int:
    global csrf_token
    video_path = Path(sys.argv[1] if len(sys.argv) > 1 else "/home/user/testdata/hd-source.mp4")
    if not video_path.exists():
        raise SystemExit(f"test video not found: {video_path}")

    step("obtaining CSRF token")
    csrf_token = request("GET", "/api/auth/csrf")["csrfToken"]

    step("logging in")
    session = request("GET", "/api/auth/session")
    if not session.get("authenticated"):
        request("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
        session = request("GET", "/api/auth/session")
    assert session["authenticated"], "session not established"
    csrf_token = session["csrfToken"]
    step(f"authenticated as {session['user']['email']} in workspace {session['workspace']['name']}")

    step("writing explicit workspace configuration")
    config = request("GET", "/api/configuration")
    preset = config["subtitlePresets"][0]
    entries = [
        {"key": "ai.text_model", "value": "gemini-2.0-flash"},
        {"key": "ai.vision_model", "value": "gemini-2.0-flash"},
        {"key": "ai.max_output_clips", "value": 6},
        {"key": "ai.min_quality_score", "value": 70},
        {"key": "ai.max_candidates_per_call", "value": 12},
        {"key": "processing.max_duration_seconds", "value": 3600},
        {"key": "processing.max_file_size_bytes", "value": 512 * 1024 * 1024},
        {"key": "render.output_width", "value": 1080},
        {"key": "render.output_height", "value": 1920},
        {"key": "render.fps", "value": 30},
        {"key": "render.bitrate_kbps", "value": 6000},
        {"key": "render.framing_mode", "value": "center_crop"},
        {"key": "render.framing_fallback", "value": "center_crop"},
        {"key": "subtitles.preset_id", "value": preset["id"]},
        {"key": "subtitles.language", "value": "en"},
        {"key": "content.languages", "value": ["en"]},
        {"key": "storage.provider", "value": "local"},
        {"key": "workspace.timezone", "value": "Asia/Kolkata"},
        {"key": "clips.duplicate_similarity_threshold", "value": 0.35},
        {"key": "audio.loudness_target_lufs", "value": -14},
        {"key": "retention.source_days", "value": 30},
        {"key": "retention.asset_days", "value": 90},
        {"key": "publishing.auto_enabled", "value": False},
        {"key": "publishing.youtube_visibility", "value": "UNLISTED"},
    ]
    saved = request("PUT", "/api/configuration", {"entries": entries})
    assert not saved["missingForProcessing"], f"configuration still missing: {saved['missingForProcessing']}"
    step(f"configuration complete; subtitle preset = {preset['name']}")

    step(f"initiating chunked upload of {video_path.name} ({video_path.stat().st_size} bytes)")
    size = video_path.stat().st_size
    initiation = request(
        "POST",
        "/api/sources/upload/initiate",
        {"fileName": video_path.name, "mimeType": "video/mp4", "sizeBytes": size},
    )
    source_id = initiation["sourceVideoId"]
    data = video_path.read_bytes()
    parts = [data[i : i + PART_BYTES] for i in range(0, len(data), PART_BYTES)]
    for index, chunk in enumerate(parts, start=1):
        body, content_type = multipart({}, "chunk", "part.bin", chunk)
        request(
            "POST",
            f"/api/sources/upload/part?sourceVideoId={source_id}&partNumber={index}",
            headers={"content-type": content_type},
            raw=body,
        )
    complete = request(
        "POST",
        "/api/sources/upload/complete",
        {
            "sourceVideoId": source_id,
            "rightsDeclaration": {
                "accepted": True,
                "statement": "I own this recording or hold a licence that permits repurposing and publishing clips of it.",
            },
        },
    )
    assert complete["status"] == "VALIDATED", f"source not validated: {complete}"
    step(f"source validated: {complete['durationSeconds']:.2f}s {complete['width']}x{complete['height']} {complete['probe']['video_codec']}")

    step("creating processing job")
    job = request(
        "POST",
        "/api/jobs",
        {
            "sourceVideoId": source_id,
            "configuration": {
                "framingMode": "center_crop",
                "framingFallback": "center_crop",
                "subtitlePresetId": preset["id"],
                "subtitleLanguage": "en",
                "contentLanguages": ["en"],
                "targetDurations": [15, 30],
                "maxClips": 4,
                "minQualityScore": 70,
                "autoPublish": False,
                "platforms": [],
            },
        },
    )
    job_id = job["id"]
    step(f"job {job_id} created in status {job['status']}")

    terminal = {"COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED", "NEEDS_CONFIGURATION"}
    deadline = time.time() + 900
    last_stage = None
    while time.time() < deadline:
        detail = request("GET", f"/api/jobs/{job_id}")
        if detail["stage"] != last_stage:
            last_stage = detail["stage"]
            step(f"  stage={detail['stage']} progress={detail['progressPercent']}% {detail.get('progressDetail') or ''}")
        if detail["status"] in terminal:
            break
        time.sleep(3)
    else:
        raise SystemExit("job did not reach a terminal state within 15 minutes")

    detail = request("GET", f"/api/jobs/{job_id}")
    step(f"job finished: status={detail['status']} clips={detail['clipCount']}")
    if detail["status"] in ("FAILED", "NEEDS_CONFIGURATION"):
        raise SystemExit(f"job failed: {detail['errorCode']} {detail['errorMessage']}")
    assert detail["clipCount"] > 0, "job completed without producing any clips"

    clips = request("GET", "/api/clips")
    assert clips["total"] > 0, "no clips in the library"
    clip = request("GET", f"/api/clips/{clips['items'][0]['id']}")
    step(f"clip: {clip['title'][:60]!r} score={clip['qualityScore']} {clip['durationKind']}s variants={len(clip['variants'])}")

    # Metadata for both platforms must exist and differ.
    platforms = {m["platform"]: m for m in clip["metadata"]}
    assert "YOUTUBE" in platforms and "INSTAGRAM" in platforms, f"missing platform metadata: {list(platforms)}"
    step(f"youtube title: {platforms['YOUTUBE']['title'][:70]!r}")
    step(f"instagram caption: {(platforms['INSTAGRAM']['description'] or '')[:70]!r}")

    # Download the rendered media through the API and verify it with ffprobe.
    variant = clip["variants"][0]
    media_url = f"{API}{variant['previewUrl']}"
    req = urllib.request.Request(media_url)
    with opener.open(req, timeout=120) as response:
        payload = response.read()
    out = Path("/tmp/e2e-clip.mp4")
    out.write_bytes(payload)
    assert len(payload) > 100_000, f"rendered clip is suspiciously small ({len(payload)} bytes)"
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(out)],
        capture_output=True,
        text=True,
        check=True,
    )
    info = json.loads(probe.stdout)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    ratio = int(video["width"]) / int(video["height"])
    assert abs(ratio - 9 / 16) < 0.01, f"not vertical: {video['width']}x{video['height']}"
    assert video["codec_name"] == "h264" and audio["codec_name"] == "aac", "unexpected codecs"
    step(f"downloaded clip verified: {video['width']}x{video['height']} h264/aac {float(info['format']['duration']):.2f}s {len(payload)} bytes")

    summary = request("GET", "/api/dashboard/summary")
    step(f"dashboard counts: {summary['counts']}")
    assert summary["counts"]["clips"] >= 1 and summary["counts"]["sources"] >= 1

    activity = request("GET", "/api/activity?limit=20")
    actions = {item["action"] for item in activity["items"]}
    assert "JOB_CREATED" in actions, f"audit log missing JOB_CREATED: {actions}"
    step(f"audit actions recorded: {sorted(actions)[:8]}")

    overview = request("GET", "/api/system/overview")
    step(f"workers alive: {[w['role'] for w in overview['workers'] if w['alive']]}")
    step("E2E PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
