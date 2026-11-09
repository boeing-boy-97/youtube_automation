"""TEST-ONLY analysis provider.

This module exists so the pipeline can be exercised end-to-end in isolated
automated test environments where no Gemini API key is available. It is:
  * only importable when AI_PROVIDER=fixture AND TEST_MODE=1 (see config.py),
  * clearly marked in every response (`provider: "fixture"`),
  * never used for a live user job: the API records the provider on the transcript,
    and the verification report lists live Gemini analysis as BLOCKED.

It performs no "AI" reasoning. It derives candidate windows mechanically from the
real transcript produced by faster-whisper so that downstream validation,
de-duplication, rendering and publishing can be tested for real.
"""
from __future__ import annotations

from .selection import Candidate, RUBRIC, compute_quality_score


def propose_candidates(
    *,
    segments: list[dict],
    duration_seconds: float,
    target_durations: list[int],
    max_candidates: int,
) -> dict:
    windows: list[dict] = []
    target = 30 if 30 in target_durations else (target_durations[0] if target_durations else 15)
    # Group consecutive transcript segments into windows close to the target length.
    step = max(1, len(segments) // max_candidates) if segments else 1
    for index in range(0, len(segments), step):
        start = max(0.0, segments[index]["start"])
        end = start
        collected: list[str] = []
        cursor = index
        while cursor < len(segments) and segments[cursor]["end"] - start < target:
            collected.append(segments[cursor]["text"])
            end = segments[cursor]["end"]
            cursor += 1
        if end - start < target * 0.7:
            continue
        windows.append(
            {
                "start_time": round(start, 3),
                "end_time": round(end, 3),
                "target_duration": target,
                "hook": " ".join(collected)[:80],
                "reason": "fixture provider: consecutive transcript window of sufficient length",
                "transcript": " ".join(collected),
                "content_category": "educational",
                "quality_score": 82,
                "confidence": 0.7,
                "visual_context": "fixture provider: no vision pass performed",
                "scores": {key: 8.0 for key in RUBRIC},
            }
        )
        if len(windows) >= max_candidates:
            break

    return {
        "candidates": windows,
        "video_summary": "fixture provider summary (no model was called)",
        "content_themes": ["fixture"],
        "no_candidate_reason": "" if windows else "fixture provider found no transcript window long enough",
    }


def describe_frames(frames: list[dict]) -> list[dict]:
    return [
        {
            "timestamp": frame["timestamp"],
            "description": "fixture provider: frames sampled but not analysed by a vision model",
            "faces_present": 0,
            "shot_type": "other",
            "on_screen_text": "",
            "vertical_crop_risk": "low",
        }
        for frame in frames
    ]
