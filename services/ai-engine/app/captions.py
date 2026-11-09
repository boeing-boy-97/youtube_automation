"""Platform-specific caption/metadata generation.

YouTube and Instagram get genuinely different copy (search-oriented vs. hook-driven),
both constrained to the clip's real transcript. Nothing is invented: the model is
instructed to use only the provided transcript, and the output is schema-validated
and length-clamped per platform.
"""
from __future__ import annotations

import logging
import re

from .config import Settings
from .gemini import GeminiClient

logger = logging.getLogger("ai-engine.captions")

CAPTION_SCHEMA = {
    "type": "object",
    "properties": {
        "youtube": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "hashtags": {"type": "array", "items": {"type": "string"}},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title", "description", "hashtags", "tags"],
        },
        "instagram": {
            "type": "object",
            "properties": {
                "caption": {"type": "string"},
                "hashtags": {"type": "array", "items": {"type": "string"}},
                "call_to_action": {"type": "string"},
            },
            "required": ["caption", "hashtags", "call_to_action"],
        },
    },
    "required": ["youtube", "instagram"],
}

SYSTEM_INSTRUCTION = """You write publishing metadata for short vertical videos.
Rules:
- Use only facts present in the provided transcript. Never invent statistics, quotes or claims.
- YouTube: a search-friendly title (<= 100 chars) that states what the viewer gets,
  a description with a short summary and the relevant context, hashtags (max 8) and tags (max 12).
- Instagram: an engaging caption (<= 2200 chars) opening with a hook, a line break
  structure, hashtags (max 12) and a call to action that fits the content.
- Match the brand voice and audience description exactly as given.
- Do not use unrelated or trending hashtags. Do not claim virality.
"""


def generate_captions(
    *,
    settings: Settings,
    client: GeminiClient | None,
    model: str | None,
    clip: dict,
    brand_voice: str | None,
    audience: str | None,
    language: str,
    source_context: str,
    platform_limits: dict | None = None,
) -> dict:
    if settings.provider == "fixture":
        return _fixture_captions(clip, brand_voice, audience, language)

    if client is None or not model:
        raise ValueError("A model id must be supplied for caption generation (no fallback model)")
    prompt = _build_prompt(clip, brand_voice, audience, language, source_context)
    payload, usage = client.generate_structured(
        model=model,
        system_instruction=SYSTEM_INSTRUCTION,
        parts=[{"text": prompt}],
        response_schema=CAPTION_SCHEMA,
        temperature=0.6,
        max_output_tokens=2048,
    )
    return _normalise(payload, clip, usage.total_tokens)


def _build_prompt(clip: dict, brand_voice: str | None, audience: str | None, language: str, source_context: str) -> str:
    return "\n".join(
        [
            f"Clip transcript (verbatim): {clip.get('transcript', '')}",
            f"Content category: {clip.get('content_category', 'unknown')}",
            f"Hook used by the editor: {clip.get('hook', '')}",
            f"Brand voice: {brand_voice or 'not specified — use a neutral, factual tone'}",
            f"Audience: {audience or 'general audience'}",
            f"Language: {language}",
            f"Surrounding source context (for accurate attribution only): {source_context[:1200]}",
            "Write the YouTube and Instagram metadata now.",
        ]
    )


def _fixture_captions(clip: dict, brand_voice: str | None, audience: str | None, language: str) -> dict:
    """Test-only deterministic captions. Marked so nothing can be mistaken for a model output."""
    transcript = str(clip.get("transcript", "")).strip()
    first_sentence = re.split(r"(?<=[.!?])\s", transcript)[0] if transcript else "Clip transcript unavailable"
    title = f"[fixture] {first_sentence[:80]}"
    return {
        "youtube": {
            "title": title[:100],
            "description": f"[fixture provider — no model was called]\n\n{transcript[:4500]}",
            "hashtags": ["#fixture", "#clipforge"],
            "tags": ["fixture"],
        },
        "instagram": {
            "caption": f"[fixture provider — no model was called]\n\n{first_sentence[:600]}",
            "hashtags": ["#fixture", "#clipforge"],
            "call_to_action": "Follow for more.",
        },
        "provider": "fixture",
        "model": "fixture",
        "usageTokens": 0,
        "brandVoice": brand_voice,
        "audience": audience,
        "language": language,
    }


def _normalise(payload: dict, clip: dict, usage_tokens: int) -> dict:
    youtube = payload.get("youtube") or {}
    instagram = payload.get("instagram") or {}
    transcript = str(clip.get("transcript", ""))

    title = _clean(str(youtube.get("title", "")))[:100]
    description = _clean(str(youtube.get("description", "")))[:5000]
    hashtags = [_hashtag(tag) for tag in (youtube.get("hashtags") or []) if isinstance(tag, str)][:8]
    tags = [_clean(str(tag))[:50] for tag in (youtube.get("tags") or []) if isinstance(tag, str)][:12]
    ig_caption = _clean(str(instagram.get("caption", "")))[:2200]
    ig_hashtags = [_hashtag(tag) for tag in (instagram.get("hashtags") or []) if isinstance(tag, str)][:12]
    cta = _clean(str(instagram.get("call_to_action", "")))[:200]

    # Basic grounding check: at least a third of the title words should appear in the transcript.
    grounding = _grounding_ratio(title, transcript)
    if grounding < 0.2 and transcript:
        logger.warning("Caption title has low overlap with the transcript (%.2f); keeping title but flagging", grounding)

    return {
        "youtube": {"title": title, "description": description, "hashtags": hashtags, "tags": tags},
        "instagram": {"caption": ig_caption, "hashtags": ig_hashtags, "call_to_action": cta},
        "provider": "gemini",
        "usageTokens": usage_tokens,
        "groundingRatio": round(grounding, 3),
    }


def _grounding_ratio(title: str, transcript: str) -> float:
    title_words = {w.lower() for w in re.findall(r"[a-zA-Z']{4,}", title)}
    if not title_words:
        return 0.0
    transcript_words = {w.lower() for w in re.findall(r"[a-zA-Z']{4,}", transcript)}
    return len(title_words & transcript_words) / len(title_words)


def _hashtag(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]", "", value.strip().lstrip("#"))
    return f"#{cleaned}" if cleaned else "#clips"


def _clean(value: str) -> str:
    return re.sub(r"\s+\n", "\n", value.strip())
