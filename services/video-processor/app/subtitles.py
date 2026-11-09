"""Word-timed subtitle generation (ASS) with karaoke-style highlighting.

The style is always an explicit user/administrator choice; nothing is hardcoded as
a default. Line breaking is sentence-aware and respects the configured maximum
characters per line so text never runs off a 1080-wide frame.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger("video-processor.subtitles")


@dataclass
class SubtitleStyleConfig:
    font_family: str
    font_size_px: int
    font_weight: int
    primary_color: str
    highlight_color: str
    outline_color: str
    outline_width: float
    shadow: float
    position: str
    safe_margin_x_px: int
    safe_margin_bottom_px: int
    background_opacity: float
    uppercase: bool
    max_chars_per_line: int
    max_lines: int

    @classmethod
    def from_dict(cls, payload: dict) -> "SubtitleStyleConfig":
        required = [
            "fontFamily",
            "fontSizePx",
            "fontWeight",
            "primaryColor",
            "highlightColor",
            "outlineColor",
            "outlineWidth",
            "shadow",
            "position",
            "safeMarginXPx",
            "safeMarginBottomPx",
            "backgroundOpacity",
            "uppercase",
            "maxCharsPerLine",
            "maxLines",
        ]
        missing = [key for key in required if key not in payload]
        if missing:
            raise ValueError(f"Subtitle style is missing required fields: {', '.join(missing)}")
        return cls(
            font_family=str(payload["fontFamily"]),
            font_size_px=int(payload["fontSizePx"]),
            font_weight=int(payload["fontWeight"]),
            primary_color=str(payload["primaryColor"]),
            highlight_color=str(payload["highlightColor"]),
            outline_color=str(payload["outlineColor"]),
            outline_width=float(payload["outlineWidth"]),
            shadow=float(payload["shadow"]),
            position=str(payload["position"]),
            safe_margin_x_px=int(payload["safeMarginXPx"]),
            safe_margin_bottom_px=int(payload["safeMarginBottomPx"]),
            background_opacity=float(payload["backgroundOpacity"]),
            uppercase=bool(payload["uppercase"]),
            max_chars_per_line=int(payload["maxCharsPerLine"]),
            max_lines=int(payload["maxLines"]),
        )


@dataclass
class SubtitleLine:
    start: float
    end: float
    words: list[dict]


def ass_color(hex_colour: str) -> str:
    """#RRGGBB -> &HAABBGGRR (ASS uses BGR order, AA=00 for opaque)."""
    value = hex_colour.lstrip("#")
    if len(value) != 6:
        raise ValueError(f"Invalid colour {hex_colour}")
    red, green, blue = value[0:2], value[2:4], value[4:6]
    return f"&H00{blue}{green}{red}".upper()


def join_words(tokens: list[str]) -> str:
    """Concatenate ASR tokens, tolerating providers that do not prefix each word with a space.

    Whisper emits " the", " quick", so a bare join restores the sentence. A provider that emits
    "the", "quick" would otherwise render "thequickbrownfox" and mis-count line length.
    """
    joined = "".join(tokens)
    if len(tokens) > 1 and " " not in joined:
        joined = " ".join(tokens)
    return joined


def group_lines(words: list[dict], style: SubtitleStyleConfig) -> list[SubtitleLine]:
    """Groups words into caption lines that respect the style constraints."""
    lines: list[SubtitleLine] = []
    current: list[dict] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        lines.append(SubtitleLine(start=current[0]["start"], end=current[-1]["end"], words=list(current)))
        current = []

    for word in words:
        text = word["word"]
        candidate = join_words([w["word"] for w in current] + [text])
        visible = candidate.strip()
        over_length = len(visible) > style.max_chars_per_line * style.max_lines
        if over_length and current:
            flush()
        current.append(word)
        # Break after sentence-ending punctuation, or when the line is long enough.
        if re.search(r"[.!?…]$", text.strip()):
            flush()
        elif len(join_words([w["word"] for w in current]).strip()) >= style.max_chars_per_line and len(current) >= 3:
            flush()
    flush()

    # Drop empty/whitespace-only lines and clamp timings.
    cleaned = []
    for line in lines:
        if not "".join(w["word"] for w in line.words).strip():
            continue
        line.end = max(line.end, line.start + 0.35)
        cleaned.append(line)
    return cleaned


def split_into_visual_rows(text: str, style: SubtitleStyleConfig) -> list[str]:
    words = text.split()
    rows: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) > style.max_chars_per_line and current:
            rows.append(current)
            current = word
        else:
            current = candidate
    if current:
        rows.append(current)
    if len(rows) > style.max_lines:
        rows = rows[: style.max_lines]
    return rows


def alignment(style: SubtitleStyleConfig) -> int:
    # 2 = bottom-centre, 5 = top-centre; both keep the text inside safe margins.
    return 5 if style.position == "upper-third" else 2


