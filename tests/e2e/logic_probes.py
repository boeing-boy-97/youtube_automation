#!/usr/bin/env python3
"""Adversarial probes of the core algorithms — does the logic hold, not just the happy path?

The unit tests check the happy paths the product needs. These probes try to break it: inverted
ranges, garbage timestamps, a model that inflates its own score, duplicate windows, unknown framing
modes, a missing video, an empty word list. Every probe asserts the *reason* as well as the outcome,
so a silent regression to "returns nothing" fails instead of passing quietly.

Run:  .venv/bin/python tests/e2e/logic_probes.py
Exit: 0 when every probe holds, 1 otherwise.
"""
from __future__ import annotations

import importlib
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

sel = importlib.import_module("services.ai-engine.app.selection")
sub = importlib.import_module("services.video-processor.app.subtitles")
fram = importlib.import_module("services.video-processor.app.framing")

ok = fail = 0
def check(name, cond, detail=""):
    global ok, fail
    if cond: ok += 1; print(f"  PASS  {name} — {detail}")
    else: fail += 1; print(f"  FAIL  {name} — {detail}")

def _words(start: float, end: float, n: int = 8, tag: str = "s0"):
    """Word timings inside a segment, 0.1 s gaps (Whisper emits a leading space on each word).
    Each segment gets its own vocabulary so different windows are genuinely different speech."""
    span = (end - start) / n
    return [{"word": f" {tag}word{i}", "start": round(start + i * span, 2),
             "end": round(start + i * span + span - 0.1, 2)} for i in range(n)]

segs = [
    {"start": s0, "end": s0 + 12.0, "text": f"segment {i} text", "words": _words(s0, s0 + 12.0, tag=f"s{i}")}
    for i, s0 in enumerate([0.0, 12.0, 24.0, 36.0, 48.0])
]
DUR = 60.0
FULL = {k: 9.0 for k in sel.RUBRIC}

def cand(**over):
    base = {"start_time": 13.7, "end_time": 46.2, "target_duration": 30, "quality_score": 100,
            "confidence": 0.8, "scores": dict(FULL), "hook": "hook", "reason": "r",
            "transcript": "t", "content_category": "educational", "visual_context": ""}
    base.update(over)
    return base

def validate(cands, min_score=70, targets=(15, 30)):
    raw = {"candidates": cands, "video_summary": "s", "content_themes": ["x"], "no_candidate_reason": ""}
    return sel.validate_and_normalise(raw, segments=segs, duration_seconds=DUR,
                                     target_durations=list(targets), min_quality_score=min_score)

print("\n[selection] the model proposes, this module validates")
accepted, rejected, summary = validate([cand()])
check("a valid 30 s candidate is accepted", len(accepted) == 1, f"accepted={len(accepted)} rejected={[r.get('reason') for r in rejected]}")
a = accepted[0] if accepted else None
if a:
    word_starts = {w["start"] for s in segs for w in s["words"]}
    word_ends = {w["end"] for s in segs for w in s["words"]}
    check("start snapped to a real word start", a.start_time in word_starts and a.start_time != 13.7, f"model said 13.70 → {a.start_time}")
    check("end snapped to a real word end", a.end_time in word_ends and a.end_time != 46.2, f"model said 46.20 → {a.end_time}")
    check("clip stays inside the source", 0 <= a.start_time < a.end_time <= DUR, f"{a.start_time}→{a.end_time}")
    check("quality score recomputed from the rubric, never trusted",
          a.quality_score == 90 and any("recomputed" in n for n in a.validation_notes),
          f"model claimed 100, rubric scored {a.quality_score}: {[n for n in a.validation_notes if 'recomputed' in n]}")
    check("model cannot inflate its own score (min of rubric and claim)",
          validate([cand(quality_score=100)])[0][0].quality_score == 90, "100 claimed → 90 kept")
    check("snapping is recorded as a validation note", any("snapped" in n for n in a.validation_notes), f"notes={a.validation_notes}")

accepted, rejected, _ = validate([cand(start_time=10, end_time=14)])
check("a 4 s candidate is rejected as TOO_SHORT", len(accepted) == 0 and rejected[0]["reason"] == "TOO_SHORT", f"{[r.get('reason') for r in rejected]}")
accepted, rejected, _ = validate([cand(start_time=40, end_time=20)])
check("an inverted range is rejected", len(accepted) == 0 and rejected[0]["reason"] == "INVERTED_RANGE", f"{[r.get('reason') for r in rejected]}")
accepted, rejected, _ = validate([cand(target_duration=45)])
check("an unrequested duration is rejected", len(accepted) == 0 and "TARGET_DURATION_NOT_REQUESTED" in rejected[0]["reason"], f"{[r.get('reason') for r in rejected]}")
accepted, rejected, _ = validate([cand(start_time=-30, end_time=400)])
check("out-of-source timestamps are clamped, not accepted blindly", all(0 <= c.start_time and c.end_time <= DUR for c in accepted) and (not accepted or accepted[0].validation_notes), f"accepted={[(c.start_time, c.end_time) for c in accepted]}")
accepted, rejected, _ = validate([cand(scores={k: 1.0 for k in sel.RUBRIC})])
check("a low-scoring candidate fails the quality gate",
      len(accepted) == 0 and rejected[0]["reason"].startswith("BELOW_MIN_QUALITY"), f"{[r.get('reason') for r in rejected]}")
