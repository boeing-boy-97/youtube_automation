"""FFmpeg / FFprobe wrappers: probing, audio extraction and resource-efficient
frame sampling with scene-change detection. No frame is ever produced twice:
frames are de-duplicated by perceptual-ish hash (downscaled pixel signature)."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import Settings


@dataclass
class ProbeInfo:
    duration_seconds: float
    width: int
    height: int
    frame_rate: float
    video_codec: str | None
    audio_codec: str | None
    audio_channels: int | None
    audio_sample_rate: int | None
    container: str
    bit_rate: int | None
    rotation: int

    def as_dict(self) -> dict:
        return {
            "duration_seconds": self.duration_seconds,
            "width": self.width,
            "height": self.height,
            "frame_rate": self.frame_rate,
            "video_codec": self.video_codec,
            "audio_codec": self.audio_codec,
            "audio_channels": self.audio_channels,
            "audio_sample_rate": self.audio_sample_rate,
            "container": self.container,
            "bit_rate": self.bit_rate,
            "rotation": self.rotation,
        }


class MediaError(RuntimeError):
    pass


def run(cmd: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise MediaError(f"command failed ({proc.returncode}): {' '.join(cmd[:4])}... :: {proc.stderr[-800:]}")
    return proc


def _parse_rate(rate: str | None) -> float:
    if not rate or "/" not in rate:
        return 0.0
    num, den = rate.split("/")
    try:
        den_f = float(den)
        return float(num) / den_f if den_f else 0.0
    except ValueError:
        return 0.0


def probe(settings: Settings, path: str | Path) -> ProbeInfo:
    proc = run(
        [
            settings.ffprobe_path,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        timeout=120,
    )
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format", {})
    if video is None:
        raise MediaError("No video stream present")
    rotation = 0
    for side in video.get("side_data_list", []) or []:
        if "rotation" in side:
            rotation = int(side["rotation"])
    return ProbeInfo(
        duration_seconds=float(fmt.get("duration") or video.get("duration") or 0.0),
        width=int(video.get("width") or 0),
        height=int(video.get("height") or 0),
        frame_rate=_parse_rate(video.get("avg_frame_rate") or video.get("r_frame_rate")),
        video_codec=video.get("codec_name"),
        audio_codec=audio.get("codec_name") if audio else None,
        audio_channels=int(audio["channels"]) if audio and audio.get("channels") else None,
        audio_sample_rate=int(audio["sample_rate"]) if audio and audio.get("sample_rate") else None,
        container=fmt.get("format_name", ""),
        bit_rate=int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        rotation=rotation,
    )


def extract_audio(settings: Settings, video_path: str | Path, out_path: str | Path) -> Path:
    """16 kHz mono WAV: the format Whisper models expect (no resampling artefacts)."""
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            settings.ffmpeg_path,
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(out),
        ],
        timeout=1800,
    )
    return out


def detect_scenes(settings: Settings, video_path: str | Path, threshold: float = 0.3) -> list[float]:
    """Scene-change timestamps via ffmpeg's scene score. Cheap: decodes at low res."""
    proc = subprocess.run(
        [
            settings.ffmpeg_path,
            "-i",
            str(video_path),
            "-vf",
            f"scale=320:-2,select='gt(scene,{threshold})',showinfo",
            "-vsync",
            "vfr",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        timeout=1800,
    )
    times: list[float] = []
    for line in proc.stderr.splitlines():
        if "pts_time:" not in line:
            continue
        try:
            chunk = line.split("pts_time:")[1].split(" ")[0]
            times.append(float(chunk))
        except (IndexError, ValueError):
            continue
    return times


def sample_frames(
    settings: Settings,
    video_path: str | Path,
    out_dir: str | Path,
    scene_times: list[float],
    duration_seconds: float,
    max_frames: int,
) -> list[dict]:
    """Samples a bounded set of representative frames.

    Strategy: half the budget goes to scene-change frames (the most informative),
    the rest to a uniform grid so quiet passages are still represented. Frames
    that are visually identical to an already-sampled frame are skipped, so the
    vision call stays cheap even for long videos.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    budget = max(2, max_frames)
    scene_pick = scene_times[: max(1, budget // 2)]
    uniform_count = max(1, budget - len(scene_pick))
    uniform_pick = [duration_seconds * (i + 0.5) / uniform_count for i in range(uniform_count)]
    timestamps = sorted({round(t, 2) for t in [*scene_pick, *uniform_pick] if 0 <= t < max(duration_seconds - 0.05, 0.1)})

    frames: list[dict] = []
    seen_signatures: set[str] = set()
    for ts in timestamps:
        frame_path = out / f"frame_{ts:08.2f}.jpg"
        try:
            run(
                [
                    settings.ffmpeg_path,
                    "-y",
                    "-ss",
                    f"{ts:.3f}",
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    "-vf",
                    f"scale={settings.vision_frame_max_width}:-2",
                    "-q:v",
                    "4",
                    str(frame_path),
                ],
                timeout=120,
            )
        except MediaError:
            continue
        signature = _signature(frame_path)
        if signature in seen_signatures:
            frame_path.unlink(missing_ok=True)
            continue
        seen_signatures.add(signature)
        frames.append({"timestamp": ts, "path": str(frame_path), "bytes": frame_path.stat().st_size})
    return frames


def _signature(frame_path: Path) -> str:
    """16x16 grayscale signature for near-duplicate frame suppression."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return frame_path.name
    img = cv2.imread(str(frame_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return frame_path.name
    small = cv2.resize(img, (16, 16), interpolation=cv2.INTER_AREA)
    buckets = (small // 32).astype(np.uint8)
    return "".join(str(int(v)) for v in buckets.flatten())
