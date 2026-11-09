"""Highlight candidate generation, validation, scoring, de-duplication and
dual-duration variant planning.

Design rules encoded here:
 * The model proposes; this module validates. Model timestamps are never trusted
   blindly — they are checked against the transcript and the source duration, and
   snapped to real sentence/word boundaries.
 * The number of clips is emergent: whatever clears the quality gate survives.
   Nothing is padded to hit a target count.
 * A 15 s variant is only produced when it is coherent on its own; if it cannot
   be, the decision is recorded instead of being faked.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

logger = logging.getLogger("ai-engine.selection")

RUBRIC = {
    "hookQuality": 0.16,
    "standaloneMeaning": 0.12,
    "completeness": 0.12,
    "informationalValue": 0.12,
    "emotionalEngagement": 0.10,
    "storytelling": 0.09,
    "audioClarity": 0.07,
    "visualSuitability": 0.07,
    "viewerInterest": 0.10,
    "contextPreservation": 0.05,
}

RUBRIC_DESCRIPTIONS = {
    "hookQuality": "Does the first 1-2 seconds work as a standalone hook?",
    "standaloneMeaning": "Is the moment understandable without the surrounding video?",
    "completeness": "Does it contain a finished thought, not a fragment?",
    "informationalValue": "Does the viewer learn or gain something concrete?",
    "emotionalEngagement": "Does it create emotion, tension, curiosity or surprise?",
    "storytelling": "Is there a micro-narrative with a beginning and payoff?",
    "audioClarity": "Is speech clear, without clipping, mumbling or heavy noise?",
    "visualSuitability": "Is the visual frame composition usable in a vertical crop?",
    "viewerInterest": "Would a cold viewer stop scrolling for this?",
    "contextPreservation": "Does it avoid removing essential context?",
}

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_time": {"type": "number"},
                    "end_time": {"type": "number"},
                    "target_duration": {"type": "integer", "enum": [15, 30]},
                    "hook": {"type": "string"},
                    "reason": {"type": "string"},
                    "transcript": {"type": "string"},
                    "content_category": {
                        "type": "string",
                        "enum": [
                            "educational",
                            "motivational",
                            "storytelling",
                            "surprising_fact",
                            "funny",
                            "advice",
                            "conclusion",
                            "emotional",
                        ],
                    },
                    "quality_score": {"type": "integer"},
                    "confidence": {"type": "number"},
                    "visual_context": {"type": "string"},
                    "scores": {
                        "type": "object",
                        "properties": {key: {"type": "number"} for key in RUBRIC},
                        "required": list(RUBRIC),
                    },
                },
                "required": [
                    "start_time",
                    "end_time",
                    "target_duration",
                    "hook",
                    "reason",
                    "transcript",
                    "content_category",
                    "quality_score",
                    "confidence",
                    "visual_context",
                    "scores",
                ],
            },
        },
        "video_summary": {"type": "string"},
        "content_themes": {"type": "array", "items": {"type": "string"}},
        "no_candidate_reason": {"type": "string"},
    },
    "required": ["candidates", "video_summary"],
}

SYSTEM_INSTRUCTION = """You are a senior short-form video editor who has produced thousands of
high-retention vertical clips. You read a timestamped transcript and representative
frames from one long video, then choose the moments that genuinely deserve to be
published on their own as a 15-second or 30-second vertical clip.

Hard rules:
1. Only choose moments that are complete, standalone thoughts with a real hook.
2. Never start mid-sentence or end mid-thought. Use the provided word timestamps.
3. Never invent content, statistics or quotes — quote the transcript exactly.
4. Never return duplicates or near-identical moments.
5. If the source has only two strong moments, return two. Do not pad the list.
6. If nothing meets the bar, return an empty candidates array and explain why in
   no_candidate_reason.
7. A 15s candidate must be coherent at 15 seconds on its own. Do not shrink a 30s
   moment unless the shorter version genuinely stands alone.
