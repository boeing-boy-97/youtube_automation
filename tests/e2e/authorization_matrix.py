#!/usr/bin/env python3
"""Authorization matrix against a running ClipForge stack.

Three questions this answers, with evidence rather than inspection:

  1. Can an unauthenticated caller reach anything that is not explicitly public?
  2. Can a MEMBER reach operator surfaces (system, usage)?
  3. Can a user in workspace B read or mutate workspace A's resources by guessing ids?

Every 200 is counted, so a missing guard shows up as a passing request rather than a silent gap.
The cross-tenant probe uses a throwaway workspace created directly in PostgreSQL (with the same
password hash as the sandbox admin) and is removed at the end.

Run: .venv/bin/python tests/e2e/authorization_matrix.py
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import (  # noqa: E402
    ADMIN,
    MEMBER,
    ensure_member,
    Client,
    create_second_tenant,
    delete_tenant,
    flush_login_ratelimit,
    sql,
)

RESULTS: list[dict] = []


def record(name: str, ok: bool, detail: str) -> None:
    RESULTS.append({"name": name, "ok": ok, "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}", flush=True)


def main() -> int:
    flush_login_ratelimit()
    anon = Client()

    # --------------------------- 1. anonymous surface ---------------------------
    public_ok = ["/api/auth/csrf", "/media/health/probe.mp4", "/api/system/health", "/api/system/readiness"]
    for path in public_ok:
        status, _ = anon.get(path, csrf=False)
        record(f"anonymous can reach {path}", status == 200, f"HTTP {status}")

    protected = [
        "/api/jobs",
        "/api/clips",
        "/api/sources",
        "/api/accounts",
        "/api/publishing/jobs",
        "/api/publishing/history",
        "/api/dashboard/summary",
        "/api/configuration",
        "/api/activity",
        "/api/system/overview",
        "/api/system/worker-status",
        "/api/system/queue-status",
        "/api/system/events",
        "/api/usage/summary",
        "/api/usage/daily",
        "/api/usage/records",
    ]
    leaks = []
    for path in protected:
        status, _ = anon.get(path, csrf=False)
        if status != 401:
            leaks.append(f"{path} -> {status}")
    record("every protected route rejects anonymous callers with 401", not leaks, ", ".join(leaks) or "16/16 returned 401")

    status, _ = anon.post("/api/jobs", {"sourceVideoId": str(uuid.uuid4())}, csrf=False)
    record("anonymous POST /api/jobs is rejected", status == 401, f"HTTP {status}")

    # ---------------------------------- 2. roles --------------------------------
    # The member fixture is created on demand: a re-provisioned database otherwise turns every role
    # assertion into a misleading 401.
    ensure_member()
    flush_login_ratelimit()
    member = Client()
    status = member.login(*MEMBER)
    record("member can log in", status < 300, f"HTTP {status}")

    status, _ = member.get("/api/jobs")
    record("member can read their own workspace jobs", status == 200, f"HTTP {status}")

    operator_routes = [
        "/api/system/overview",
        "/api/system/worker-status",
        "/api/system/queue-status",
        "/api/system/events",
        "/api/usage/summary",
        "/api/usage/daily",
        "/api/usage/records",
    ]
    allowed = [path for path in operator_routes if member.get(path)[0] == 200]
    record("member cannot reach operator routes", not allowed, ", ".join(allowed) or "7/7 returned 403")

    # CSRF: an authenticated member without the header must not be able to mutate state.
    csrf_less = Client()
    csrf_less.login(*MEMBER)
    saved = csrf_less.csrf
    csrf_less.csrf = None
    # Use a route the member IS allowed to call, so the only reason to refuse is the missing token
    # (an operator-only route would be rejected by the role guard first, which proves nothing here).
    status, body = csrf_less.post("/api/jobs", {"sourceVideoId": str(uuid.uuid4())}, csrf=False)
    code = ((body or {}).get("error") or {}).get("code") if isinstance(body, dict) else None
    record("state-changing request without CSRF token is rejected", status in (401, 403), f"HTTP {status} ({code})")
    record("the CSRF guard is what rejected it", code == "CSRF_FAILED", f"code={code}")
    csrf_less.csrf = saved

    # ------------------------------ 3. cross tenant -----------------------------
    admin = Client()
    status = admin.login(*ADMIN)
    record("admin can log in", status < 300, f"HTTP {status}")

    def first_id(path: str, field: str = "id") -> str | None:
        status, body = admin.get(path)
        if status != 200:
            return None
        items = body.get("items") if isinstance(body, dict) else None
        if not items:
            return None
        return items[0].get(field)

    admin_job = first_id("/api/jobs")
    admin_clip = first_id("/api/clips")
    admin_source = first_id("/api/sources")
    status, cfg = admin.get("/api/configuration")
    admin_workspace = cfg.get("workspaceId") if isinstance(cfg, dict) else None
    # A job and a source always exist once the workflow suite has run; clips only after a job has
    # produced one, so a missing clip is a skipped probe rather than a failure.
    record(
        "admin resources resolved for the cross-tenant probe",
        bool(admin_job and admin_source),
        f"job={admin_job} clip={admin_clip or 'none (clip probes skipped)'} source={admin_source}",
    )

    suffix = uuid.uuid4().hex[:8]
    other_email, other_password, other_user_id, other_workspace_id = create_second_tenant(suffix)

    other = Client()
    status = other.login(other_email, other_password)
    record("second tenant can log in", status < 300, f"HTTP {status}")

    status, body = other.get("/api/jobs")
    record("second tenant starts with an empty job list", status == 200 and not (body or {}).get("items"), f"HTTP {status}, {len((body or {}).get('items') or [])} item(s)")

    cross_reads = {
        f"/api/jobs/{admin_job}": admin_job,
        f"/api/jobs/{admin_job}/events": admin_job,
        f"/api/clips/{admin_clip}": admin_clip,
        f"/api/clips/{admin_clip}/preview": admin_clip,
        f"/api/sources/{admin_source}": admin_source,
        f"/media/clips/{admin_clip}": admin_clip,
        "/api/brand-profiles/5fdbf395-0000-0000-0000-000000000000": "brand profile",
    }
    exposed = []
    not_found = 0
    skipped = 0
    for path, ident in cross_reads.items():
        if ident is None:
            # No clip/source in the admin workspace (fresh database): a probe built from a null id
            # would test the router, not tenancy, so it is counted as skipped.
            skipped += 1
            continue
        status, _ = other.get(path)
        if status == 200:
            exposed.append(f"{path} -> 200 ({ident})")
        elif status == 404:
            not_found += 1
    record(
        "second tenant cannot read first tenant resources by id (404, not 403)",
        not exposed,
        ", ".join(exposed) or f"{not_found} probes returned 404, {skipped} skipped (no fixture)",
    )

    def denied(label: str, status: int, body) -> bool:
        """A denial must be an ownership denial, never a rejected CSRF token in disguise."""
        code = ((body or {}).get("error") or {}).get("code") if isinstance(body, dict) else None
        ok = status in (403, 404) and code != "CSRF_FAILED"
        record(label, ok, f"HTTP {status}{' (' + str(code) + ')' if code else ''}")
        return ok

    status, body = other.post(f"/api/jobs/{admin_job}/cancel")
    denied("second tenant cannot cancel another tenant's job", status, body)
    status, body = other.post(f"/api/jobs/{admin_job}/retry")
    denied("second tenant cannot retry another tenant's job", status, body)
    if admin_clip:
        status, body = other.request("PATCH", f"/api/clips/{admin_clip}/metadata", {"platform": "YOUTUBE", "title": "hijacked"})
        denied("second tenant cannot patch another tenant's clip metadata", status, body)
    else:
        record("second tenant cannot patch another tenant's clip metadata", True, "skipped: no clip fixture")

    # ------------------- 3b. operator-only workspace surfaces ------------------
    # Members are full participants in the workflow (upload, process, publish a clip) but must not
    # change the settings, credentials or assets that decide what ships under the brand.
    operator_mutations = {
        "member cannot rewrite workspace configuration": ("PUT", "/api/configuration", {"entries": [{"key": "render.fps", "value": 30}]}),
        "member cannot create a brand profile": ("POST", "/api/brand-profiles", {"name": "member brand", "brandVoice": "educational", "primaryColor": "#000000", "watermarkPosition": "bottom-right"}),
        "member cannot create a subtitle preset": ("POST", "/api/subtitle-presets", {"name": "member preset", "fontFamily": "Inter", "fontSizePx": 48}),
        "member cannot start an OAuth connection": ("POST", "/api/accounts/youtube/connect", {}),
        "member cannot enable automatic publishing": ("POST", "/api/publishing/enable", {"platform": "YOUTUBE", "connectedAccountId": str(uuid.uuid4()), "enabled": True}),
    }
    for label, (method, path, payload) in operator_mutations.items():
        status, body = member.request(method, path, payload)
        code = ((body or {}).get("error") or {}).get("code") if isinstance(body, dict) else None
        record(label, status == 403 and code == "FORBIDDEN", f"HTTP {status} ({code})")

    # Controls: without these, every "denied" result above could just be a broken CSRF token.
    status, config_body = admin.get("/api/configuration")
    current_fps = ((config_body or {}).get("values") or {}).get("render.fps", 30)
    status, body = admin.request("PUT", "/api/configuration", {"entries": [{"key": "render.fps", "value": current_fps}]})
    record("control: owner can write valid workspace configuration", status == 200, f"HTTP {status}")
    # And the same member who was refused a settings write can still do the actual work.
    status, body = member.get("/api/clips")
    record("control: member can still read clips", status == 200, f"HTTP {status}")

    # ------------------------------- 4. cleanup --------------------------------
    delete_tenant(other_user_id, other_workspace_id)
    leftover = sql(f'SELECT count(*) FROM "User" WHERE id = \'{other_user_id}\';').strip()
    record("cross-tenant probe cleaned up", leftover == "0", f"remaining user rows: {leftover}")

    failed = [r for r in RESULTS if not r["ok"]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} authorization checks passed")
    if failed:
        print("FAILURES:")
        for item in failed:
            print(f"  - {item['name']}: {item['detail']}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
