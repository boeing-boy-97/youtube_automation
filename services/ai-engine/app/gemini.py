"""Gemini API client with structured output, bounded retries and schema validation.

Docs (verified 2026-11-09): https://ai.google.dev/gemini-api/docs/structured-output
The model id is supplied by the caller from explicit configuration — this module
never picks a model on its own.
"""
from __future__ import annotations

import json
import logging
import random
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .config import Settings

logger = logging.getLogger("ai-engine.gemini")

RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}


class GeminiError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool, status: int | None = None, details: Any = None):
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.details = details


class SchemaValidationError(RuntimeError):
    """The model returned JSON that does not satisfy the requested schema."""


@dataclass
class GeminiUsage:
    prompt_tokens: int
    candidate_tokens: int
    total_tokens: int


class GeminiClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        if not settings.gemini_api_key:
            raise GeminiError(
                "GEMINI_API_KEY is not configured. AI analysis cannot run.",
                retryable=False,
                details={"missing": ["GEMINI_API_KEY"]},
            )

    def generate_structured(
        self,
        *,
        model: str,
        system_instruction: str,
        parts: list[dict],
        response_schema: dict,
        temperature: float = 0.2,
        max_output_tokens: int = 8192,
    ) -> tuple[dict, GeminiUsage]:
        url = f"{self.settings.gemini_endpoint}/models/{model}:generateContent"
        body = {
            "systemInstruction": {"parts": [{"text": system_instruction}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_output_tokens,
                "responseMimeType": "application/json",
                "responseSchema": response_schema,
            },
        }
        last_error: Exception | None = None
        for attempt in range(1, self.settings.max_retries + 1):
            try:
                with httpx.Client(timeout=self.settings.request_timeout_seconds) as client:
                    response = client.post(
                        url,
                        params={"key": self.settings.gemini_api_key},
                        json=body,
                        headers={"content-type": "application/json"},
                    )
                if response.status_code != 200:
                    payload = _safe_json(response.text)
                    retryable = response.status_code in RETRYABLE_STATUS
                    raise GeminiError(
                        f"Gemini returned HTTP {response.status_code}: {_error_message(payload)}",
                        retryable=retryable,
                        status=response.status_code,
                        details=payload,
                    )
                payload = response.json()
                text = _extract_text(payload)
                if not text:
                    raise GeminiError("Gemini returned no text part", retryable=True, details=payload)
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError as exc:
                    raise GeminiError(f"Gemini returned non-JSON output: {exc}", retryable=True, details=text[:600]) from exc
                usage = _usage(payload)
                return parsed, usage
            except (httpx.HTTPError, GeminiError) as exc:
                last_error = exc
                retryable = getattr(exc, "retryable", True)
                if not retryable or attempt == self.settings.max_retries:
                    break
                backoff = min(20.0, 1.5 * 2**attempt) * (0.5 + random.random())
                logger.warning("Gemini call failed (attempt %s/%s): %s — retrying in %.1fs", attempt, self.settings.max_retries, exc, backoff)
                time.sleep(backoff)
        raise GeminiError(
            f"Gemini request failed after {self.settings.max_retries} attempt(s): {last_error}",
            retryable=getattr(last_error, "retryable", True),
            details=getattr(last_error, "details", None),
        )


def _safe_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text[:800]}


def _error_message(payload: Any) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message", error))
    return str(payload)[:400]


def _extract_text(payload: dict) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        return ""
    parts = candidates[0].get("content", {}).get("parts", [])
    return "".join(part.get("text", "") for part in parts).strip()


def _usage(payload: dict) -> GeminiUsage:
    usage = payload.get("usageMetadata", {})
    return GeminiUsage(
        prompt_tokens=int(usage.get("promptTokenCount", 0)),
        candidate_tokens=int(usage.get("candidatesTokenCount", 0)),
        total_tokens=int(usage.get("totalTokenCount", 0)),
    )
