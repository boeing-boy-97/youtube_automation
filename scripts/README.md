# scripts/

Repository automation that a developer runs by hand. Deployment and runtime scripts are **not**
here — they live in `infrastructure/scripts/` because they ship with the containers.

| script | what it does | when to run it |
| --- | --- | --- |
| `build-code-bundle.py` | Emits `clipforge-ai-code.html`, a single self-contained page containing every source file (filterable tree + code panes, no external assets) | When you need to read or share the whole codebase as one file |

```bash
.venv/bin/python scripts/build-code-bundle.py            # -> /home/user/clipforge-ai-code.html
.venv/bin/python scripts/build-code-bundle.py out.html   # custom destination
```

Rules for anything added here:
* Standard library or already-installed dependencies only — no new tooling just for a script.
* Safe to run twice; never destructive (no `rm -rf` of tracked paths).
* Print what it wrote and where.
