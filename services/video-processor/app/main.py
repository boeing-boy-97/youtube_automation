"""Video processor HTTP service.

Endpoints
  GET  /health           — liveness + FFmpeg availability
  POST /probe            — ffprobe inspection (used by the API's upload validation)
  POST /audio-analysis   — loudness / silence / clipping measurement
  POST /validate         — validate an existing output file
  POST /render           — render one vertical clip with subtitles
"""
from __future__ import annotations

import logging
import os

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import audio as audio_mod
from . import framing as framing_mod
from . import renderer

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "info").upper())
logger = logging.getLogger("video-processor")

app = FastAPI(title="ClipForge Video Processor", version="1.0.0")

API_KEY = os.environ.get("VIDEO_PROCESSOR_API_KEY")
FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_PATH", "ffprobe")


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if not API_KEY:
        raise HTTPException(status_code=503, detail={"code": "CONFIGURATION_REQUIRED", "message": "VIDEO_PROCESSOR_API_KEY is not set"})
    if not x_api_key or x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED", "message": "Invalid service API key"})


class ProbeRequest(BaseModel):
    path: str


class AudioRequest(BaseModel):
    path: str
    start: float | None = None
    duration: float | None = None


class ValidateRequest(BaseModel):
    path: str
    expected_width: int
    expected_height: int
    expected_duration: float
    expected_fps: int


class RenderRequest(BaseModel):
    source_path: str
    output_path: str
    start: float
    end: float
    words: list[dict] = Field(default_factory=list)
    subtitle_style: dict
    output_width: int
    output_height: int
    fps: int
    bitrate_kbps: int
    video_codec: str = "h264"
    framing_mode: str
    framing_fallback: str
    manual_offset_x: float | None = None
    loudness_target_lufs: float
    watermark_path: str | None = None
    watermark_position: str | None = None
    intro_path: str | None = None
    outro_path: str | None = None
    background_music_path: str | None = None
    background_music_gain_db: float | None = None


@app.get("/health")
def health() -> dict:
    import subprocess

    try:
        version = subprocess.run([FFMPEG, "-version"], capture_output=True, text=True, timeout=20).stdout.splitlines()[0]
        probe_version = subprocess.run([FFPROBE, "-version"], capture_output=True, text=True, timeout=20).stdout.splitlines()[0]
        return {"status": "ok", "ffmpeg": version, "ffprobe": probe_version, "apiKeyConfigured": bool(API_KEY)}
    except Exception as exc:  # FFmpeg missing means the service cannot work at all
        return {"status": "down", "error": str(exc), "apiKeyConfigured": bool(API_KEY)}


@app.post("/probe", dependencies=[Depends(require_api_key)])
def probe(request: ProbeRequest) -> dict:
    if not os.path.isfile(request.path):
        raise HTTPException(status_code=422, detail={"code": "NOT_FOUND", "message": f"{request.path} does not exist"})
    try:
        summary = renderer.probe_summary(FFPROBE, request.path)
    except renderer.RenderError as exc:
        raise HTTPException(status_code=422, detail={"code": "MEDIA_VALIDATION_FAILED", "message": str(exc)}) from exc
    return {
        "duration_seconds": summary["duration_seconds"],
        "width": summary["width"],
        "height": summary["height"],
        "frame_rate": summary["frame_rate"],
        "video_codec": summary["video_codec"],
        "audio_codec": summary["audio_codec"],
        "audio_channels": summary["audio_channels"],
        "audio_sample_rate": summary["audio_sample_rate"],
        "container": summary["container"],
        "bit_rate": summary["bit_rate"],
        "rotation": summary["rotation"],
        "raw": summary["raw"],
    }


@app.post("/audio-analysis", dependencies=[Depends(require_api_key)])
def audio_analysis(request: AudioRequest) -> dict:
    return audio_mod.analyse(FFMPEG, request.path, request.start, request.duration)


@app.post("/validate", dependencies=[Depends(require_api_key)])
def validate(request: ValidateRequest) -> dict:
    return renderer.validate_output(
        ffmpeg_path=FFMPEG,
        ffprobe_path=FFPROBE,
        output_path=request.path,
        expected_width=request.expected_width,
        expected_height=request.expected_height,
        expected_duration=request.expected_duration,
        expected_fps=request.expected_fps,
    )


@app.post("/render", dependencies=[Depends(require_api_key)])
def render(request: RenderRequest) -> dict:
    if not request.words:
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_FAILED", "message": "word timings are required to burn subtitles"},
        )
    try:
        return renderer.render_clip(
            ffmpeg_path=FFMPEG,
            ffprobe_path=FFPROBE,
            source_path=request.source_path,
            output_path=request.output_path,
            start=request.start,
            end=request.end,
            words=request.words,
            subtitle_style=request.subtitle_style,
            output_width=request.output_width,
            output_height=request.output_height,
            fps=request.fps,
            bitrate_kbps=request.bitrate_kbps,
            video_codec=request.video_codec,
            framing_mode=request.framing_mode,
            framing_fallback=request.framing_fallback,
            manual_offset_x=request.manual_offset_x,
            loudness_target_lufs=request.loudness_target_lufs,
            watermark_path=request.watermark_path,
            watermark_position=request.watermark_position,
            intro_path=request.intro_path,
            outro_path=request.outro_path,
            background_music_path=request.background_music_path,
            background_music_gain_db=request.background_music_gain_db,
        )
    except framing_mod.FramingError as exc:
        raise HTTPException(status_code=422, detail={"code": "FRAMING_FAILED", "message": str(exc)}) from exc
    except renderer.RenderError as exc:
        raise HTTPException(
            status_code=500,
            detail={"code": "RENDER_FAILED", "message": str(exc), "stage": exc.stage, "details": exc.details},
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "VALIDATION_FAILED", "message": str(exc)}) from exc