accepted, rejected, _ = validate([{"start_time": "abc", "end_time": None, "target_duration": 30, "scores": {}}])
check("garbage input is rejected with a reason, never crashes", len(accepted) == 0 and rejected[0]["reason"] == "MALFORMED_TIMESTAMPS", f"{[r.get('reason') for r in rejected]}")

accepted, _, _ = validate([cand(start_time=13.5, end_time=45.0, quality_score=100),
                           cand(start_time=14.0, end_time=45.5, quality_score=70)])
check("two overlapping submissions both pass validation", len(accepted) == 2, f"accepted={len(accepted)}")
kept, dropped = sel.deduplicate(accepted, max_clips=5, duplicate_threshold=0.35)
check("de-duplication keeps only the better overlapping clip", len(kept) == 1, f"kept={len(kept)} dropped={len(dropped)}: {[d.get('reason') for d in dropped][:2]}")
check("de-duplication respects max_clips", len(sel.deduplicate(accepted * 4, max_clips=1, duplicate_threshold=0.35)[0]) <= 1, "max_clips=1 honoured")
accepted_sep, rejected_sep, _ = validate([cand(start_time=0, end_time=28), cand(start_time=30, end_time=58)])
kept_sep = sel.deduplicate(accepted_sep, max_clips=5, duplicate_threshold=0.35)[0]
check("non-overlapping clips are both kept", len(accepted_sep) == 2 and len(kept_sep) == 2,
      f"accepted={len(accepted_sep)} {[r.get('reason') for r in rejected_sep]} kept={len(kept_sep)}")

check("rubric weights sum to 1.0", abs(sum(sel.RUBRIC.values()) - 1.0) < 1e-9, f"{sum(sel.RUBRIC.values()):.6f} over {len(sel.RUBRIC)} factors")
check("quality score maps 10s → 100 and 0s → 0", sel.compute_quality_score({k: 10 for k in sel.RUBRIC}) == 100 and sel.compute_quality_score({k: 0 for k in sel.RUBRIC}) == 0, "bounds correct")
check("non-numeric scores do not raise", isinstance(sel.compute_quality_score({"hookQuality": "x", "unknown": 5}), int), "degrades to a number")
check("a missing factor counts as zero, not as full marks", sel.compute_quality_score({"hookQuality": 10}) < 100, f"partial={sel.compute_quality_score({'hookQuality': 10})}")

kept2, _ = sel.deduplicate(accepted, max_clips=5, duplicate_threshold=0.35)
plan, decisions = sel.plan_variants(kept2, segments=segs, target_durations=[15, 30], min_quality_score=70)
check("plan_variants returns variants inside their candidate", all(p["start_time"] >= kept2[0].start_time - 0.01 and p["end_time"] <= kept2[0].end_time + 0.01 for p in plan), f"plan={[(p['start_time'], p['end_time']) for p in plan]}")
check("every variant carries a decision record", len(decisions) >= len(plan), f"decisions={len(decisions)} plan={len(plan)}")

print("\n[subtitles] ASS generation from real word timings")
words = [{"word": "hello", "start": 0.0, "end": 0.4, "probability": 0.9},
         {"word": "world", "start": 0.4, "end": 0.9, "probability": 0.9},
         {"word": "again", "start": 1.0, "end": 1.4, "probability": 0.9},
         {"word": "and", "start": 1.4, "end": 1.6, "probability": 0.9},
         {"word": "again", "start": 1.6, "end": 1.9, "probability": 0.9}]
style = sub.SubtitleStyleConfig.from_dict({
    "fontFamily": "Inter", "fontSizePx": 56, "fontWeight": 800, "primaryColor": "#FFFFFF",
    "highlightColor": "#FFE066", "outlineColor": "#000000", "outlineWidth": 4, "shadow": 2,
    "position": "lower-third", "safeMarginXPx": 60, "safeMarginBottomPx": 300,
    "backgroundOpacity": 0, "uppercase": True, "maxCharsPerLine": 20, "maxLines": 2})
