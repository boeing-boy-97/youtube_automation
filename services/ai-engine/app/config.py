"""Runtime configuration for the AI engine.

Nothing here has a silent default for a business-critical decision:
- The AI provider is explicit. There is no fallback provider.
- The fixture provider (used by automated tests without API credentials) must be
  opted into with AI_PROVIDER=fixture AND TEST_MODE=1, otherwise startup fails.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    api_key: str
    provider: str
    gemini_api_key: str | None
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    ffmpeg_path: str
    ffprobe_path: str
    work_dir: str
    max_vision_frames: int
    vision_frame_max_width: int
    gemini_endpoint: str
    request_timeout_seconds: int
    max_retries: int
    test_mode: bool

    @property
    def gemini_configured(self) -> bool:
        return bool(self.gemini_api_key)


def load_settings() -> Settings:
    missing = [k for k in ("AI_ENGINE_API_KEY", "WHISPER_MODEL", "WORK_DIR", "FFMPEG_PATH", "FFPROBE_PATH") if not os.environ.get(k)]
    if missing:
        raise ConfigurationError(f"Missing required environment variables: {', '.join(missing)}")

    provider = os.environ.get("AI_PROVIDER", "")
    if not provider:
        raise ConfigurationError("AI_PROVIDER must be set explicitly (gemini | fixture)")
    if provider not in ("gemini", "fixture"):
        raise ConfigurationError(f"Unsupported AI_PROVIDER '{provider}'")
    test_mode = os.environ.get("TEST_MODE") == "1"
    if provider == "fixture" and not test_mode:
        raise ConfigurationError(
            "AI_PROVIDER=fixture is only permitted in isolated automated test environments (set TEST_MODE=1). "
            "Production must use AI_PROVIDER=gemini."
        )

    return Settings(
        api_key=os.environ["AI_ENGINE_API_KEY"],
        provider=provider,
        gemini_api_key=os.environ.get("GEMINI_API_KEY") or None,
        whisper_model=os.environ["WHISPER_MODEL"],
        whisper_device=os.environ.get("WHISPER_DEVICE", "cpu"),
        whisper_compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        ffmpeg_path=os.environ["FFMPEG_PATH"],
        ffprobe_path=os.environ["FFPROBE_PATH"],
        work_dir=os.environ["WORK_DIR"],
        max_vision_frames=int(os.environ.get("MAX_VISION_FRAMES", "16")),
        vision_frame_max_width=int(os.environ.get("VISION_FRAME_MAX_WIDTH", "512")),
        gemini_endpoint=os.environ.get("GEMINI_ENDPOINT", "https://generativelanguage.googleapis.com/v1beta"),
        request_timeout_seconds=int(os.environ.get("AI_REQUEST_TIMEOUT_SECONDS", "180")),
        max_retries=int(os.environ.get("AI_MAX_RETRIES", "3")),
        test_mode=test_mode,
    )
