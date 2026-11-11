"""End-to-end checks for the account-security surface, against the live stack.

What this suite deliberately does NOT do:

  * It does not stub SMTP, the database, or the HTTP layer. `tests/e2e/smtp_sink.py` is a real SMTP
    listener; the API delivers codes with nodemailer over TCP. Reading the code out of the delivered
    message is the only way to prove the delivery path works end to end.
  * It does not assert Telegram delivery of a code, because that needs a human to read their own
    Telegram app. Telegram-specific behaviour that CAN be checked without a human is checked: the
    policy refuses a channel that cannot deliver, and a bogus chat id surfaces a delivery error
    instead of a false success.

Preconditions (the runner script sets them up): the API is running with `SMTP_HOST=127.0.0.1`,
`SMTP_PORT=1025`, `SMTP_FROM` set, and Postgres/Redis up.

Run:  bash tests/e2e/run_auth_security.sh
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from harness import (  # noqa: E402
    ADMIN,
    Client,
    Results,
    create_second_tenant,
    delete_tenant,
    error_code,
    flush_rate_limits,
    sql,
)

MAILDIR = pathlib.Path("/tmp/clipforge-inbox")
SINK_PORT = 1025
SINK = pathlib.Path(__file__).parent / "smtp_sink.py"
PYTHON = str(pathlib.Path(__file__).resolve().parents[2] / ".venv" / "bin" / "python")


# --------------------------------------------------------------------------- helpers

def start_sink() -> subprocess.Popen:
    """Start the SMTP listener, emptying the inbox first so codes cannot be confused."""
    for stale in MAILDIR.glob("*.eml"):
        stale.unlink()
    MAILDIR.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        [PYTHON, str(SINK), "--port", str(SINK_PORT), "--maildir", str(MAILDIR)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    for _ in range(100):
        probe = subprocess.run(
            ["bash", "-c", f"exec 3<>/dev/tcp/127.0.0.1/{SINK_PORT}"], capture_output=True, check=False
        )
        if probe.returncode == 0:
            return process
        time.sleep(0.1)
    process.terminate()
    raise RuntimeError("SMTP sink did not start")


def wait_for_code(since: int = 0, timeout: float = 20.0) -> tuple[str, str]:
    """Return `(code, recipient)` for the newest delivered message after index `since`."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        files = sorted(MAILDIR.glob("*.eml"))
        if len(files) > since:
            raw = files[-1].read_text(errors="replace")
            code = re.search(r"\b(\d{6})\b", raw)
            to = re.search(r"^To: (.+)$", raw, re.MULTILINE)
            if code:
                return code.group(1), (to.group(1).strip() if to else "")
        time.sleep(0.25)
    raise AssertionError(f"no verification email arrived within {timeout}s")


def mail_count() -> int:
    return len(list(MAILDIR.glob("*.eml")))


def otp_mode_of(user_id: str) -> str:
    return sql(f'SELECT "otpMode" FROM "User" WHERE id = \'{user_id}\'')


def set_mode_via_sql(user_id: str, mode: str) -> None:
    """Emergency reset path used in `finally`, so a failed run cannot leave admin locked behind OTP."""
    sql(f'UPDATE "User" SET "otpMode" = \'{mode}\' WHERE id = \'{user_id}\'')


# --------------------------------------------------------------------------- the suite

