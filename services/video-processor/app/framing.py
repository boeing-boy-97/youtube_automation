"""Intelligent vertical framing.

Face detection uses OpenCV's Haar cascade (CPU-only, no model download) sampled at
a fixed rate, then a temporal tracker smooths the crop window so the subject does
not jitter. When tracking cannot find a face for a meaningful share of the clip we
NEVER silently switch strategy: the caller's explicitly configured fallback is
used (centre crop, background blur, or hard failure) and the decision is written
into the render report.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger("video-processor.framing")

SAMPLE_INTERVAL_SECONDS = 0.5
MAX_KEYFRAME_GAP_SECONDS = 2.0


@dataclass
class FramingResult:
    mode: str
    keyframes: list[dict] = field(default_factory=list)
    tracked_frames: int = 0
    total_frames: int = 0
    faces_found: int = 0
    fallback_used: bool = False
    note: str = ""
    crop_x_constant: float | None = None

    @property
    def coverage(self) -> float:
        return (self.tracked_frames / self.total_frames) if self.total_frames else 0.0

    def as_report(self) -> dict:
        return {
            "mode": self.mode,
            "trackedFrames": self.tracked_frames,
            "totalFrames": self.total_frames,
            "facesFound": self.faces_found,
            "coverage": round(self.coverage, 3),
            "fallbackUsed": self.fallback_used,
            "note": self.note,
            "keyframes": self.keyframes,
        }


class FramingError(RuntimeError):
    pass


def plan_framing(
    *,
    video_path: str,
    clip_start: float,
    clip_end: float,
    source_width: int,
    source_height: int,
    output_aspect: float,
    mode: str,
    fallback: str,
    manual_offset_x: float | None = None,
) -> FramingResult:
    crop_width = min(source_width, int(round(source_height * output_aspect)))
    max_x = max(0, source_width - crop_width)

    if mode == "center_crop":
        return FramingResult(mode=mode, crop_x_constant=max_x / 2, note="centre crop requested by configuration")

    if mode == "manual":
        offset = 0.5 if manual_offset_x is None else max(0.0, min(1.0, manual_offset_x))
        return FramingResult(mode=mode, crop_x_constant=max_x * offset, note=f"manual offset {offset:.2f}")

    if mode == "background_blur":
        return FramingResult(mode=mode, crop_x_constant=None, note="background blur composition; subject fitted with boxblur backdrop")

    if mode != "face_track":
        raise FramingError(f"Unknown framing mode '{mode}'")

    try:
        import cv2
    except ImportError as exc:  # pragma: no cover - dependency is pinned
        return _apply_fallback(mode, fallback, max_x, "OpenCV is unavailable in this container", fallback_result=True)

    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        return _apply_fallback(mode, fallback, max_x, "OpenCV could not open the video", fallback_result=True)
    try:
        classifier = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        if classifier.empty():
            return _apply_fallback(mode, fallback, max_x, "Haar cascade model missing", fallback_result=True)

        detections: list[tuple[float, float]] = []
        time_point = clip_start
        total = 0
        faces = 0
        while time_point < clip_end:
            capture.set(cv2.CAP_PROP_POS_MSEC, time_point * 1000)
            ok, frame = capture.read()
            total += 1
            if not ok:
                time_point += SAMPLE_INTERVAL_SECONDS
                continue
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            found = classifier.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(48, 48))
            if len(found) > 0:
                # Track the largest face (predictable behaviour for talking heads).
                x, y, w, h = max(found, key=lambda rect: rect[2] * rect[3])
                centre = x + w / 2
                faces += 1
                detections.append((time_point, centre))
            time_point += SAMPLE_INTERVAL_SECONDS

        if total == 0:
            return _apply_fallback(mode, fallback, max_x, "No frames decoded for tracking", fallback_result=True)

        coverage = len(detections) / total
        if coverage < 0.35:
            return _apply_fallback(
                mode,
                fallback,
                max_x,
                f"Face tracking found a subject in only {coverage * 100:.0f}% of sampled frames",
                fallback_result=False,
                tracked=len(detections),
                total=total,
                faces=faces,
            )

        smoothed = _smooth(detections, clip_start, clip_end)
        keyframes = []
        for timestamp, centre in smoothed:
            crop_x = max(0.0, min(float(max_x), centre - crop_width / 2))
            keyframes.append({"t": round(timestamp, 3), "x": round(crop_x, 2)})
        return FramingResult(
            mode=mode,
            keyframes=keyframes,
            tracked_frames=len(detections),
            total_frames=total,
            faces_found=faces,
            note=f"tracked a face in {coverage * 100:.0f}% of {total} sampled frames",
        )
    finally:
        capture.release()


def _smooth(detections: list[tuple[float, float]], clip_start: float, clip_end: float) -> list[tuple[float, float]]:
    """Exponential smoothing plus keyframe filling so crop motion is continuous."""
    if not detections:
        return []
    alpha = 0.35
    smoothed: list[tuple[float, float]] = []
    previous = detections[0][1]
    for timestamp, centre in detections:
        previous = alpha * centre + (1 - alpha) * previous
        smoothed.append((timestamp, previous))
    # Always keyframe the clip start and end so the expression covers the range.
    if smoothed[0][0] > clip_start:
        smoothed.insert(0, (clip_start, smoothed[0][1]))
    if smoothed[-1][0] < clip_end:
        smoothed.append((clip_end, smoothed[-1][1]))
    # Enforce a maximum gap so fast pans are followed.
    filled: list[tuple[float, float]] = []
    for index, (timestamp, centre) in enumerate(smoothed):
        filled.append((timestamp, centre))
        if index + 1 < len(smoothed):
            next_ts, next_centre = smoothed[index + 1]
            gap = next_ts - timestamp
            if gap > MAX_KEYFRAME_GAP_SECONDS:
                steps = int(gap // MAX_KEYFRAME_GAP_SECONDS)
                for step in range(1, steps + 1):
                    ratio = step / (steps + 1)
                    filled.append((timestamp + gap * ratio, centre + (next_centre - centre) * ratio))
    return filled


def _apply_fallback(
    mode: str,
    fallback: str,
    max_x: int,
    note: str,
    *,
    fallback_result: bool,
    tracked: int = 0,
    total: int = 0,
    faces: int = 0,
) -> FramingResult:
    if fallback == "fail":
        raise FramingError(
            f"{note}. Face tracking was requested and the configured fallback is 'fail', "
            "so no clip was rendered. Re-run with an explicit framing mode."
        )
    if fallback == "background_blur":
        logger.warning("%s — using explicitly configured fallback: background_blur", note)
        return FramingResult(
            mode="background_blur",
            fallback_used=True,
            note=f"{note}; explicit fallback background_blur applied",
            tracked_frames=tracked,
            total_frames=total,
            faces_found=faces,
        )
    logger.warning("%s — using explicitly configured fallback: center_crop", note)
    return FramingResult(
        mode="center_crop",
        crop_x_constant=max_x / 2,
        fallback_used=True,
        note=f"{note}; explicit fallback center_crop applied",
        tracked_frames=tracked,
        total_frames=total,
        faces_found=faces,
    )


def crop_x_expression(result: FramingResult, relative: bool = True) -> str | None:
    """Builds an FFmpeg expression for the crop x offset over time.

    `relative=True` produces the expression in terms of t (seconds from clip start).
    Piecewise-linear interpolation over the tracked keyframes.
    """
    if result.crop_x_constant is not None:
        return f"{result.crop_x_constant:.2f}"
    if not result.keyframes:
        return None
    pts = [(k["t"], k["x"]) for k in result.keyframes]
    if relative:
        origin = pts[0][0]
        pts = [(t - origin, x) for t, x in pts]
    expression = f"{pts[-1][1]:.2f}"
    for index in range(len(pts) - 1, 0, -1):
        t0, x0 = pts[index - 1]
        t1, x1 = pts[index]
        span = max(t1 - t0, 0.001)
        slope = (x1 - x0) / span
        segment = f"{x0:.2f}+({slope:.4f})*(t-{t0:.3f})"
        expression = f"if(lt(t,{t1:.3f}),{segment},{expression})"
    return expression
