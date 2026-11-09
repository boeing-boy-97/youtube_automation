"""Full analysis pipeline: inspect → extract audio → transcribe → see → understand
→ validate → de-duplicate → plan dual-duration variants."""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from . import fixture_provider, media, selection, vision
from .config import Settings
from .gemini import GeminiClient, GeminiError, SchemaValidationError
from .transcribe import transcribe

logger = logging.getLogger("ai-engine.pipeline")


class AnalysisRequestError(RuntimeError):
    pass


def analyze(settings: Settings, request: dict) -> dict:
    started = time.time()
    video_path = Path(request["video_path"])
    if not video_path.is_file():
        raise AnalysisRequestError(f"video_path does not exist: {video_path}")

    job_dir = Path(settings.work_dir) / str(request["job_id"])
    job_dir.mkdir(parents=True, exist_ok=True)

    text_model = request.get("text_model")
    vision_model = request.get("vision_model")
    target_durations = [int(d) for d in request.get("target_durations", [15, 30])]
    max_candidates = int(request.get("max_candidates", 12))
    max_clips = int(request.get("max_clips", 6))
    min_quality = int(request.get("min_quality_score", 70))
    duplicate_threshold = float(request.get("duplicate_threshold", 0.35))
    language = request.get("language") or None

    if settings.provider == "gemini" and not text_model:
        raise AnalysisRequestError("text_model must be supplied explicitly (no model fallback exists)")

    stages: dict[str, dict] = {}

    # ---- Stage 1: inspection
    probe = media.probe(settings, video_path)
    stages["inspection"] = {"ok": True, "probe": probe.as_dict()}
    if probe.audio_codec is None:
        raise AnalysisRequestError("Source has no audio stream; transcription is impossible")

    # ---- Stage 2: audio extraction
    audio_path = media.extract_audio(settings, video_path, job_dir / "audio.wav")
    stages["audio_extraction"] = {"ok": True, "path": str(audio_path), "bytes": audio_path.stat().st_size}

    # ---- Stage 3: transcription (real, word-level). When the orchestrator already
    # ran the TRANSCRIBING stage, its transcript is reused instead of recomputed.
    transcript_started = time.time()
    reused = request.get("transcript")
    if reused and reused.get("segments"):
        transcript = reused
        reused_flag = True
    else:
        transcript = transcribe(settings, audio_path, language=language)
        reused_flag = False
    segments = transcript["segments"]
    if not segments:
        raise AnalysisRequestError(
            "Transcription produced no speech segments. The source may be silent or music-only, "
            "so no highlight can be identified honestly."
        )
    stages["transcription"] = {
        "ok": True,
        "language": transcript["language"],
        "language_probability": transcript["language_probability"],
        "segments": len(segments),
        "words": sum(len(s["words"]) for s in segments),
        "duration_ms": int((time.time() - transcript_started) * 1000),
        "model": transcript["model"],
        "reused": reused_flag,
    }

    # ---- Stage 4: visual intelligence
    vision_started = time.time()
    frames: list[dict] = []
    observations: list[dict] = []
    if request.get("enable_vision", True):
        scene_times = media.detect_scenes(settings, video_path)
        budget = vision.estimate_frame_count(probe.duration_seconds, settings.max_vision_frames)
        frames = media.sample_frames(settings, video_path, job_dir / "frames", scene_times, probe.duration_seconds, budget)
        if settings.provider == "gemini":
            client = GeminiClient(settings)
            if not vision_model:
                raise AnalysisRequestError("vision_model must be supplied explicitly")
            observations, vision_usage = vision.describe_frames(settings, client, frames, vision_model)
        else:
            observations = fixture_provider.describe_frames(frames)
            vision_usage = {"prompt_tokens": 0, "candidate_tokens": 0, "total_tokens": 0, "calls": 0}
        stages["vision"] = {
            "ok": True,
            "frames_sampled": len(frames),
            "scene_changes": len(scene_times),
            "observations": len(observations),
            "layout": vision.summarise_layout(observations),
            "usage": vision_usage,
            "duration_ms": int((time.time() - vision_started) * 1000),
        }
    else:
        stages["vision"] = {"ok": True, "skipped": "enable_vision=false"}

    # ---- Stage 5: AI understanding → structured candidates
    ai_started = time.time()
    usage = {"prompt_tokens": 0, "candidate_tokens": 0, "total_tokens": 0}
    if settings.provider == "gemini":
        client = GeminiClient(settings)
        prompt = selection.build_prompt(
            transcript_segments=segments,
            duration_seconds=probe.duration_seconds,
            visual_observations=observations,
            target_durations=target_durations,
            max_candidates=max_candidates,
            language=transcript["language"],
        )
        try:
            raw, gemini_usage = client.generate_structured(
                model=text_model,
                system_instruction=selection.SYSTEM_INSTRUCTION,
                parts=[{"text": prompt}],
                response_schema=selection.RESPONSE_SCHEMA,
                temperature=0.25,
                max_output_tokens=8192,
            )
        except GeminiError as exc:
            stages["ai_analysis"] = {"ok": False, "error": str(exc), "retryable": exc.retryable}
            raise
        usage = {
            "prompt_tokens": gemini_usage.prompt_tokens,
            "candidate_tokens": gemini_usage.candidate_tokens,
            "total_tokens": gemini_usage.total_tokens,
        }
        provider_name = "gemini"
    else:
        raw = fixture_provider.propose_candidates(
            segments=segments,
            duration_seconds=probe.duration_seconds,
            target_durations=target_durations,
            max_candidates=max_candidates,
        )
        provider_name = "fixture"

    stages["ai_analysis"] = {
        "ok": True,
        "provider": provider_name,
        "model": text_model if provider_name == "gemini" else "fixture",
        "proposed": len(raw.get("candidates", [])),
        "duration_ms": int((time.time() - ai_started) * 1000),
        "usage": usage,
    }

    # ---- Stage 6: validation, scoring, de-duplication, variant planning
    accepted, rejected, summary = selection.validate_and_normalise(
        raw,
        segments=segments,
        duration_seconds=probe.duration_seconds,
        target_durations=target_durations,
        min_quality_score=min_quality,
    )
    kept, duplicates = selection.deduplicate(accepted, max_clips=max_clips, duplicate_threshold=duplicate_threshold)
    plan, decisions = selection.plan_variants(
        kept,
        segments=segments,
        target_durations=target_durations,
        min_quality_score=min_quality,
    )

    # Attach visual context per clip.
    for entry in plan:
        observation = vision.nearest_observation(observations, entry["start_time"])
        entry["visual_context"] = observation["description"] if observation else (entry["candidate"].get("visual_context") or "")

    report = {
        "provider": provider_name,
        "model": text_model if provider_name == "gemini" else "fixture",
        "vision_model": vision_model if provider_name == "gemini" else "fixture",
        "video_summary": summary["video_summary"],
        "content_themes": summary["content_themes"],
        "no_candidate_reason": summary["no_candidate_reason"],
        "proposed": summary["proposed"],
        "validated": summary["validated"],
        "rejected": summary["rejected"],
        "duplicates_dropped": len(duplicates),
        "clips_planned": len(plan),
        "min_quality_score": min_quality,
        "max_clips": max_clips,
        "rubric": selection.RUBRIC,
        "stages": stages,
        # `total_tokens` stays the sum of every model call so existing consumers keep working.
        "usage": {
            "text": usage,
            "vision": vision_usage,
            "prompt_tokens": usage["prompt_tokens"] + vision_usage["prompt_tokens"],
            "candidate_tokens": usage["candidate_tokens"] + vision_usage["candidate_tokens"],
            "total_tokens": usage["total_tokens"] + vision_usage["total_tokens"],
        },
        "elapsed_ms": int((time.time() - started) * 1000),
    }

    # Honest empty result: the caller must surface this to the user, never fake clips.
    if not plan:
        report["outcome"] = "NO_QUALITY_CANDIDATES"
        report["explanation"] = summary["no_candidate_reason"] or (
            "No candidate met the configured quality threshold "
            f"({min_quality}/100) after validation and duplicate suppression."
        )

    return {
        "job_id": request["job_id"],
        "probe": probe.as_dict(),
        "transcript": transcript,
        "observations": observations,
        "frames": frames,
        "plan": plan,
        "rejected_candidates": rejected,
        "duplicates_dropped": duplicates,
        "variant_decisions": decisions,
        "report": report,
    }


def persist_artifacts(result: dict, work_dir: str) -> dict:
    """Writes the analysis artefacts next to the job so the API can store them."""
    job_dir = Path(work_dir) / result["job_id"]
    job_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, payload in (
        ("analysis.json", {k: v for k, v in result.items() if k not in ("transcript", "frames")}),
        ("transcript.json", result["transcript"]),
    ):
        path = job_dir / name
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        paths[name] = str(path)
    return paths
