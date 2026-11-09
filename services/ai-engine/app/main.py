"""AI engine HTTP service.

Endpoints
  GET  /health    — liveness + capability report (never claims readiness it lacks)
  POST /transcribe — transcription only (used by the transcribe stage in isolation)
  POST /analyze    — full analysis pipeline

Authentication: static service token in `x-api-key` (service-to-service only; the
public API never exposes this service).
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .config import ConfigurationError, Settings, load_settings
from .gemini import GeminiError, SchemaValidationError
from . import captions as captions_mod
from . import media, pipeline
from .gemini import GeminiClient
from .transcribe import transcribe

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "info").upper(), format='{"level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}')
logger = logging.getLogger("ai-engine")

app = FastAPI(title="ClipForge AI Engine", version="1.0.0")

_settings: Settings | None = None
_settings_error: str | None = None
_settings_lock = threading.Lock()


def settings() -> Settings:
    global _settings, _settings_error
    with _settings_lock:
        if _settings is None and _settings_error is None:
            try:
                _settings = load_settings()
            except ConfigurationError as exc:
                _settings_error = str(exc)
                logger.error("Configuration error: %s", exc)
    if _settings is None:
        raise HTTPException(status_code=503, detail={"code": "CONFIGURATION_REQUIRED", "message": _settings_error or "not configured"})
    return _settings


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    cfg = settings()
    if not x_api_key or x_api_key != cfg.api_key:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED", "message": "Invalid service API key"})


class TranscribeRequest(BaseModel):
    audio_path: str | None = None
    video_path: str | None = None
    language: str | None = None
    job_id: str = Field(default="adhoc")


class AnalyzeRequest(BaseModel):
    job_id: str
    video_path: str
    text_model: str | None = None
    vision_model: str | None = None
    target_durations: list[int] = Field(default_factory=lambda: [15, 30])
    max_candidates: int = 12
    max_clips: int = 6
    min_quality_score: int = 70
    duplicate_threshold: float = 0.35
    language: str | None = None
    enable_vision: bool = True
    # Optional reuse of a transcript already produced by the TRANSCRIBING stage.
    transcript: dict | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        cfg = settings()
    except HTTPException as exc:
        return {"status": "unconfigured", "detail": exc.detail}
    return {
        "status": "ok",
        "provider": cfg.provider,
        "geminiConfigured": cfg.gemini_configured,
        "whisperModel": cfg.whisper_model,
        "testMode": cfg.test_mode,
        "ffmpeg": cfg.ffmpeg_path,
        "ffprobe": cfg.ffprobe_path,
        "visionFramesBudget": cfg.max_vision_frames,
    }


class CaptionClip(BaseModel):
    clip_id: str
    transcript: str
    hook: str | None = None
    content_category: str | None = None


class CaptionsRequest(BaseModel):
    model: str
    clips: list[CaptionClip]
    brand_voice: str | None = None
    audience: str | None = None
    language: str = "en"
    source_context: str = ""


@app.post("/captions", dependencies=[Depends(require_api_key)])
def captions_endpoint(request: CaptionsRequest) -> dict:
    cfg = settings()
    client = GeminiClient(cfg) if cfg.provider == "gemini" else None
    results = []
    for clip in request.clips:
        try:
            metadata = captions_mod.generate_captions(
                settings=cfg,
                client=client,
                model=request.model,
                clip=clip.model_dump(),
                brand_voice=request.brand_voice,
                audience=request.audience,
                language=request.language,
                source_context=request.source_context,
            )
            results.append({"clipId": clip.clip_id, "ok": True, "metadata": metadata})
        except Exception as exc:  # one failing clip must not sink the others
            logger.warning("caption generation failed for %s: %s", clip.clip_id, exc)
            results.append({"clipId": clip.clip_id, "ok": False, "error": str(exc)})
    return {"provider": cfg.provider, "model": request.model, "results": results}


@app.post("/transcribe", dependencies=[Depends(require_api_key)])
def transcribe_endpoint(request: TranscribeRequest) -> dict:
    cfg = settings()
    source = request.video_path or request.audio_path
    if not source:
        raise HTTPException(status_code=422, detail="video_path or audio_path is required")
    try:
        if request.audio_path and not request.video_path:
            result = transcribe(cfg, request.audio_path, language=request.language)
        else:
            audio = media.extract_audio(cfg, request.video_path, f"{cfg.work_dir}/{request.job_id}/audio.wav")
            result = transcribe(cfg, audio, language=request.language)
    except Exception as exc:  # transcription failures must be visible, not retried silently
        logger.exception("transcription failed")
        raise HTTPException(status_code=500, detail={"code": "TRANSCRIPTION_FAILED", "message": str(exc)}) from exc
    return {"provider": cfg.provider, "transcription": result}


@app.post("/analyze", dependencies=[Depends(require_api_key)])
def analyze_endpoint(request: AnalyzeRequest) -> dict:
    cfg = settings()
    payload = request.model_dump()
    try:
        result = pipeline.analyze(cfg, payload)
        artifacts = pipeline.persist_artifacts(result, cfg.work_dir)
        result["artifacts"] = artifacts
        return result
    except pipeline.AnalysisRequestError as exc:
        raise HTTPException(status_code=422, detail={"code": "ANALYSIS_REJECTED", "message": str(exc)}) from exc
    except GeminiError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "AI_PROVIDER_ERROR", "message": str(exc), "retryable": exc.retryable},
        ) from exc
    except SchemaValidationError as exc:
        raise HTTPException(status_code=502, detail={"code": "AI_SCHEMA_INVALID", "message": str(exc)}) from exc
    except Exception as exc:
        logger.exception("analysis failed")
        raise HTTPException(status_code=500, detail={"code": "INTERNAL_ERROR", "message": str(exc)}) from exc
