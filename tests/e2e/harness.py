"""Shared helpers for the ClipForge end-to-end suites.

Both `authorization_matrix.py` and `scenarios.py` drive the live stack through its real HTTP API
with cookies, CSRF and all. Keeping the client in one place means a fix to (for example) how the
session CSRF token is obtained cannot land in one suite and be forgotten in the other.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import subprocess
import urllib.error
import urllib.request
import uuid

API = os.environ.get("CLIPFORGE_API", "http://127.0.0.1:4000")
WEB_ORIGIN = os.environ.get("CLIPFORGE_WEB_ORIGIN", "http://127.0.0.1:3000")
ADMIN = ("admin@clipforge.local", "Sandbox-Admin-2026")
MEMBER = ("member@clipforge.local", "Member-Passw0rd-2026")
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://clipforge:clipforge_local_dev@127.0.0.1:5432/clipforge")
PART_BYTES = 8 * 1024 * 1024


class Client:
    """A cookie-jar HTTP client that keeps the CSRF token in sync with the session."""

    def __init__(self) -> None:
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf: str | None = None

    def request(self, method: str, path: str, body=None, headers: dict | None = None, raw: bytes | None = None, csrf: bool = True):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(API + path, data=data, method=method)
        req.add_header("content-type", "application/json")
        req.add_header("origin", WEB_ORIGIN)
        for key, value in (headers or {}).items():
            req.remove_header(key)
            req.add_header(key, value)
        if csrf and self.csrf:
            req.add_header("x-csrf-token", self.csrf)
        try:
            with self.opener.open(req, timeout=1800) as response:
                payload = response.read()
                try:
                    return response.status, (json.loads(payload) if payload else None)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    # Binary payloads (the media probe, a streamed clip) are a result, not an error.
                    return response.status, {"bytes": len(payload)}
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            try:
                return exc.code, json.loads(payload) if payload else None
            except (json.JSONDecodeError, UnicodeDecodeError):
                return exc.code, {"bytes": len(payload)}

    def get(self, path: str, csrf: bool = True):
        return self.request("GET", path, None, csrf=csrf)

    def post(self, path: str, body=None, csrf: bool = True):
        return self.request("POST", path, body if body is not None else {}, csrf=csrf)

    def put(self, path: str, body=None, csrf: bool = True):
        return self.request("PUT", path, body if body is not None else {}, csrf=csrf)

    def refresh_csrf(self) -> None:
        """Authenticated requests use the token bound to the session, not the anonymous one.

        `GET /api/auth/csrf` issues the pre-session double-submit token used only by
        login/register; every later unsafe call must echo the token from `GET /api/auth/session`.
        Getting this wrong makes a CSRF blanket-403 look like a passing authorization test.
        """
        status, body = self.request("GET", "/api/auth/session", None, csrf=False)
        if status == 200 and isinstance(body, dict) and body.get("authenticated") and body.get("csrfToken"):
            self.csrf = body["csrfToken"]
            return
        status, body = self.request("GET", "/api/auth/csrf", None, csrf=False)
        if status == 200 and isinstance(body, dict):
            self.csrf = body.get("csrfToken")

    def login(self, email: str, password: str) -> int:
        self.refresh_csrf()
        status, _ = self.post("/api/auth/login", {"email": email, "password": password})
        if status < 300:
            self.refresh_csrf()
        return status


def sql(statement: str) -> str:
    """Run SQL through psql. Test-only: statements are built from UUIDs this file generated."""
    # psql does not understand Prisma's "?schema=public" query parameter; strip it.
    dsn = DATABASE_URL.split("?")[0]
    proc = subprocess.run(["psql", dsn, "-t", "-A", "-c", statement], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"psql failed: {proc.stderr[-400:]}")
    return proc.stdout.strip()


def flush_login_ratelimit() -> None:
    # Scripted logins from one IP would otherwise trip the login rate limiter, which works as designed.
    subprocess.run(["redis-cli", "DEL", "clipforge:ratelimit:auth-login:127.0.0.1"], capture_output=True, check=False)


def flush_rate_limits(scope: str | None = None) -> None:
    """Clear Redis rate-limit windows so a long suite does not fail on its own earlier traffic.

    The limiter is real (10 job creations per minute per user) — this makes the suite independent of
    it rather than weakening it. Scenarios that assert the limiter (03) call this first, too.
    """
    pattern = f"clipforge:ratelimit:{scope}:*" if scope else "clipforge:ratelimit:*"
    keys = subprocess.run(["redis-cli", "--scan", "--pattern", pattern], capture_output=True, text=True).stdout.split()
    if keys:
        subprocess.run(["redis-cli", "DEL", *keys], capture_output=True, check=False)


def multipart(fields: dict, file_field: str, filename: str, content: bytes) -> tuple[bytes, str]:
    boundary = f"----clipforge{uuid.uuid4().hex}"
    lines: list[bytes] = []
    for key, value in fields.items():
        lines.append(f"--{boundary}".encode())
        lines.append(f'Content-Disposition: form-data; name="{key}"'.encode())
        lines.append(b"")
        lines.append(str(value).encode())
    lines.append(f"--{boundary}".encode())
    lines.append(f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"'.encode())
    lines.append(b"Content-Type: application/octet-stream")
    lines.append(b"")
    lines.append(content)
    lines.append(f"--{boundary}--".encode())
    lines.append(b"")
    return b"\r\n".join(lines), f"multipart/form-data; boundary={boundary}"


class Results:
    """Collects pass/fail lines and prints them as the suite runs."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def record(self, name: str, ok: bool, detail: str) -> bool:
        self.items.append({"name": name, "ok": ok, "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}", flush=True)
        return ok

    # Short aliases: a checker reads better as results.check(...) than results.record(...).
    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        return self.record(name, ok, detail)

    def report(self) -> int:
        return self.summary()

    def summary(self) -> int:
        failed = [item for item in self.items if not item["ok"]]
        print(f"\n{len(self.items) - len(failed)}/{len(self.items)} checks passed", flush=True)
        if failed:
            print("FAILURES:")
            for item in failed:
                print(f"  - {item['name']}: {item['detail']}")
        return 1 if failed else 0


def error_code(body) -> str | None:
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            return error.get("code")
    return None


def create_second_tenant(suffix: str | None = None) -> tuple[str, str, str, str]:
    """Create a throwaway user+workspace (owner) that shares the sandbox password hash.

    Returns `(email, password, userId, workspaceId)`. The caller is responsible for cleanup via
    `delete_tenant`.
    """
    suffix = suffix or uuid.uuid4().hex[:8]
    user_id = str(uuid.uuid4())
    workspace_id = str(uuid.uuid4())
    email = f"tenant-{suffix}@clipforge.local"
    sql(
        f"""
        BEGIN;
        INSERT INTO "User" (id, email, "passwordHash", "displayName", role, status, "updatedAt")
          SELECT '{user_id}', '{email}', "passwordHash", 'Tenant {suffix}', 'OWNER', 'ACTIVE', now()
          FROM "User" WHERE email = 'admin@clipforge.local';
        INSERT INTO "Workspace" (id, name, slug, "updatedAt")
          VALUES ('{workspace_id}', 'Tenant {suffix}', 'tenant-{suffix}', now());
        INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role)
          VALUES (gen_random_uuid(), '{workspace_id}', '{user_id}', 'OWNER');
        COMMIT;
        """
    )
    return email, ADMIN[1], user_id, workspace_id


def delete_tenant(user_id: str, workspace_id: str) -> None:
    sql(f'DELETE FROM "Workspace" WHERE id = \'{workspace_id}\';')
    sql(f'DELETE FROM "User" WHERE id = \'{user_id}\';')