8. Score every candidate with the provided rubric (0-10 per criterion). Be harsh:
   a 9+ means "this would hold a cold viewer's attention".
"""


@dataclass
class Candidate:
    start_time: float
    end_time: float
    target_duration: int
    hook: str
    reason: str
    transcript: str
    content_category: str
    quality_score: int
    confidence: float
    visual_context: str
    scores: dict[str, float]
    validation_notes: list[str] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return round(self.end_time - self.start_time, 3)

    def as_dict(self) -> dict:
        return {
            "start_time": round(self.start_time, 3),
            "end_time": round(self.end_time, 3),
            "target_duration": self.target_duration,
            "hook": self.hook,
            "reason": self.reason,
            "transcript": self.transcript,
            "content_category": self.content_category,
            "quality_score": self.quality_score,
            "confidence": round(self.confidence, 3),
            "visual_context": self.visual_context,
            "scores": self.scores,
            "duration_seconds": self.duration,
            "validation_notes": self.validation_notes,
        }


def compute_quality_score(scores: dict[str, float]) -> int:
    total = 0.0
    weight_sum = 0.0
    for key, weight in RUBRIC.items():
        try:
            value = float(scores.get(key, 0))
        except (TypeError, ValueError):
            continue
        total += max(0.0, min(10.0, value)) * weight
        weight_sum += weight
    if weight_sum == 0:
        return 0
    return int(round((total / weight_sum) * 10))


def build_prompt(
    *,
    transcript_segments: list[dict],
    duration_seconds: float,
    visual_observations: list[dict],
    target_durations: list[int],
    max_candidates: int,
    language: str,
) -> str:
    lines = [
        f"Source length: {duration_seconds:.1f} seconds. Spoken language: {language}.",
        f"Requested clip durations: {', '.join(f'{d}s' for d in target_durations)}.",
        f"Return at most {max_candidates} candidates, and only ones you would publish.",
        "",
        "Representative frames (timestamp: visual description provided by your own vision pass):",
    ]
    for obs in visual_observations:
        lines.append(f"  t={obs['timestamp']:.2f}s — {obs.get('description') or 'no notable visual'}")

    lines += ["", "Timestamped transcript (mm:ss.mmm | text):", ""]
    for segment in transcript_segments:
        start = _fmt(segment["start"])
        lines.append(f"[{start} -> {_fmt(segment['end'])}] {segment['text']}")

    lines += [
        "",
        "For each chosen moment return the exact start_time and end_time in seconds",
        "(decimals allowed) aligned to the transcript boundaries, a hook, a reason,",
        "the exact spoken transcript of that window, a content category, your rubric",
        "scores, an overall quality_score (0-100) and a confidence (0-1).",
        "Set target_duration to the duration the moment is genuinely good at.",
    ]
    return "\n".join(lines)


def _fmt(seconds: float) -> str:
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    return f"{minutes:02d}:{rest:06.3f}"


def validate_and_normalise(
    raw: dict,
    *,
    segments: list[dict],
    duration_seconds: float,
    target_durations: list[int],
    min_quality_score: int,
) -> tuple[list[Candidate], list[dict], dict]:
    """Validates model output against the transcript. Returns (accepted, rejected, summary)."""
    accepted: list[Candidate] = []
    rejected: list[dict] = []
    candidates_raw = raw.get("candidates") or []

    for item in candidates_raw:
        try:
            start = float(item["start_time"])
            end = float(item["end_time"])
            target = int(item["target_duration"])
        except (KeyError, TypeError, ValueError):
            rejected.append({"candidate": item, "reason": "MALFORMED_TIMESTAMPS"})
            continue

        notes: list[str] = []
        if end <= start:
            rejected.append({"candidate": item, "reason": "INVERTED_RANGE"})
            continue
        if start < 0:
            notes.append("negative start clamped to 0")
            start = 0.0
        if end > duration_seconds:
            notes.append(f"end clamped to source duration {duration_seconds:.2f}s")
            end = duration_seconds
        if end - start < 5:
            rejected.append({"candidate": item, "reason": "TOO_SHORT"})
            continue
        if target not in target_durations:
            rejected.append({"candidate": item, "reason": f"TARGET_DURATION_NOT_REQUESTED({target})"})
            continue

        # Snap to real word boundaries: never cut mid-word.
        snapped_start = _snap_to_word_start(segments, start)
        snapped_end = _snap_to_word_end(segments, end)
        if snapped_start is not None and abs(snapped_start - start) < 6:
            if abs(snapped_start - start) > 0.01:
                notes.append(f"start snapped {start:.2f}->{snapped_start:.2f} to word boundary")
            start = snapped_start
        if snapped_end is not None and abs(snapped_end - end) < 6:
            if abs(snapped_end - end) > 0.01:
                notes.append(f"end snapped {end:.2f}->{snapped_end:.2f} to word boundary")
            end = snapped_end

        duration = end - start
        if not (target - 4 <= duration <= target + 4):
            rejected.append(
                {
                    "candidate": item,
                    "reason": f"DURATION_OUT_OF_TOLERANCE({duration:.1f}s vs {target}s target)",
                }
            )
            continue

        spoken = _transcript_for_window(segments, start, end)
        if len(spoken.split()) < 6:
            rejected.append({"candidate": item, "reason": "NO_SPEECH_IN_WINDOW"})
            continue

        model_transcript = str(item.get("transcript", "")).strip()
        similarity = _similarity(spoken, model_transcript)
        if model_transcript and similarity < 0.55:
            notes.append(f"model transcript differed from source ({similarity:.2f} similarity); source text kept")
        if not model_transcript:
            notes.append("model transcript empty; source text substituted")

        scores = {key: _clamp(float(item.get("scores", {}).get(key, 0) or 0), 0, 10) for key in RUBRIC}
        computed = compute_quality_score(scores)
        model_score = _clamp(float(item.get("quality_score", 0) or 0), 0, 100)
        # The rubric is authoritative; the model's headline number may only lower it.
        quality = min(computed, int(model_score)) if model_score else computed
        if computed != int(model_score) and model_score:
            notes.append(f"quality_score recomputed from rubric ({computed}) vs model ({int(model_score)})")

        if quality < min_quality_score:
            rejected.append({"candidate": item, "reason": f"BELOW_MIN_QUALITY({quality})", "quality_score": quality})
            continue

        accepted.append(
            Candidate(
                start_time=round(start, 3),
                end_time=round(end, 3),
                target_duration=target,
                hook=str(item.get("hook", "")).strip()[:280],
                reason=str(item.get("reason", "")).strip()[:800],
                transcript=spoken,
                content_category=str(item.get("content_category", "educational")),
                quality_score=quality,
                confidence=_clamp(float(item.get("confidence", 0.5) or 0.5), 0, 1),
                visual_context=str(item.get("visual_context", ""))[:400],
                scores=scores,
                validation_notes=notes,
            )
        )

    summary = {
        "video_summary": str(raw.get("video_summary", ""))[:2000],
        "content_themes": [str(t)[:80] for t in (raw.get("content_themes") or [])][:10],
        "no_candidate_reason": str(raw.get("no_candidate_reason", ""))[:800],
        "proposed": len(candidates_raw),
        "validated": len(accepted),
        "rejected": len(rejected),
    }
    return accepted, rejected, summary


def deduplicate(
    candidates: list[Candidate],
    *,
    max_clips: int,
    duplicate_threshold: float,
) -> tuple[list[Candidate], list[dict]]:
    """Greedy, quality-ordered de-duplication.

    Two candidates are duplicates when their time windows overlap beyond the
    configured ratio OR their transcripts are near-identical. The better one wins.
    """
    ordered = sorted(candidates, key=lambda c: (c.quality_score, c.confidence), reverse=True)
    kept: list[Candidate] = []
    dropped: list[dict] = []
    for candidate in ordered:
        if len(kept) >= max_clips:
            dropped.append({"candidate": candidate.as_dict(), "reason": "MAX_CLIPS_REACHED"})
            continue
        clash = None
        for existing in kept:
            overlap = _overlap_ratio(
                (existing.start_time, existing.end_time), (candidate.start_time, candidate.end_time)
            )
            similarity = _similarity(existing.transcript, candidate.transcript)
            if overlap >= duplicate_threshold or similarity >= 0.72:
                clash = {
                    "with": {"start": existing.start_time, "end": existing.end_time, "score": existing.quality_score},
                    "overlap": round(overlap, 3),
                    "text_similarity": round(similarity, 3),
                }
                break
        if clash:
            dropped.append({"candidate": candidate.as_dict(), "reason": "DUPLICATE", "detail": clash})
            continue
        kept.append(candidate)
    kept.sort(key=lambda c: c.start_time)
    return kept, dropped


def plan_variants(
    candidates: list[Candidate],
    *,
    segments: list[dict],
    target_durations: list[int],
    min_quality_score: int,
) -> tuple[list[dict], list[dict]]:
    """Builds the final clip plan.

    A moment can yield both a 15 s and a 30 s version only when the 15 s window is
    itself coherent: it must start at the same hook, end on a sentence boundary and
    contain a complete first sentence. Otherwise the decision is recorded — content
    is never padded or cut in half to manufacture a variant.
    """
    plan: list[dict] = []
    decisions: list[dict] = []
    for candidate in candidates:
        plan.append(
            {
                "candidate": candidate.as_dict(),
                "duration_kind": candidate.target_duration,
                "start_time": candidate.start_time,
                "end_time": candidate.end_time,
                "derived": False,
            }
        )
        other = 15 if candidate.target_duration == 30 else 30
        if other not in target_durations:
            decisions.append(
                {
                    "candidate_start": candidate.start_time,
                    "decision": "VARIANT_DURATION_NOT_REQUESTED",
                    "detail": f"{other}s variants were not requested for this job",
                }
            )
            continue

        if other == 15:
            window = _derive_short_window(candidate, segments, min_quality_score=min_quality_score)
            if window is None:
                decisions.append(
                    {
                        "candidate_start": candidate.start_time,
                        "decision": "NO_NATURAL_15S_VARIANT",
                        "detail": "The moment does not contain a self-contained ~15s segment starting at the hook; "
                        "padding or halving would break sentence integrity.",
                    }
                )
                continue
            plan.append(
                {
                    "candidate": {
                        **candidate.as_dict(),
                        "start_time": window["start"],
                        "end_time": window["end"],
                        "target_duration": 15,
                        "transcript": window["text"],
                    },
                    "duration_kind": 15,
                    "start_time": window["start"],
                    "end_time": window["end"],
                    "derived": True,
                    "derivation_note": window["note"],
                }
            )
        else:
            extended = _extend_to_30(candidate, segments, duration_seconds_hint=None)
            if extended is None:
                decisions.append(
                    {
                        "candidate_start": candidate.start_time,
                        "decision": "NO_NATURAL_30S_VARIANT",
                        "detail": "Extending to 30s would require unrelated surrounding speech.",
                    }
                )
                continue
            plan.append(
                {
                    "candidate": {
                        **candidate.as_dict(),
                        "start_time": extended["start"],
                        "end_time": extended["end"],
                        "target_duration": 30,
                        "transcript": extended["text"],
                    },
                    "duration_kind": 30,
                    "start_time": extended["start"],
                    "end_time": extended["end"],
                    "derived": True,
                    "derivation_note": extended["note"],
                }
            )
    return plan, decisions


def _derive_short_window(candidate: Candidate, segments: list[dict], *, min_quality_score: int) -> dict | None:
    words = [w for s in segments for w in s.get("words", []) if w["end"] > candidate.start_time and w["start"] < candidate.end_time]
    if not words:
        return None
    target_end = candidate.start_time + 15
    # Prefer ending on a real pause (gap >= 250 ms) closest to 15 s.
    best = None
    for index, word in enumerate(words):
        if word["end"] - candidate.start_time < 9:
            continue
        if word["end"] - candidate.start_time > 18:
            break
        next_start = words[index + 1]["start"] if index + 1 < len(words) else word["end"] + 1
        gap = next_start - word["end"]
        if gap < 0.25:
            continue
        distance = abs(word["end"] - target_end)
        if best is None or distance < best[0]:
            best = (distance, word["end"], gap)
    if best is None:
        return None
    end = best[1]
    if end - candidate.start_time < 9:
        return None
    text = _transcript_for_window(segments, candidate.start_time, end)
    if len(text.split()) < 5:
        return None
    # Require the short window to retain at least 40% of the speech and to finish
    # a sentence (terminal punctuation or a long pause).
    ends_sentence = text.rstrip().endswith((".", "!", "?")) or best[2] >= 0.5
    if not ends_sentence:
        return None
    return {
        "start": candidate.start_time,
        "end": round(end, 3),
        "text": text,
        "note": f"short variant ends on a {best[2] * 1000:.0f}ms pause near the 15s mark",
    }


def _extend_to_30(candidate: Candidate, segments: list[dict], duration_seconds_hint: float | None) -> dict | None:
    if candidate.duration >= 27:
        end = candidate.start_time + 30
        text = _transcript_for_window(segments, candidate.start_time, end)
        return {"start": candidate.start_time, "end": round(end, 3), "text": text, "note": "extended to 30s inside the same moment"}
    # Extend forward to the next sentence end at ~30s.
    segments_after = [s for s in segments if s["end"] > candidate.end_time]
    collected = candidate.transcript
    end = candidate.end_time
    for segment in segments_after:
        if end - candidate.start_time >= 27:
            break
        collected = f"{collected} {segment['text']}".strip()
        end = segment["end"]
    span = end - candidate.start_time
    if span < 26 or span > 34:
        return None
    return {"start": candidate.start_time, "end": round(end, 3), "text": collected, "note": f"extended to {span:.1f}s on sentence boundary"}


def _snap_to_word_start(segments: list[dict], start: float) -> float | None:
    for segment in segments:
        for word in segment.get("words", []):
            if word["start"] <= start <= word["end"]:
                return float(word["start"])
    return None


def _snap_to_word_end(segments: list[dict], end: float) -> float | None:
    for segment in segments:
        for word in segment.get("words", []):
            if word["start"] <= end <= word["end"]:
                return float(word["end"])
    return None


def _join_words(words: list[str]) -> str:
    """Join ASR word tokens into readable text.

    Whisper prefixes every word with the space that preceded it, so a plain concatenation
    reproduces the sentence exactly. A provider that emits bare tokens (or strips the leading
    space) would collapse a whole window into one "word", which silently failed the six-word
    speech gate and made every candidate look like NO_SPEECH_IN_WINDOW.
    """
    joined = "".join(words)
    if len(words) > 1 and " " not in joined:
        joined = " ".join(words)
    return joined


def _transcript_for_window(segments: list[dict], start: float, end: float) -> str:
    parts = []
    for segment in segments:
        words = [w["word"] for w in segment.get("words", []) if w["end"] > start and w["start"] < end]
        if words:
            parts.append(_join_words(words))
        elif segment["end"] > start and segment["start"] < end:
            parts.append(segment["text"])
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def _similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def _overlap_ratio(a: tuple[float, float], b: tuple[float, float]) -> float:
    overlap = max(0.0, min(a[1], b[1]) - max(a[0], b[0]))
    shorter = min(a[1] - a[0], b[1] - b[0])
    return overlap / shorter if shorter > 0 else 0.0


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))
