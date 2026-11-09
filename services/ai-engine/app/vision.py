"""Visual intelligence: describe representative frames with a vision model.

Cost control: only frames that survived scene-detection + de-duplication are sent,
they are downscaled to `VISION_FRAME_MAX_WIDTH`, and they are batched into a single
call. Nothing is sent for the full video.
"""
from __future__ import annotations

import base64
import logging
import math
from pathlib import Path

from .gemini import GeminiClient
from .config import Settings

logger = logging.getLogger("ai-engine.vision")

VISION_SCHEMA = {
    "type": "object",
    "properties": {
        "observations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "timestamp": {"type": "number"},
                    "description": {"type": "string"},
                    "faces_present": {"type": "integer"},
                    "shot_type": {"type": "string", "enum": ["talking_head", "presentation", "b_roll", "screen_recording", "group", "other"]},
                    "on_screen_text": {"type": "string"},
                    "vertical_crop_risk": {"type": "string", "enum": ["low", "medium", "high"]},
                },
                "required": ["timestamp", "description", "faces_present", "shot_type"],
            },
        },
        "speaker_layout": {"type": "string"},
    },
    "required": ["observations"],
}

SYSTEM_INSTRUCTION = """You analyse video frames for a vertical short-form editing tool.
For each frame describe only what is visible: who is speaking (approximate face count),
shot type, any on-screen text, and the risk that a 9:16 centre crop would cut off the
subject. Never guess context that is not in the image."""


def describe_frames(settings: Settings, client: GeminiClient, frames: list[dict], model: str) -> list[dict]:
    if not frames:
        return []
    # Batch to keep prompt size and latency predictable (max 8 frames per call).
    batch_size = 8
    observations: list[dict] = []
    for start in range(0, len(frames), batch_size):
        batch = frames[start : start + batch_size]
        parts: list[dict] = [
            {
                "text": (
                    "Describe these frames. The timestamp of each frame is given before it. "
                    "Return one observation per frame, in the same order, using the frame timestamp."
                )
            }
        ]
        for frame in batch:
            parts.append({"text": f"Frame at t={frame['timestamp']:.2f}s:"})
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": _b64(frame["path"])}})
        try:
            payload, _usage = client.generate_structured(
                model=model,
                system_instruction=SYSTEM_INSTRUCTION,
                parts=parts,
                response_schema=VISION_SCHEMA,
                temperature=0.1,
                max_output_tokens=3072,
            )
        except Exception as exc:  # vision is additive: log, keep going with what we have
            logger.warning("Vision pass failed for batch starting at %s: %s", start, exc)
            continue
        for observation in payload.get("observations", []):
            try:
                observations.append(
                    {
                        "timestamp": float(observation.get("timestamp", 0)),
                        "description": str(observation.get("description", ""))[:400],
                        "faces_present": int(observation.get("faces_present", 0)),
                        "shot_type": str(observation.get("shot_type", "other")),
                        "on_screen_text": str(observation.get("on_screen_text", ""))[:200],
                        "vertical_crop_risk": str(observation.get("vertical_crop_risk", "medium")),
                    }
                )
            except (TypeError, ValueError):
                continue
    observations.sort(key=lambda o: o["timestamp"])
    return observations


def summarise_layout(observations: list[dict]) -> dict:
    if not observations:
        return {"frames": 0, "note": "No frames analysed"}
    faces = [o["faces_present"] for o in observations]
    shot_counts: dict[str, int] = {}
    for observation in observations:
        shot_counts[observation["shot_type"]] = shot_counts.get(observation["shot_type"], 0) + 1
    dominant = max(shot_counts.items(), key=lambda kv: kv[1])[0]
    return {
        "frames": len(observations),
        "average_faces": round(sum(faces) / len(faces), 2),
        "max_faces": max(faces),
        "dominant_shot_type": dominant,
        "high_crop_risk_frames": sum(1 for o in observations if o["vertical_crop_risk"] == "high"),
    }


def nearest_observation(observations: list[dict], timestamp: float) -> dict | None:
    if not observations:
        return None
    return min(observations, key=lambda o: abs(o["timestamp"] - timestamp))


def _b64(path: str) -> str:
    data = Path(path).read_bytes()
    return base64.b64encode(data).decode("ascii")


def estimate_frame_count(duration_seconds: float, max_frames: int) -> int:
    """Longer videos get more frames, but never more than the configured budget."""
    if duration_seconds <= 0:
        return 1
    return max(2, min(max_frames, int(math.ceil(duration_seconds / 45)) + 4))
