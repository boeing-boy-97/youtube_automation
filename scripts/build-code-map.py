#!/usr/bin/env python3
"""Regenerate docs/CODE-MAP.md: every tracked file with its line count and purpose.

Kept as a script rather than hand-written so the map cannot drift from the tree. Purpose text is
taken from the file's own docstring/header comment — if a module has no header, the map shows a dash
and that is a signal to add one.

Usage:  .venv/bin/python scripts/build-code-map.py
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "CODE-MAP.md"
CODE_EXT = {".ts", ".tsx", ".py", ".prisma", ".sh", ".sql"}
INCLUDE = CODE_EXT | {".json", ".yml", ".yaml", ".md", ".css", ".mjs"}
SKIP_NAMES = {"package-lock.json", "tsconfig.tsbuildinfo", "docs/CODE-MAP.md"}

GROUPS: list[tuple[str, callable]] = [
    ("API server — `apps/api`", lambda p: p.startswith("apps/api/")),
    ("Web dashboard — `apps/web`", lambda p: p.startswith("apps/web/")),
    ("Shared packages — `packages`", lambda p: p.startswith("packages/")),
    ("Python services — `services`", lambda p: p.startswith("services/")),
    ("Tests — `tests`", lambda p: p.startswith("tests/")),
    ("Developer scripts — `scripts`", lambda p: p.startswith("scripts/")),
    ("Infrastructure & deployment", lambda p: p.startswith("infrastructure/") or p.startswith("docker-compose")
        or p in {"package.json", "tsconfig.json", "tsconfig.base.json", ".env.example", ".dockerignore", ".gitignore", "README.md"}),
    ("Documentation — `docs`", lambda p: p.startswith("docs/")),
]


def purpose_of(text: str, suffix: str) -> str:
    match = re.search(r'(?:"""|\'\'\')(.+?)(?:"""|\'\'\')', text, re.S)
    if match:
        return " ".join(match.group(1).split())[:150]
    match = re.search(r"/\*\*(.+?)\*/", text, re.S)
    if match:
        body = re.sub(r"^\s*\*\s?", "", match.group(1), flags=re.M)
        return " ".join(body.split())[:150]
    for line in text.splitlines()[:8]:
        stripped = line.strip()
        if stripped.startswith("#") and len(stripped) > 2:
            return stripped.lstrip("# ").strip()[:150]
    return ""


def main() -> None:
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    rows = []
    for rel in sorted(tracked):
        path = ROOT / rel
        if rel in SKIP_NAMES or path.suffix not in INCLUDE or not path.is_file():
            continue
        text = path.read_text(errors="ignore")
        rows.append({"path": rel, "loc": len(text.splitlines()), "ext": path.suffix, "purpose": purpose_of(text, path.suffix)})

    code = [r for r in rows if r["ext"] in CODE_EXT]
    lines = ["# ClipForge AI — code map", "",
             "Every file that makes up this project, with its line count and what it does. This is an index, "
             "not a copy: the code lives at the path shown. Regenerate with "
             "`.venv/bin/python scripts/build-code-map.py` — do not hand-edit.", "",
             f"**{len(code)} source files · {sum(r['loc'] for r in code):,} lines · {len(rows)} files tracked in git**", "",
             f"Repository root `/home/user/clipforge-ai` · branch `master` · HEAD `{head}`", ""]

    for title, match in GROUPS:
        group = [r for r in rows if match(r["path"])]
        if not group:
            continue
        group_code = [r for r in group if r["ext"] in CODE_EXT]
        lines += ["", f"## {title}", "", f"{len(group_code)} source files · {sum(r['loc'] for r in group_code):,} lines", "",
                  "| file | lines | purpose |", "| --- | ---: | --- |"]
        for row in group:
            lines.append(f"| `{row['path']}` | {row['loc']} | {row['purpose'].replace('|', chr(92) + '|') or '—'} |")

    lines += ["", "---", "", "## Where the work happens", "", "| question | file |", "| --- | --- |",
              "| How is a video turned into clips? | `apps/api/src/workers/pipeline.worker.ts` + `services/ai-engine/app/pipeline.py` |",
              "| How are clips rendered? | `services/video-processor/app/renderer.py` (+ `framing.py`, `subtitles.py`, `audio.py`) |",
              "| How are candidates chosen? | `services/ai-engine/app/selection.py` |",
              "| How is publication done? | `apps/api/src/workers/publish.worker.ts` + `packages/platform-connectors/src/` |",
              "| Where is the data model? | `packages/database/prisma/schema.prisma` |",
              "| Where is auth / sessions / CSRF? | `apps/api/src/auth/`, `apps/api/src/common/guards/` |",
              "| Where is cost accounting? | `apps/api/src/common/services/usage-cost.ts`, `apps/api/src/usage/` |",
              "| Where are the end-to-end scenarios? | `tests/e2e/scenarios.py` |"]
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(rows)} files, {sum(r['loc'] for r in code):,} code lines)")


if __name__ == "__main__":
    main()
