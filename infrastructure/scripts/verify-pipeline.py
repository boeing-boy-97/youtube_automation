#!/usr/bin/env python3
"""End-to-end verification of the AI analysis + video rendering chain.

Runs against the real ai-engine and video-processor HTTP services with a real
video file, then verifies the rendered MP4 with ffprobe. Prints a machine-readable
summary so failures are unambiguous.

Usage:
  .venv/bin/python infrastructure/scripts/verify-pipeline.py <video-path> [--job-id ID]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_env() -> dict:
    env = dict(os.environ)
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env.setdefault(key, value)
    return env


def post(url: str, payload: dict, api_key: str, timeout: int = 1800) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", "x-api-key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("--job-id", default=f"verify-{int(time.time())}")
    parser.add_argument("--subtitle-preset", default=None)
    args = parser.parse_args()

    env = load_env()
    ai_url = env["AI_ENGINE_URL"]
    vp_url = env["VIDEO_PROCESSOR_URL"]
    ai_key = env["AI_ENGINE_API_KEY"]
    vp_key = env["VIDEO_PROCESSOR_API_KEY"]
    work_dir = Path(env["WORK_DIR"])

    video = str(Path(args.video).resolve())
    started = time.time()

    print(f"[1/4] analysing {video} via {ai_url}")
    analysis = post(
        f"{ai_url}/analyze",
        {
            "job_id": args.job_id,
            "video_path": video,
            "text_model": env.get("GEMINI_TEXT_MODEL") or "configured-model",
            "vision_model": env.get("GEMINI_VISION_MODEL") or "configured-model",
            "target_durations": [15, 30],
            "max_candidates": 12,
            "max_clips": 4,
            "min_quality_score": 70,
            "duplicate_threshold": 0.35,
            "enable_vision": True,
        },
        ai_key,
    )
    report = analysis["report"]
    print(
        f"      provider={report['provider']} proposed={report['proposed']} "
        f"validated={report['validated']} clips={report['clips_planned']}"
    )
    if not analysis["plan"]:
        print(f"      NO CLIPS: {report.get('explanation', 'unknown reason')}")
        return 2

    preset_style = {
        "fontFamily": "Inter",
        "fontSizePx": 64,
        "fontWeight": 800,
        "primaryColor": "#FFFFFF",
        "highlightColor": "#22D3EE",
        "outlineColor": "#0B1120",
        "outlineWidth": 5,
        "shadow": 1,
        "position": "middle",
        "safeMarginXPx": 90,
        "safeMarginBottomPx": 460,
        "backgroundOpacity": 0.2,
        "uppercase": False,
        "maxCharsPerLine": 20,
        "maxLines": 2,
    }
    if args.subtitle_preset and Path(args.subtitle_preset).exists():
        preset_style = json.loads(Path(args.subtitle_preset).read_text())

    segments = analysis["transcript"]["segments"]
    rendered = []
    for index, entry in enumerate(analysis["plan"][:2]):
        start, end = entry["start_time"], entry["end_time"]
        words = [
            {"word": w["word"], "start": w["start"], "end": w["end"], "probability": w["probability"]}
            for segment in segments
            for w in segment["words"]
            if w["end"] > start and w["start"] < end
        ]
        output = work_dir / args.job_id / f"clip-{index}-{entry['duration_kind']}s.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        print(f"[2/4] rendering {entry['duration_kind']}s clip {start:.2f}-{end:.2f} ({len(words)} words)")
        result = post(
            f"{vp_url}/render",
            {
                "source_path": video,
                "output_path": str(output),
                "start": start,
                "end": end,
                "words": words,
                "subtitle_style": preset_style,
                "output_width": 1080,
                "output_height": 1920,
                "fps": 30,
                "bitrate_kbps": 6000,
                "framing_mode": "center_crop",
                "framing_fallback": "fail",
                "loudness_target_lufs": -14,
            },
            vp_key,
        )
        rendered.append({"path": str(output), "result": result})
        print(
            f"      -> {result['width']}x{result['height']} {result['videoCodec']}/{result['audioCodec']} "
            f"{result['durationSeconds']:.2f}s {result['sizeBytes'] / 1024 / 1024:.1f}MB "
            f"subtitleLines={result['subtitleStats']['lines']} highlightEvents={result['subtitleStats']['highlightEvents']}"
        )

    print("[3/4] validating outputs with ffprobe")
    source_probe = json.loads(
        subprocess.run(
            [env.get("FFPROBE_PATH", "ffprobe"), "-v", "error", "-print_format", "json", "-show_streams", video],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    )
    source_video = next(s for s in source_probe["streams"] if s["codec_type"] == "video")
    source_height = int(source_video["height"])
    # Never upscale: the expected height is the smaller of the 1920 target and the
    # source height, snapped to an even value (yuv420p requirement).
    expected_height = min(1920, source_height) - (min(1920, source_height) % 2)
    expected_width = int(round(expected_height * 9 / 16 / 2) * 2)
    for item in rendered:
        probe = json.loads(
            subprocess.run(
                [env.get("FFPROBE_PATH", "ffprobe"), "-v", "error", "-print_format", "json", "-show_streams", item["path"]],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )
        video_stream = next(s for s in probe["streams"] if s["codec_type"] == "video")
        audio_stream = next(s for s in probe["streams"] if s["codec_type"] == "audio")
        assert video_stream["codec_name"] == "h264", "video codec is not h264"
        assert audio_stream["codec_name"] == "aac", "audio codec is not aac"
        actual_w, actual_h = int(video_stream["width"]), int(video_stream["height"])
        assert abs(actual_w / actual_h - 9 / 16) < 0.01, f"aspect ratio {actual_w}x{actual_h} is not 9:16"
        assert actual_h == expected_height and actual_w == expected_width, (
            f"resolution {actual_w}x{actual_h} != expected {expected_width}x{expected_height} "
            f"(source {source_video['width']}x{source_height}, no upscaling allowed)"
        )
        print(f"      OK {Path(item['path']).name}: h264/aac {actual_w}x{actual_h} (source {source_video['width']}x{source_height})")

    print("[4/4] summary")
    summary = {
        "job_id": args.job_id,
        "provider": report["provider"],
        "transcript": {
            "language": analysis["transcript"]["language"],
            "segments": len(segments),
            "words": sum(len(s["words"]) for s in segments),
        },
        "clips_planned": report["clips_planned"],
        "variant_decisions": analysis["variant_decisions"],
        "rendered": [{"path": r["path"], **{k: r["result"][k] for k in ("width", "height", "durationSeconds", "sizeBytes", "videoCodec", "audioCodec")}} for r in rendered],
        "elapsed_seconds": round(time.time() - started, 1),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
