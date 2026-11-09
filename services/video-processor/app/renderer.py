"""FFmpeg rendering: vertical composition, framing, burned subtitles and
loudness-normalised audio. Output is verified with ffprobe after encoding."""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path

from . import audio as audio_mod
from . import framing as framing_mod
from . import subtitles as subtitles_mod

logger = logging.getLogger("video-processor.renderer")


class RenderError(RuntimeError):
    def __init__(self, message: str, *, stage: str = "render", details: dict | None = None):
        super().__init__(message)
        self.stage = stage
        self.details = details or {}


def ffprobe_json(ffprobe_path: str, path: str) -> dict:
    proc = subprocess.run(
        [ffprobe_path, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RenderError(f"ffprobe failed on {path}: {proc.stderr[-400:]}", stage="probe")
    return json.loads(proc.stdout or "{}")


def probe_summary(ffprobe_path: str, path: str) -> dict:
    data = ffprobe_json(ffprobe_path, path)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format", {})
    num, den = (video.get("avg_frame_rate") or "0/1").split("/") if video and video.get("avg_frame_rate") else ("0", "1")
    fps = float(num) / float(den) if float(den) else 0.0
    rotation = 0
    if video:
        for side_data in video.get("side_data_list") or []:
            if "rotation" in side_data:
                try:
                    rotation = int(float(side_data["rotation"]))
                except (TypeError, ValueError):
                    rotation = 0
        if not rotation:
            try:
                rotation = int(float((video.get("tags") or {}).get("rotate", 0)))
            except (TypeError, ValueError):
                rotation = 0
    audio_duration = None
    if audio_stream:
        try:
            audio_duration = float(audio_stream.get("duration") or 0.0) or None
        except (TypeError, ValueError):
            audio_duration = None
    return {
        "duration_seconds": float(fmt.get("duration") or 0.0),
        "audio_duration_seconds": audio_duration,
        "width": int(video.get("width", 0)) if video else 0,
        "height": int(video.get("height", 0)) if video else 0,
        "frame_rate": round(fps, 3),
        "video_codec": video.get("codec_name") if video else None,
        "audio_codec": audio_stream.get("codec_name") if audio_stream else None,
        "audio_channels": int(audio_stream.get("channels", 0)) if audio_stream else None,
        "audio_sample_rate": int(audio_stream.get("sample_rate", 0)) if audio_stream else None,
        "container": fmt.get("format_name", ""),
        "bit_rate": int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        "rotation": rotation,
        "raw": data,
    }


def render_clip(
    *,
    ffmpeg_path: str,
    ffprobe_path: str,
    source_path: str,
    output_path: str,
    start: float,
    end: float,
    words: list[dict],
    subtitle_style: dict,
    output_width: int,
    output_height: int,
    fps: int,
    bitrate_kbps: int,
    video_codec: str = "h264",
    framing_mode: str = "face_track",
    framing_fallback: str = "fail",
    manual_offset_x: float | None = None,
    loudness_target_lufs: float = -14.0,
    watermark_path: str | None = None,
    watermark_position: str | None = None,
    intro_path: str | None = None,
    outro_path: str | None = None,
    background_music_path: str | None = None,
    background_music_gain_db: float | None = None,
    crf: int = 20,
    preset: str = "veryfast",
) -> dict:
    source_info = probe_summary(ffprobe_path, source_path)
    if not source_info.get("audio_codec"):
        # A clip with no audio cannot be published anywhere; fail here with a classified reason
        # instead of dying deep inside the filter graph with an opaque FFmpeg exit code.
        raise RenderError(
            "Source has no audio stream — a publishable clip requires speech",
            stage="validation",
            details={"sourceInfo": {k: v for k, v in source_info.items() if k != "raw"}},
        )
    if source_info["duration_seconds"] <= 0:
        raise RenderError("Source has no measurable duration", stage="probe")

    clip_start = max(0.0, float(start))
    clip_end = min(float(end), source_info["duration_seconds"])
    if clip_end - clip_start < 2:
        raise RenderError(f"Clip window {clip_start}-{clip_end} is too short to render", stage="validation")

    style = subtitles_mod.SubtitleStyleConfig.from_dict(subtitle_style)
    output_aspect = output_width / output_height

    framing = framing_mod.plan_framing(
        video_path=source_path,
        clip_start=clip_start,
        clip_end=clip_end,
        source_width=source_info["width"],
        source_height=source_info["height"],
        output_aspect=output_aspect,
        mode=framing_mode,
        fallback=framing_fallback,
        manual_offset_x=manual_offset_x,
    )

    # Never upscale beyond the source's own vertical resolution.
    effective_height = min(output_height, source_info["height"] if source_info["height"] else output_height)
    if effective_height < output_height:
        # Even dimensions required by yuv420p.
        effective_height = effective_height - (effective_height % 2)
        effective_width = int(round(effective_height * output_aspect / 2) * 2)
        logger.info("Source height %s < requested %s — rendering at %sx%s (no upscaling)", source_info["height"], output_height, effective_width, effective_height)
    else:
        effective_width, effective_height = output_width, output_height

    ass_document, subtitle_stats = subtitles_mod.build_ass(
        words=words,
        style=style,
        output_width=effective_width,
        output_height=effective_height,
        clip_start=clip_start,
        clip_end=clip_end,
    )
    ass_path = Path(output_path).with_suffix(".ass")
    ass_path.parent.mkdir(parents=True, exist_ok=True)
    ass_path.write_text(ass_document, encoding="utf-8")

    audio_analysis = audio_mod.analyse(ffmpeg_path, source_path, clip_start, clip_end - clip_start)

    source_crop_h = source_info["height"]
    source_crop_w = min(source_info["width"], int(round(source_crop_h * output_aspect)))
    x_expr = framing_mod.crop_x_expression(framing)
    if x_expr is None:
        x_expr = f"{(source_info['width'] - source_crop_w) / 2:.2f}"
    escaped_ass = str(ass_path).replace("\\", "/").replace(":", "\\:")
    watermark_overlay = {
        "top-left": "24:24",
        "top-right": "main_w-overlay_w-24:24",
        "bottom-left": "24:main_h-overlay_h-24",
        "bottom-right": "main_w-overlay_w-24:main_h-overlay_h-24",
    }
    position = watermark_position or "bottom-right"
    if watermark_path and not os.path.isfile(watermark_path):
        raise RenderError(f"Configured watermark file is missing: {watermark_path}", stage="validation")
    if watermark_path and position not in watermark_overlay:
        raise RenderError(f"Unsupported watermark position '{position}'", stage="validation")

    # Rebuild the graph correctly for the blur case (needs full graph syntax).
    if framing.mode == "background_blur":
        graph_parts = [
            "[0:v]split=2[bg][fg]",
            f"[bg]scale={effective_width}:{effective_height}:force_original_aspect_ratio=increase,crop={effective_width}:{effective_height},boxblur=20:2[bgb]",
            f"[fg]scale={effective_width}:{effective_height}:force_original_aspect_ratio=decrease[fgs]",
            "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,format=yuv420p[base]",
        ]
        if watermark_path:
            graph_parts.append("[1:v]scale=180:-1[wm2]")
            graph_parts.append(f"[base][wm2]overlay={watermark_overlay[position]}[wmbase]")
            graph_parts.append(f"[wmbase]ass=filename='{escaped_ass}',format=yuv420p[vout]")
        else:
            graph_parts.append(f"[base]ass=filename='{escaped_ass}',format=yuv420p[vout]")
        filter_complex = ";".join(graph_parts)
    else:
        chain = "crop=" + f"{source_crop_w}:{source_crop_h}:{x_expr}:0" + f",scale={effective_width}:{effective_height}:flags=lanczos,setsar=1"
        if watermark_path:
            filter_complex = (
                f"[0:v]{chain}[base];[1:v]scale=180:-1[wm2];"
                f"[base][wm2]overlay={watermark_overlay[position]},ass=filename='{escaped_ass}',format=yuv420p[vout]"
            )
        else:
            filter_complex = f"[0:v]{chain},ass=filename='{escaped_ass}',format=yuv420p[vout]"

    # Audio: loudness normalisation using the measured values (two-pass style).
    audio_filters = []
    if audio_analysis.get("integrated_loudness_lufs") is not None:
        audio_filters.append(
            "loudnorm=I={I}:TP=-1.5:LRA=11:measured_I={mi}:measured_TP={mtp}:measured_LRA={mlra}:measured_thresh=-70:linear=true".format(
                I=loudness_target_lufs,
                mi=audio_analysis["integrated_loudness_lufs"],
                mtp=audio_analysis.get("true_peak_dbtp") or -1.5,
                mlra=audio_analysis.get("loudness_range") or 11,
            )
        )
    else:
        audio_filters.append(f"loudnorm=I={loudness_target_lufs}:TP=-1.5:LRA=11")
    audio_filters.append("aresample=async=1:first_pts=0")

    inputs = ["-ss", f"{clip_start:.3f}", "-t", f"{clip_end - clip_start:.3f}", "-i", source_path]
    input_index = 1
    wm_index = None
    if watermark_path:
        wm_index = input_index
        inputs += ["-i", watermark_path]
        input_index += 1

    music_index = None
    if background_music_path:
        if not os.path.isfile(background_music_path):
            raise RenderError(f"Configured background music file is missing: {background_music_path}", stage="validation")
        music_index = input_index
        inputs += ["-stream_loop", "-1", "-i", background_music_path]
        input_index += 1

    if music_index is not None:
        gain = background_music_gain_db if background_music_gain_db is not None else -22.0
        filter_complex += (
            f";[0:a]{','.join(audio_filters)}[voice];"
            f"[{music_index}:a]volume={gain}dB,atrim=0:{clip_end - clip_start:.3f},afade=t=out:st={max(0.0, clip_end - clip_start - 1.5):.3f}:d=1.5[music];"
            "[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
    else:
        filter_complex += f";[0:a]{','.join(audio_filters)}[aout]"

    # Branding intro/outro are concatenated onto the rendered clip. They are re-encoded to the
    # exact same specification first, because the concat demuxer requires identical streams.
    render_target = output_path
    branding_segments: list[str] = []
    if intro_path or outro_path:
        render_target = f"{output_path}.main.mp4"

    codec_args = ["-c:v", "libx264", "-preset", preset, "-profile:v", "high", "-level", "4.1"]
    if bitrate_kbps:
        codec_args += ["-b:v", f"{bitrate_kbps}k", "-maxrate", f"{int(bitrate_kbps * 1.2)}k", "-bufsize", f"{bitrate_kbps * 2}k"]
    else:
        codec_args += ["-crf", str(crf)]

    cmd = [
        ffmpeg_path,
        "-hide_banner",
        "-y",
        *inputs,
        "-filter_complex",
        filter_complex,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        *codec_args,
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(fps),
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        "-metadata",
        "title=ClipForge AI clip",
        "-shortest",
        render_target,
    ]

    logger.info("Rendering %s -> %s (%.2fs window)", source_path, render_target, clip_end - clip_start)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    if proc.returncode != 0:
        raise RenderError(
            f"FFmpeg exited with {proc.returncode}: {proc.stderr[-1500:]}",
            stage="encode",
            details={"command": " ".join(cmd[:24]), "stderrTail": proc.stderr[-3000:]},
        )

    expected_duration = clip_end - clip_start
    if intro_path or outro_path:
        for label, segment in (("intro", intro_path), ("outro", outro_path)):
            if segment is None:
                continue
            if not os.path.isfile(segment):
                raise RenderError(f"Configured {label} asset is missing: {segment}", stage="validation")
            normalised = f"{output_path}.{label}.mp4"
            _normalise_brand_segment(
                ffmpeg_path=ffmpeg_path,
                ffprobe_path=ffprobe_path,
                input_path=segment,
                output_path=normalised,
                width=effective_width,
                height=effective_height,
                fps=fps,
                bitrate_kbps=bitrate_kbps,
                preset=preset,
            )
            segment_duration = probe_summary(ffprobe_path, normalised)["duration_seconds"]
            expected_duration += segment_duration
            branding_segments.append(normalised)

        ordered = ([branding_segments[0]] if intro_path else []) + [render_target] + (
            [branding_segments[-1]] if outro_path else []
        )
        _concat_segments(ffmpeg_path=ffmpeg_path, segments=ordered, output_path=output_path)
        for leftover in [*branding_segments, render_target]:
            if leftover != output_path and os.path.isfile(leftover):
                os.remove(leftover)

    validation = validate_output(
        ffmpeg_path=ffmpeg_path,
        ffprobe_path=ffprobe_path,
        output_path=output_path,
        expected_width=effective_width,
        expected_height=effective_height,
        expected_duration=expected_duration,
        expected_fps=fps,
        duration_tolerance=1.5 if branding_segments else 1.0,
    )
    if validation["errors"]:
        raise RenderError(
            "Rendered file failed validation: " + "; ".join(validation["errors"]),
            stage="validate",
            details=validation,
        )

    report = {
        "outputPath": output_path,
        "durationSeconds": validation["probe"]["duration_seconds"],
        "width": validation["probe"]["width"],
        "height": validation["probe"]["height"],
        "fps": validation["probe"]["frame_rate"],
        "sizeBytes": os.path.getsize(output_path),
        "videoCodec": validation["probe"]["video_codec"],
        "audioCodec": validation["probe"]["audio_codec"],
        "bitrateKbps": round((validation["probe"]["bit_rate"] or 0) / 1000, 1),
        "framing": framing.as_report(),
        "subtitleWordCount": len(words),
        "subtitleStats": subtitle_stats,
        "audio": audio_analysis,
        "audioNormalisationTargetLufs": loudness_target_lufs,
        "backgroundMusic": background_music_path,
        "watermark": watermark_path,
        "branding": {
            "introApplied": bool(intro_path),
            "outroApplied": bool(outro_path),
            "totalDurationSeconds": round(validation["probe"].get("duration_seconds") or 0, 3),
        },
        "sourceInfo": {k: v for k, v in source_info.items() if k != "raw"},
        "validationErrors": validation["errors"],
        "validationWarnings": validation["warnings"],
        "quality": {
            "blackSeconds": validation["content"]["blackSeconds"],
            "frozenSeconds": validation["content"]["frozenSeconds"],
            "blackSegments": validation["content"]["blackSegments"],
            "frozenSegments": validation["content"]["frozenSegments"],
            "meanVolumeDb": validation["meanVolumeDb"],
            "maxVolumeDb": validation["maxVolumeDb"],
            "audioVideoDriftSeconds": round(
                abs((validation["probe"].get("audio_duration_seconds") or 0) - (validation["probe"].get("duration_seconds") or 0)),
                3,
            ),
            "passed": not validation["errors"],
        },
    }
    return report


BLACK_START_RE = re.compile(r"black_start:(?P<start>[\d.]+)\s+black_end:(?P<end>[\d.]+)")
FREEZE_START_RE = re.compile(r"freeze_start:\s*(?P<start>[\d.]+)")
FREEZE_END_RE = re.compile(r"freeze_end:\s*(?P<end>[\d.]+)")


def _scan_content(ffmpeg_path: str, output_path: str, duration_seconds: float | None = None) -> dict:
    """Detects black stretches and frozen frames in the rendered file.

    A file that satisfies ffprobe but is black or frozen for seconds is a failed render: the
    container is valid, the content is not. Both are measured, not assumed.
    """
    cmd = [
        ffmpeg_path,
        "-hide_banner",
        "-nostats",
        "-i",
        output_path,
        "-vf",
        "blackdetect=d=0.3:pix_th=0.10,freezedetect=n=-60dB:d=1.5",
        "-an",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    stderr = proc.stderr or ""
    black: list[dict] = []
    for match in BLACK_START_RE.finditer(stderr):
        start, end = float(match.group("start")), float(match.group("end"))
        black.append({"start": round(start, 3), "end": round(end, 3), "seconds": round(end - start, 3)})
    frozen: list[dict] = []
    pending: float | None = None
    for line in stderr.splitlines():
        start_match = FREEZE_START_RE.search(line)
        if start_match:
            pending = float(start_match.group("start"))
            continue
        end_match = FREEZE_END_RE.search(line)
        if end_match and pending is not None:
            end = float(end_match.group("end"))
            frozen.append({"start": round(pending, 3), "end": round(end, 3), "seconds": round(end - pending, 3)})
            pending = None
    if pending is not None:
        # FFmpeg only emits freeze_end when motion resumes; a clip that is frozen through EOF would
        # otherwise be reported as clean.
        end = duration_seconds if duration_seconds and duration_seconds > pending else pending
        if end > pending:
            frozen.append({"start": round(pending, 3), "end": round(end, 3), "seconds": round(end - pending, 3)})
    return {
        "blackSegments": black,
        "blackSeconds": round(sum(segment["seconds"] for segment in black), 3),
        "frozenSegments": frozen,
        "frozenSeconds": round(sum(segment["seconds"] for segment in frozen), 3),
    }


def validate_output(
    *,
    ffmpeg_path: str,
    ffprobe_path: str,
    output_path: str,
    expected_width: int,
    expected_height: int,
    expected_duration: float,
    expected_fps: int,
    duration_tolerance: float = 1.0,
) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    if not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
        return {"errors": ["Output file is missing or empty"], "warnings": [], "probe": {}, "content": {}}
    probe = probe_summary(ffprobe_path, output_path)
    if probe["width"] != expected_width or probe["height"] != expected_height:
        errors.append(f"Resolution {probe['width']}x{probe['height']} != expected {expected_width}x{expected_height}")
    if abs(probe["duration_seconds"] - expected_duration) > duration_tolerance:
        errors.append(
            f"Duration {probe['duration_seconds']:.2f}s deviates more than {duration_tolerance:.1f}s from {expected_duration:.2f}s"
        )
    if probe["video_codec"] != "h264":
        errors.append(f"Unexpected video codec {probe['video_codec']}")
    if probe["audio_codec"] != "aac":
        errors.append(f"Unexpected audio codec {probe['audio_codec']}")
    if probe["audio_channels"] not in (1, 2):
        errors.append(f"Unexpected audio channel count {probe['audio_channels']}")
    if abs(probe["frame_rate"] - expected_fps) > 0.5:
        errors.append(f"Frame rate {probe['frame_rate']} != expected {expected_fps}")
    if probe["width"] % 2 or probe["height"] % 2:
        errors.append("Odd dimensions are not compatible with yuv420p")
    # Vertical platforms require 9:16 within a small tolerance.
    ratio = probe["width"] / probe["height"] if probe["height"] else 0
    if abs(ratio - 9 / 16) > 0.01:
        errors.append(f"Aspect ratio {ratio:.4f} is not 9:16")

    # Audio must be present and healthy, not merely declared in the container.
    if not probe.get("audio_codec"):
        errors.append("No audio stream in the rendered file")
    mean_volume, max_volume = audio_mod._measure_volume(ffmpeg_path, output_path, None, None)
    if mean_volume is None:
        warnings.append("Could not measure output volume")
    elif mean_volume < -55:
        errors.append(f"Audio track is effectively silent (mean volume {mean_volume} dB)")
    elif mean_volume < -40:
        warnings.append(f"Audio track is very quiet (mean volume {mean_volume} dB)")

    # A/V drift: every player drifts visibly once the streams disagree by more than ~0.5 s.
    if probe.get("audio_duration_seconds") and probe.get("duration_seconds"):
        drift = abs(probe["audio_duration_seconds"] - probe["duration_seconds"])
        if drift > 0.5:
            errors.append(f"Audio/video duration drift {drift:.2f}s exceeds 0.5s")
        elif drift > 0.25:
            warnings.append(f"Audio/video duration drift {drift:.2f}s")

    content = _scan_content(ffmpeg_path, output_path, probe.get("duration_seconds"))
    if probe.get("duration_seconds"):
        share = content["blackSeconds"] / probe["duration_seconds"]
        if share > 0.6:
            errors.append(f"{share * 100:.0f}% of the clip is black frames")
        elif content["blackSegments"]:
            warnings.append(f"{len(content['blackSegments'])} black segment(s) totalling {content['blackSeconds']}s")
        frozen_share = content["frozenSeconds"] / probe["duration_seconds"]
        if frozen_share > 0.5:
            errors.append(f"{frozen_share * 100:.0f}% of the clip is frozen frames")
        elif content["frozenSegments"]:
            warnings.append(f"{len(content['frozenSegments'])} frozen segment(s) totalling {content['frozenSeconds']}s")

    return {
        "errors": errors,
        "warnings": warnings,
        "probe": {k: v for k, v in probe.items() if k != "raw"},
        "content": content,
        "meanVolumeDb": mean_volume,
        "maxVolumeDb": max_volume,
    }


def _normalise_brand_segment(
    *,
    ffmpeg_path: str,
    ffprobe_path: str,
    input_path: str,
    output_path: str,
    width: int,
    height: int,
    fps: int,
    bitrate_kbps: int,
    preset: str = "veryfast",
) -> None:
    """Re-encode an intro/outro to the exact spec of the rendered clip.

    Branding footage is supplied by the operator and can be any size or frame rate; the concat
    demuxer refuses mismatched streams, so every segment is normalised first. A silent stereo
    track is added when the segment has no audio, so the audio stream layout always matches.
    """
    info = probe_summary(ffprobe_path, input_path)
    has_audio = bool(info.get("audio_codec"))
    filters = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps}"
    )
    cmd = [ffmpeg_path, "-hide_banner", "-y", "-i", input_path]
    if not has_audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    cmd += ["-filter_complex", f"[0:v]{filters}[v]"]
    cmd += ["-map", "[v]"]
    cmd += ["-map", "1:a" if not has_audio else "0:a"]
    cmd += ["-c:v", "libx264", "-preset", preset, "-profile:v", "high", "-pix_fmt", "yuv420p"]
    if bitrate_kbps:
        cmd += ["-b:v", f"{bitrate_kbps}k", "-maxrate", f"{int(bitrate_kbps * 1.2)}k", "-bufsize", f"{bitrate_kbps * 2}k"]
    cmd += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", output_path]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if proc.returncode != 0:
        raise RenderError(
            f"Could not normalise branding segment {input_path}: FFmpeg exited {proc.returncode}",
            stage="branding",
            details={"stderrTail": proc.stderr[-2000:]},
        )


def _concat_segments(*, ffmpeg_path: str, segments: list[str], output_path: str) -> None:
    """Concatenate segments that already share codec, resolution, fps and audio layout."""
    if not segments:
        raise RenderError("No segments to concatenate", stage="branding")
    with tempfile.TemporaryDirectory() as tmpdir:
        listfile = os.path.join(tmpdir, "concat.txt")
        with open(listfile, "w", encoding="utf-8") as handle:
            for segment in segments:
                handle.write(f"file '{os.path.abspath(segment)}'\n")
        cmd = [
            ffmpeg_path,
            "-hide_banner",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            listfile,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            output_path,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if proc.returncode != 0:
            raise RenderError(
                f"Branding concatenation failed: FFmpeg exited {proc.returncode}",
                stage="branding",
                details={"stderrTail": proc.stderr[-2000:]},
            )