def main() -> int:
    results = Results()
    sink = start_sink()
    admin_id = sql("SELECT id FROM \"User\" WHERE email = 'admin@clipforge.local'")
    tenant = None

    try:
        flush_rate_limits()

        # 1. Baseline: the old password-only flow is untouched for accounts with no OTP policy.
        client = Client()
        status = client.login(*ADMIN)
        results.check("login without OTP still works", status in (200, 201), f"status={status}")
        status, session = client.get("/api/auth/session")
        results.check("session is authenticated", status == 200 and session.get("authenticated") is True, f"status={status}")

        # 2. The security surface requires a session.
        anon = Client()
        status, body = anon.get("/api/auth/security/overview")
        results.check("overview refuses anonymous", status == 401, f"status={status} code={error_code(body)}")
        status, _ = anon.post("/api/auth/security/recovery-codes", {})
        results.check("recovery-code generation refuses anonymous", status == 401, f"status={status}")

        # 3. Overview reports what can actually deliver, and says so honestly.
        status, overview = client.get("/api/auth/security/overview")
        email_ready = overview.get("channels", {}).get("email") if isinstance(overview, dict) else None
        results.check("overview reports email channel", status == 200 and isinstance(overview, dict), f"status={status}")
        results.check("email channel is configured with the sink reachable", email_ready is True, f"email={email_ready}")
        results.check(
            "overview exposes no plaintext secrets",
            "SMTP_PASS" not in str(overview) and "TELEGRAM_BOT_TOKEN" not in str(overview),
            "no secret names echoed",
        )

        # 4. A channel that cannot deliver is refused instead of silently accepted.
        status, body = client.put("/api/auth/security/otp-mode", {"mode": "TELEGRAM"})
        results.check(
            "TELEGRAM policy refused while no chat is linked",
            status == 400,
            f"status={status} code={error_code(body)}",
        )

        # 5. Turn the second factor on through the API, i.e. the way a user would.
        status, body = client.put("/api/auth/security/otp-mode", {"mode": "EMAIL"})
        results.check("EMAIL policy accepted once SMTP works", status == 200, f"status={status}")
        results.check("otpMode persisted", otp_mode_of(admin_id) == "EMAIL", f"db={otp_mode_of(admin_id)}")

        # 6. Now a password alone must NOT produce a session.
        otp_client = Client()
        otp_client.refresh_csrf()
        before = mail_count()
        status, step_up = otp_client.post("/api/auth/login", {"email": ADMIN[0], "password": ADMIN[1]})
        results.check("login returns a step-up payload", status in (200, 201) and step_up.get("otpRequired") is True, f"status={status}")
        challenges = step_up.get("challenges") or []
        results.check("one challenge per required channel", len(challenges) == 1 and challenges[0]["channel"] == "EMAIL", f"challenges={[(c['channel']) for c in challenges]}")
        results.check(
            "no session cookie before the code is verified",
            not any(cookie.name == "cf_session" for cookie in otp_client.jar),
            "cookie jar has no session",
        )
        status, session = otp_client.get("/api/auth/session")
        results.check("no authenticated session yet", session.get("authenticated") is False, f"status={status}")
        results.check("challenge destination is masked", "•" in challenges[0]["destination"], f"destination={challenges[0]['destination']}")

        code, recipient = wait_for_code(before)
        results.check("the code was delivered by SMTP", bool(re.fullmatch(r"\d{6}", code)), f"to={recipient}")
        challenge_id = challenges[0]["challengeId"]

        # 7. A wrong code is rejected and costs an attempt; the response says how many are left.
        wrong = "000000" if code != "000000" else "111111"
        status, body = otp_client.post(
            "/api/auth/security/otp/step-up/complete", {"challengeIds": [challenge_id], "codes": [wrong]}
        )
        results.check("wrong code is refused", status == 401 and error_code(body) == "OTP_INVALID", f"status={status} code={error_code(body)}")
        attempts = ((body or {}).get("error", {}).get("details") or {}).get("attemptsRemaining") if isinstance(body, dict) else None
        results.check("wrong code reports remaining attempts", attempts == 4, f"attemptsRemaining={attempts}")

        # 8. The right code issues exactly one session.
        status, body = otp_client.post(
            "/api/auth/security/otp/step-up/complete", {"challengeIds": [challenge_id], "codes": [code]}
        )
        results.check("correct code opens the session", status in (200, 201), f"status={status}")
        otp_client.refresh_csrf()
        status, session = otp_client.get("/api/auth/session")
        results.check("session works after step-up", session.get("authenticated") is True, f"status={status}")

        # 9. Single use: replaying the same code must fail.
        replay = Client()
        status, body = replay.post(
            "/api/auth/security/otp/step-up/complete", {"challengeIds": [challenge_id], "codes": [code]}
        )
        results.check("a used code cannot be replayed", status == 401 and error_code(body) == "OTP_INVALID", f"status={status} code={error_code(body)}")

        # 10. Resend cooldown is enforced server-side (60 s by default).
        status, body = otp_client.post("/api/auth/security/otp/resend", {"challengeId": challenge_id})
        results.check("resend after use is refused", status == 400, f"status={status} code={error_code(body)}")

        # 11. Login history records both the challenge and the success, with no plaintext code anywhere.
        status, history = otp_client.get("/api/auth/security/login-history")
        rows = history if isinstance(history, list) else (history or {}).get("events") or []
        outcomes = {row["outcome"] for row in rows}
        results.check("login history has the challenge", "OTP_CHALLENGE" in outcomes, f"outcomes={sorted(outcomes)}")
        results.check("login history has the OTP success", "SUCCESS" in outcomes, f"outcomes={sorted(outcomes)}")
        results.check("login history never stores a code", code not in str(history), "code absent from history payload")
        otp_rows = sql(f'SELECT "codeHash" FROM "OtpChallenge" WHERE "userId" = \'{admin_id}\'')
        results.check(
            "codes are stored hashed, never plaintext",
            code not in otp_rows and len(set(otp_rows.split())) > 0,
            f"{len(otp_rows.split())} rows, plaintext absent",
        )

        # 12. Session management: the current session is flagged, revocation is real.
        status, sessions = otp_client.get("/api/auth/security/sessions")
        items = sessions if isinstance(sessions, list) else (sessions or {}).get("sessions") or []
        current = [row for row in items if row.get("current")]
        results.check("session list flags the current session", status == 200 and len(current) == 1, f"sessions={len(items)}")
        results.check("session list carries a device label", bool((current or [{}])[0].get("device")), f"label={(current or [{}])[0].get('device')}")

        # With the policy on, a second password login cannot reach a session either: two independent
        # clients both stuck at the challenge stage is the proof that the factor is not bypassable.
        blocked = Client()
        status, step_up = blocked.post("/api/auth/login", {"email": ADMIN[0], "password": ADMIN[1]})
        status2, blocked_session = blocked.get("/api/auth/session")
        results.check(
            "a second device also stops at the challenge",
            step_up.get("otpRequired") is True and blocked_session.get("authenticated") is False,
            f"login={status} authenticated={blocked_session.get('authenticated')}",
        )

        # Revoking "all others" is a real revocation: the stale sessions below disappear from the list.
        before_sessions = len(items)
        status, body = otp_client.post("/api/auth/security/sessions/revoke-all", {"keepCurrent": True})
        results.check("revoke-all keeps the current session", status in (200, 201), f"status={status} revoked={(body or {}).get('revoked')}")
        status, sessions = otp_client.get("/api/auth/security/sessions")
        results.check(
            "only the current session survives revoke-all",
            status == 200 and len(sessions if isinstance(sessions, list) else [row for row in sessions.get('sessions', [])]) == 1,
            f"before={before_sessions}",
        )

        # 13. Turning the policy back off restores password-only login immediately.
        status, body = otp_client.put("/api/auth/security/otp-mode", {"mode": "OFF"})
        results.check("policy can be disabled again", status == 200 and otp_mode_of(admin_id) == "OFF", f"status={status}")
        plain = Client()
        status = plain.login(*ADMIN)
        results.check("password-only login works again", status in (200, 201), f"status={status}")

        # ---- password recovery on a throwaway account ------------------------
        email, password, user_id, workspace_id = create_second_tenant()
        tenant = (user_id, workspace_id)
        recovery = Client()
        before = mail_count()
        status, body = recovery.post("/api/auth/security/forgot-password", {"email": email})
        results.check("forgot-password accepts a real address", status in (200, 201), f"status={status}")

        anonymous_result = Client()
        status, unknown_body = anonymous_result.post(
            "/api/auth/security/forgot-password", {"email": f"nobody-{uuid.uuid4().hex[:6]}@clipforge.local"}
        )
        results.check(
            "forgot-password for an unknown address is indistinguishable",
            status in (200, 201) and unknown_body == body,
            f"known={body} unknown={unknown_body}",
        )

        reset_code, _ = wait_for_code(before)
        new_password = "Recovered-Passw0rd-2026"
        status, body = recovery.post(
            "/api/auth/security/reset-password",
            {"email": email, "code": reset_code, "newPassword": new_password},
        )
        results.check("password reset succeeds with the mailed code", status in (200, 201), f"status={status} code={error_code(body)}")
        revoked = sql(f'SELECT count(*) FROM "Session" WHERE "userId" = \'{user_id}\' AND "revokedAt" IS NULL')
        results.check("reset revoked every existing session", revoked.strip() in ("0", ""), f"active sessions={revoked.strip() or '0'}")
        old_client = Client()
        results.check("the old password stops working", old_client.login(email, password) == 401, "old password rejected")
        new_client = Client()
        results.check("the new password works", new_client.login(email, new_password) in (200, 201), "new password accepted")

        # ---- recovery codes -------------------------------------------------
        status, body = new_client.post("/api/auth/security/recovery-codes", {})
        codes = body.get("codes") if isinstance(body, dict) else None
        results.check("ten recovery codes are issued", status in (200, 201) and len(codes or []) == 10, f"count={len(codes or [])}")
        stored = sql(f'SELECT "codeHash" FROM "RecoveryCode" WHERE "userId" = \'{user_id}\'')
        results.check("recovery codes are stored hashed", (codes or [""])[0] not in stored, "plaintext absent from table")
        status, body = new_client.get("/api/auth/security/recovery-codes")
        results.check("recovery-code status reports ten unused", isinstance(body, dict) and body.get("remaining") == 10, f"body={body}")

        # Telegram: a chat the bot has never spoken to must fail loudly, not silently "link".
        linking_client = Client()
        linking_client.login(email, new_password)
        status, body = linking_client.post("/api/auth/security/telegram/link/start", {"chatId": "1000000001"})
        results.check(
            "linking a chat the bot has never seen fails loudly",
            status >= 400 and error_code(body) in ("OTP_DELIVERY_FAILED", "VALIDATION_FAILED"),
            f"status={status} code={error_code(body)}",
        )

        redeemed_client = Client()
        third_password = "Recovered-Again-2026"
        status, body = redeemed_client.post(
            "/api/auth/security/recovery-codes/redeem",
            {"email": email, "code": codes[0], "newPassword": third_password},
        )
        results.check("a recovery code resets the password", status in (200, 201), f"status={status} code={error_code(body)}")
        results.check("the recovered password works", Client().login(email, third_password) in (200, 201), "login ok")
        status, body = redeemed_client.post(
            "/api/auth/security/recovery-codes/redeem",
            {"email": email, "code": codes[0], "newPassword": "Another-Passw0rd-2026"},
        )
        results.check("a recovery code cannot be reused", status >= 400, f"status={status}")

    finally:
        # The admin account must never be left behind a second factor the next suite cannot pass.
        set_mode_via_sql(admin_id, "OFF")
        sql(f'DELETE FROM "OtpChallenge" WHERE "userId" = \'{admin_id}\'')
        sql(f'DELETE FROM "LoginEvent" WHERE "userId" = \'{admin_id}\'')
        if tenant:
            delete_tenant(*tenant)
        sink.terminate()
        flush_rate_limits()

    return results.summary()


if __name__ == "__main__":
    raise SystemExit(main())
