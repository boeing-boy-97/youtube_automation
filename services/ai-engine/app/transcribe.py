"""Accurate transcription with word-level timestamps (faster-whisper).

Timestamps come straight from the model and are never invented or rounded to
whole seconds: clip boundaries and burned-in subtitles depend on them.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .config import Settings

logger = logging.getLogger("ai-engine.transcribe")

_model_cache: dict[tuple[str, str, str], Any] = {}


def _load_model(settings: Settings):
    key = (settings.whisper_model, settings.whisper_device, settings.whisper_compute_type)
    if key in _model_cache:
        return _model_cache[key]
    from faster_whisper import WhisperModel  # imported lazily: heavy dependency

    model = WhisperModel(
        settings.whisper_model,
        device=settings.whisper_device,
        compute_type=settings.whisper_compute_type,
    )
    _model_cache[key] = model
    return model


def transcribe(settings: Settings, audio_path: str | Path, language: str | None = None) -> dict:
    model = _load_model(settings)
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        condition_on_previous_text=False,
    )

    segments: list[dict] = []
    full_text_parts: list[str] = []
    for index, segment in enumerate(segments_iter):
        words = [
            {
                "word": w.word,
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "probability": round(float(w.probability), 4),
            }
            for w in (segment.words or [])
        ]
        segments.append(
            {
                "sequence": index,
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": segment.text.strip(),
                "words": words,
                "avg_logprob": round(float(segment.avg_logprob), 4) if segment.avg_logprob is not None else None,
                "no_speech_prob": round(float(segment.no_speech_prob), 4) if segment.no_speech_prob is not None else None,
                "speaker_label": None,
            }
        )
        full_text_parts.append(segment.text.strip())

    return {
        "language": info.language,
        "language_probability": round(float(info.language_probability), 4),
        "duration_seconds": round(float(info.duration), 3),
        "provider": "faster-whisper",
        "model": settings.whisper_model,
        "word_timestamps": True,
        "full_text": " ".join(full_text_parts).strip(),
        "segments": segments,
    }


def segments_in_window(segments: list[dict], start: float, end: float) -> list[dict]:
    return [s for s in segments if s["end"] > start and s["start"] < end]


def words_in_window(segments: list[dict], start: float, end: float) -> list[dict]:
    out: list[dict] = []
    for segment in segments:
        for word in segment.get("words", []):
            if word["end"] > start and word["start"] < end:
                out.append(word)
    return out


def text_in_window(segments: list[dict], start: float, end: float) -> str:
    return " ".join(s["text"] for s in segments_in_window(segments, start, end)).strip()