ass, stats = sub.build_ass(words=words, style=style, output_width=1080, output_height=1920, clip_start=0.0, clip_end=2.0)
check("ASS has a valid script header", ass.startswith("[Script Info]"), ass.splitlines()[0])
check("all spoken words appear", all(w["word"].upper() in ass.upper() for w in words), "5/5 words present")
dialogue = [l for l in ass.splitlines() if l.startswith("Dialogue:")]
check("dialogue events emitted with real timings", len(dialogue) >= 1 and any("0:00:0" in d for d in dialogue), f"{len(dialogue)} event(s), stats={stats.get('lines')} line(s)")
check("uppercase style is applied", "hello" not in ass and "HELLO" in ass, "text upper-cased")
check("highlight colour is used for the active word", "FFE066" in ass.upper() or "&H0066E0FF" in ass.upper(), "highlight tag present")
try:
    sub.build_ass(words=[], style=style, output_width=1080, output_height=1920, clip_start=0.0, clip_end=2.0)
    check("empty word list is refused, not silently rendered blank", False, "no error raised")
except ValueError:
    check("empty word list is refused, not silently rendered blank", True, "ValueError")
ass_short, _ = sub.build_ass(words=words, style=style, output_width=1080, output_height=1920, clip_start=0.0, clip_end=5.0)
check("clip longer than the speech still produces valid subtitles", ass_short.startswith("[Script Info]"), "header ok")

print("\n[framing] framing decisions (real ffprobe on a real file)")
def first_existing(*candidates: pathlib.Path) -> pathlib.Path:
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    return candidates[-1]


# A source video is not committed (a 26 MB fixture would blow the repository budget); the suite
# looks wherever the rest of the harness looks, then skips the framing probes that need pixels.
SOURCE = first_existing(
    pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None,
    pathlib.Path("/home/user/testdata/light-source.mp4"),
    REPO / "testdata" / "light-source.mp4",
)
PORTRAIT = first_existing(pathlib.Path("/tmp/fixtures/hd-source.mp4"), SOURCE)
CASES = [
    ("16:9 source → 9:16 face_track", SOURCE, 1920, 1080, 9 / 16, "face_track", None),
    ("16:9 source → 1:1 center_crop", SOURCE, 1920, 1080, 1.0, "center_crop", None),
    ("9:16 source → 9:16 (no crop needed)", PORTRAIT, 1080, 1920, 9 / 16, "face_track", None),
    ("manual offset inside range", SOURCE, 1920, 1080, 9 / 16, "manual", 0.25),
    ("manual offset out of range is clamped", SOURCE, 1920, 1080, 9 / 16, "manual", 5.0),
    ("background_blur needs no crop window", SOURCE, 1920, 1080, 9 / 16, "background_blur", None),
]
for label, path, w, h, aspect, mode, offset in CASES:
    if not pathlib.Path(path).exists():
        print(f"  SKIP  {label} — fixture {path} is not present")
        continue
    try:
        res = fram.plan_framing(video_path=str(path), clip_start=0.0, clip_end=2.0, source_width=w, source_height=h,
                                output_aspect=aspect, mode=mode, fallback="center_crop",
                                manual_offset_x=offset)
        max_x = max(0, w - min(w, int(round(h * aspect))))
        inside = res.crop_x_constant is None or -0.01 <= res.crop_x_constant <= max_x + 0.01
        check(f"{label} produces a usable crop plan", inside,
              f"mode={res.mode} crop_x={res.crop_x_constant} max_x={max_x} keyframes={len(res.keyframes)} "
              f"coverage={res.coverage:.2f} fallback={res.fallback_used}")
    except Exception as exc:
        check(f"{label} produces a usable crop plan", False, f"{type(exc).__name__}: {str(exc)[:120]}")

try:
    res = fram.plan_framing(video_path="/tmp/does-not-exist.mp4", clip_start=0.0, clip_end=2.0,
                            source_width=1920, source_height=1080, output_aspect=9 / 16,
                            mode="face_track", fallback="center_crop")
    check("a missing/broken video degrades to the fallback instead of crashing",
          res.fallback_used is True, f"mode={res.mode} fallback_used={res.fallback_used} note={res.note!r}")
except Exception as exc:
    check("a missing/broken video degrades to the fallback instead of crashing", False, f"{type(exc).__name__}: {str(exc)[:120]}")

try:
    fram.plan_framing(video_path=str(SOURCE), clip_start=0.0, clip_end=2.0,
                      source_width=1920, source_height=1080, output_aspect=9 / 16,
                      mode="vertically_squish", fallback="center_crop")
    check("an unknown framing mode is refused loudly", False, "no error raised")
except fram.FramingError as exc:
    check("an unknown framing mode is refused loudly", True, f"FramingError: {exc}")

print(f"\nlogic probes: {ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
