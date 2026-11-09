"""Audio analysis: loudness, true peak, silence ranges, clipping detection.

All measurements come from FFmpeg's own filters — nothing is estimated.
"""
from __future__ import annotations

import logging
import math
import re
import subprocess

logger = logging.getLogger("video-processor.audio")

LOUDNORM_RE = re.compile(
    r"\{[^}]*\"input_i\"\s*:\s*\"(?P<i>-?[\d.]+|-inf)\"[^}]*"
    r"\"input_tp\"\s*:\s*\"(?P<tp>-?[\d.]+|-inf)\"[^}]*"
    r"\"input_lra\"\s*:\s*\"(?P<lra>-?[\d.]+|-inf)\"[^}]*"
    r"\"input_thresh\"\s*:\s*\"(?P<thresh>-?[\d.]+|-inf)\"",
    re.S,
)
SILENCE_START_RE = re.compile(r"silence_start:\s*(?P<start>[\d.]+)")
SILENCE_END_RE = re.compile(r"silence_end:\s*(?P<end>[\d.]+)")
MEAN_VOLUME_RE = re.compile(r"mean_volume:\s*(?P<db>-?[\d.]+|-inf) dB")
MAX_VOLUME_RE = re.compile(r"max_volume:\s*(?P<db>-?[\d.]+|-inf) dB")


def analyse(ffmpeg_path: str, media_path: str, start: float | None = None, duration: float | None = None) -> dict:
    notes: list[str] = []
    loudness = _measure_loudness(ffmpeg_path, media_path, start, duration)
    silences = _detect_silence(ffmpeg_path, media_path, start, duration)
    mean_db, max_db = _measure_volume(ffmpeg_path, media_path, start, duration)

    clipping = bool(max_db is not None and max_db >= -0.1)
    if clipping:
        notes.append(f"Possible clipping: peak {max_db} dBFS")
    if loudness.get("integrated_loudness_lufs") is None:
        notes.append("Could not measure integrated loudness")
    if silences:
        total_silence = sum(r["end"] - r["start"] for r in silences)
        notes.append(f"{len(silences)} silence range(s) totalling {total_silence:.1f}s")

    return {
        "integrated_loudness_lufs": loudness.get("integrated_loudness_lufs"),
        "true_peak_dbtp": loudness.get("true_peak_dbtp"),
        "loudness_range": loudness.get("loudness_range"),
        "silence_ranges": silences,
        "clipping_detected": clipping,
        "mean_volume_db": mean_db,
        "max_volume_db": max_db,
        "notes": notes,
    }


def _measure_loudness(ffmpeg_path: str, media_path: str, start: float | None, duration: float | None) -> dict:
    cmd = [ffmpeg_path, "-hide_banner", "-nostats"]
    if start is not None:
        cmd += ["-ss", f"{start:.3f}"]
    if duration is not None:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-i", media_path, "-map", "0:a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
    match = LOUDNORM_RE.search(proc.stderr or "")
    if not match:
        return {}
    def num(value: str) -> float | None:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        # FFmpeg reports "-inf" for digital silence. Keeping that value would be passed straight into
        # loudnorm's measured_I parameter, which rejects it and fails the whole render.
        return parsed if math.isfinite(parsed) else None

    return {
        "integrated_loudness_lufs": num(match.group("i")),
        "true_peak_dbtp": num(match.group("tp")),
        "loudness_range": num(match.group("lra")),
    }


def _detect_silence(ffmpeg_path: str, media_path: str, start: float | None, duration: float | None, threshold_db: int = -35, min_seconds: float = 0.45) -> list[dict]:
    cmd = [ffmpeg_path, "-hide_banner", "-nostats"]
    if start is not None:
        cmd += ["-ss", f"{start:.3f}"]
    if duration is not None:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-i", media_path, "-map", "0:a:0", "-af", f"silencedetect=noise={threshold_db}dB:d={min_seconds}", "-f", "null", "-"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
    ranges: list[dict] = []
    pending_start: float | None = None
    for line in (proc.stderr or "").splitlines():
        start_match = SILENCE_START_RE.search(line)
        if start_match:
            pending_start = float(start_match.group("start"))
            continue
        end_match = SILENCE_END_RE.search(line)
        if end_match and pending_start is not None:
            ranges.append({"start": round(pending_start, 3), "end": round(float(end_match.group("end")), 3)})
            pending_start = None
    return ranges


def _measure_volume(ffmpeg_path: str, media_path: str, start: float | None, duration: float | None) -> tuple[float | None, float | None]:
    cmd = [ffmpeg_path, "-hide_banner", "-nostats"]
    if start is not None:
        cmd += ["-ss", f"{start:.3f}"]
    if duration is not None:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-i", media_path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
    mean_match = MEAN_VOLUME_RE.search(proc.stderr or "")
    max_match = MAX_VOLUME_RE.search(proc.stderr or "")
    def num(match: re.Match[str] | None) -> float | None:
        if not match:
            return None
        try:
            parsed = float(match.group("db"))
        except (TypeError, ValueError):
            return None
        return parsed if math.isfinite(parsed) else None
    return num(mean_match), num(max_match)