def margin_v(style: SubtitleStyleConfig, output_height: int) -> int:
    if style.position == "middle":
        return int(output_height * 0.42)
    if style.position == "upper-third":
        return int(output_height * 0.16)
    return max(style.safe_margin_bottom_px, int(output_height * 0.08))


def build_ass(
    *,
    words: list[dict],
    style: SubtitleStyleConfig,
    output_width: int,
    output_height: int,
    clip_start: float,
    clip_end: float,
    title: str | None = None,
) -> tuple[str, dict]:
    """Returns (ass_document, stats). Timestamps are relative to the clip."""
    if not words:
        raise ValueError("Cannot build subtitles without word timings")

    def rel(value: float) -> float:
        return max(0.0, min(clip_end - clip_start, value - clip_start))

    lines = group_lines(words, style)
    if not lines:
        raise ValueError("No subtitle lines could be produced from the word timings")

    font_size = style.font_size_px
    header = [
        "[Script Info]",
        "; Generated by ClipForge AI video-processor",
        f"Title: {title or 'ClipForge clip'}",
        "ScriptType: v4.00+",
        f"PlayResX: {output_width}",
        f"PlayResY: {output_height}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
    ]
    primary = ass_color(style.primary_color)
    highlight = ass_color(style.highlight_color)
    outline = ass_color(style.outline_color)
    back_alpha = int(round((1 - max(0.0, min(1.0, style.background_opacity))) * 255))
    back = f"&H{back_alpha:02X}000000"
    bold = -1 if style.font_weight >= 600 else 0
    border_style = 3 if style.background_opacity > 0 else 1
    header.append(
        "Style: ClipForge,"
        f"{style.font_family},{font_size},{primary},{highlight},{outline},{back},"
        f"{bold},0,0,0,100,100,0,0,{border_style},{style.outline_width},{style.shadow},"
        f"{alignment(style)},{style.safe_margin_x_px},{style.safe_margin_x_px},"
        f"{margin_v(style, output_height)},1"
    )
    header += ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]

    def ts(seconds: float) -> str:
        seconds = max(0.0, seconds)
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = seconds % 60
        return f"{hours}:{minutes:02d}:{secs:05.2f}"

    events: list[str] = []
    highlight_events = 0
    for line in lines:
        visible_words = [w for w in line.words if w["word"].strip()]
        if not visible_words:
            continue
        full_text = join_words([w["word"] for w in visible_words]).strip()
        if style.uppercase:
            full_text = full_text.upper()
        rows = split_into_visual_rows(full_text, style)
        # Static event so the line is never blank between word timings.
        events.append(
            f"Dialogue: 0,{ts(rel(line.start))},{ts(rel(line.end))},ClipForge,,0,0,0,,"
            f"{{\\an{alignment(style)}}}" + "\\N".join(rows)
        )
        # Karaoke highlight: one event per word with that word recoloured.
        for index, word in enumerate(visible_words):
            start = rel(word["start"])
            end = rel(visible_words[index + 1]["start"]) if index + 1 < len(visible_words) else rel(line.end)
            if end - start <= 0:
                continue
            highlighted_rows = _render_with_highlight(visible_words, index, rows, style, highlight, primary)
            events.append(
                f"Dialogue: 1,{ts(start)},{ts(end)},ClipForge,,0,0,0,,"
                f"{{\\an{alignment(style)}}}" + "\\N".join(highlighted_rows)
            )
            highlight_events += 1

    document = "\n".join(header + events) + "\n"
    stats = {
        "lines": len(lines),
        "words": len(words),
        "highlightEvents": highlight_events,
        "fontSizePx": font_size,
        "position": style.position,
        "alignment": alignment(style),
        "marginV": margin_v(style, output_height),
    }
    return document, stats


def _render_with_highlight(
    words: list[dict],
    highlight_index: int,
    rows: list[str],
    style: SubtitleStyleConfig,
    highlight_colour: str,
    primary_colour: str,
) -> list[str]:
    """Re-renders the rows, wrapping the active word in a colour override."""
    parts: list[str] = []
    for index, word in enumerate(words):
        text = word["word"].strip()
        if style.uppercase:
            text = text.upper()
        if index == highlight_index:
            parts.append(f"{{\\c{highlight_colour}}}{text}{{\\c{primary_colour}}}")
        else:
            parts.append(text)
    joined = " ".join(parts)
    # Re-wrap while preserving override tags by splitting on spaces at row width.
    return _wrap_keep_tags(joined, style)


def _wrap_keep_tags(text: str, style: SubtitleStyleConfig) -> list[str]:
    tokens = text.split(" ")
    rows: list[str] = []
    current = ""
    for token in tokens:
        visible_len = len(re.sub(r"\{[^}]*\}", "", current))
        token_len = len(re.sub(r"\{[^}]*\}", "", token))
        if current and visible_len + 1 + token_len > style.max_chars_per_line:
            rows.append(current)
            current = token
        else:
            current = f"{current} {token}".strip()
    if current:
        rows.append(current)
    if len(rows) > style.max_lines:
        rows = rows[: style.max_lines]
    return rows
