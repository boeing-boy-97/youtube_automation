"""Google sign-in contract, end to end.

Covers the three layers that can each break silently:
  1. what the API advertises to the login screen (GET /api/auth/providers),
  2. what it does with a token it cannot verify (must be 503 FIREBASE_NOT_CONFIGURED, never a 500),
  3. what a browser actually renders when Firebase is not configured — and that email+password
     still works, because "add Google login" must never mean "break the other one".

Run with the stack up:  python3 tests/e2e/firebase_auth.py
"""
from __future__ import annotations

import json
import sys

from harness import ADMIN, WEB_ORIGIN, Client, Results, flush_login_ratelimit

results = Results()


def api_contract() -> None:
    client = Client()
    status, body = client.get("/api/auth/providers", csrf=False)
    results.record("providers is public and answers 200", status == 200, f"status={status}")
    providers = body if isinstance(body, dict) else {}
    results.record("password sign-in is always advertised", providers.get("password") is True, json.dumps(providers.get("password")))
    firebase = providers.get("firebase") or {}
    results.record(
        "firebase block reports both halves separately",
        {"enabled", "config", "verifyConfigured", "webConfigured"} <= set(firebase),
        json.dumps(sorted(firebase.keys())),
    )
    # The public web config may exist without a verifier (that is a real, describable state), but it
    # must never carry a secret and must never be reported as "enabled".
    config = firebase.get("config") or {}
    results.record(
        "the served web config holds no secret",
        "PRIVATE KEY" not in json.dumps(firebase) and "private_key" not in json.dumps(firebase),
        f"keys={sorted(config.keys())}",
    )
    if firebase.get("webConfigured"):
        results.record(
            "a web config present in the browser is a complete-enough public config",
            bool(config.get("apiKey")) and bool(config.get("projectId")),
            f"project={config.get('projectId')}",
        )
    if not firebase.get("enabled"):
        message = str(firebase.get("error") or "")
        results.record(
            "when the button cannot work, the response says which half is missing",
            ("service account" in message) or ("web config" in message) or ("Neither half" in message),
            message[:140],
        )

    # A token that cannot be verified must be an explicit, actionable refusal.
    status, body = client.post("/api/auth/firebase", {"idToken": "x" * 80}, csrf=False)
    code = ((body or {}).get("error") or {}).get("code") if isinstance(body, dict) else None
    expected = "FIREBASE_NOT_CONFIGURED" if not firebase.get("enabled") else "INVALID_ID_TOKEN"
    results.record(
        "an unverifiable ID token is refused, not 500",
        status in (401, 503) and code == expected,
        f"status={status} code={code}",
    )

    # Schema-level rejection happens before any Firebase call.
    status, body = client.post("/api/auth/firebase", {"idToken": "short"}, csrf=False)
    code = ((body or {}).get("error") or {}).get("code") if isinstance(body, dict) else None
    results.record("a malformed body is a validation error", status == 400 and code == "VALIDATION_FAILED", f"status={status} code={code}")

    # The session payload must say which sign-in methods the account has — the UI relies on it.
    flush_login_ratelimit()
    client = Client()
    status = client.login(*ADMIN)
    results.record("password login still works", status < 300, f"status={status}")
    status, body = client.get("/api/auth/session")
    methods = ((body or {}).get("user") or {}).get("authMethods") if isinstance(body, dict) else None
    results.record("session reports the account's sign-in methods", status == 200 and methods == ["PASSWORD"], f"authMethods={methods}")


def browser_login() -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError:
        results.record("browser checks", False, "playwright not installed — skipped")
        return

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors: list[str] = []
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.goto(f"{WEB_ORIGIN}/login", wait_until="networkidle")
        page.wait_for_timeout(1200)

        google = page.locator('button:has-text("Continue with Google")')
        results.record("the Google button is rendered", google.count() == 1, f"matches={google.count()}")
        results.record(
            "it is disabled until the deployment can verify tokens",
            google.is_disabled(),
            "disabled (no Firebase credentials on this API)",
        )
        body = page.inner_text("body")
        results.record(
            "and it says why instead of failing on click",
            "Google sign-in is not enabled" in body or "Google sign-in unavailable" in body,
            "explanatory note shown",
        )

        # Client-side validation must catch an obvious mistake without a round trip.
        page.fill('input[type="email"]', "not-an-email")
        page.fill('input[type="password"]', "whatever")
        page.click('button[type="submit"]')
        page.wait_for_timeout(400)
        results.record(
            "invalid email is caught in the browser",
            "Enter a valid email address." in page.inner_text("body"),
            "inline error shown",
        )

        # And a real sign-in must still land on the dashboard.
        page.fill('input[type="email"]', ADMIN[0])
        page.fill('input[type="password"]', ADMIN[1])
        page.click('button[type="submit"]')
        page.wait_for_url(lambda url: url.rstrip("/") == WEB_ORIGIN, timeout=20_000)
        page.wait_for_timeout(2500)
        results.record("password sign-in reaches the dashboard", "Workspace overview" in page.inner_text("body"), "dashboard rendered")
        results.record("no console errors on the way", not errors, f"errors={errors[:2]}")
        browser.close()


def browser_google_wiring() -> None:
    """The enabled path, without a real Firebase project.

    The providers response is intercepted so the button becomes live; clicking it must actually load
    the Firebase SDK and surface its failure as a message — not throw, not hang, not reload the page.
    A fake API key makes Firebase reject the request, which is exactly the error path users hit when
    step 4 of docs/FIREBASE-AUTH.md is pasted wrong.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError:
        results.record("google wiring", False, "playwright not installed — skipped")
        return

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        fake = {
            "password": True,
            "selfRegistrationEnabled": False,
            "firebase": {
                "enabled": True,
                "config": {
                    "apiKey": "AIzaSyFAKEKEYFORTESTINGONLY000000000000",
                    "authDomain": "clipforge-fake.firebaseapp.com",
                    "projectId": "clipforge-fake",
                    "appId": "1:1:web:1",
                },
                "allowNewUsers": False,
                "error": None,
            },
        }
        page.route("**/api/auth/providers", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(fake)))
        page.goto(f"{WEB_ORIGIN}/login", wait_until="networkidle")
        page.wait_for_timeout(1000)

        button = page.locator('button:has-text("Continue with Google")')
        results.record("a configured deployment enables the Google button", button.is_enabled(), "enabled with an intercepted providers response")
        button.click()
        page.wait_for_timeout(6000)
        body = page.inner_text("body")
        surfaced = "Google" in body and ("API key" in body or "api key" in body.lower() or "Google sign-in" in body)
        results.record(
            "the SDK loads on demand and its failure is shown in the UI",
            surfaced and "Something went wrong" not in body,
            (body.split("Google")[1][:120] if "Google" in body else "no message").replace("\n", " ").strip(),
        )
        browser.close()


def main() -> int:
    api_contract()
    browser_login()
    browser_google_wiring()
    failed = [item for item in results.items if not item["ok"]]
    print(f"\nchecks: {len(results.items)}, failures: {len(failed)}")
    if failed:
        for item in failed:
            print(f"  FAILED {item['name']}: {item['detail']}")
        return 1
    print("FIREBASE AUTH: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
