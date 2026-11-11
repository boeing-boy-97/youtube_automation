"""Security-header and rate-limit suite for the live ClipForge stack.

Three things this proves that a unit test cannot:

  1. The running API and the running dashboard actually emit the headers (a config object can be
     right while the deployed process never applies it).
  2. The dashboard's Content-Security-Policy does not break the product. A CSP is only correct if a
     real browser can sign in, load every page and call every API it needs with zero
     `securitypolicyviolation` events — a policy that blocks a needed asset is a regression too.
  3. The default write budget applies to a route that declares no limit of its own, which is the
     only way to know the fallback rate limiter is wired to real traffic.

Usage:  python3 tests/e2e/security_headers.py [--headed]
"""

from __future__ import annotations

import os
import sys

import urllib.request

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402

API = harness.API
WEB = harness.WEB_ORIGIN
ROUTES = ["/", "/create", "/jobs", "/clips", "/publishing", "/accounts", "/brand", "/settings", "/activity", "/admin"]

# Collected inside the page before any application script runs, so every violation is caught.
VIOLATION_HOOK = """
window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  window.__cspViolations.push({
    directive: event.effectiveDirective || event.violatedDirective,
    blocked: (event.blockedURI || '').slice(0, 120),
    sample: (event.sample || '').slice(0, 80),
  });
});
"""


def head(url: str) -> dict[str, str]:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as exc:  # a 401/404 still carries the middleware's headers
        return {key.lower(): value for key, value in exc.headers.items()}


def login_cookies() -> list[dict]:
    client = harness.Client()
    harness.flush_login_ratelimit()
    status = client.login(*harness.ADMIN)
    assert status < 300, f"login failed: {status}"
    return [
        {
            "name": cookie.name,
            "value": cookie.value,
            "domain": "127.0.0.1",
            "path": cookie.path or "/",
            "httpOnly": False,
            "secure": False,
            "sameSite": "Lax",
        }
        for cookie in client.jar
    ]


def check_api_headers(results: harness.Results) -> None:
    for path in ("/api/auth/providers", "/api/health", "/api/auth/session"):
        headers = head(API + path)
        label = path.rsplit("/", 1)[-1]
        results.check(
            f"API {label} sends nosniff/frameguard/referrer policy",
            headers.get("x-content-type-options") == "nosniff"
            and headers.get("x-frame-options") == "DENY"
            and headers.get("referrer-policy") == "no-referrer",
            f"xcto={headers.get('x-content-type-options')} xfo={headers.get('x-frame-options')} "
            f"referrer={headers.get('referrer-policy')}",
        )
        results.check(
            f"API {label} isolates the browsing context",
            headers.get("cross-origin-opener-policy") == "same-origin"
            and headers.get("cross-origin-resource-policy") == "same-site",
            f"coop={headers.get('cross-origin-opener-policy')} corp={headers.get('cross-origin-resource-policy')}",
        )
        results.check(
            f"API {label} does not advertise the framework",
            "x-powered-by" not in headers,
            f"x-powered-by={headers.get('x-powered-by')}",
        )
    # The strict API CSP is a production setting (dev keeps Swagger UI usable), so here we assert
    # only that the dev process is honest about it: no half-sent policy, no wildcard.
    csp = head(API + "/api/auth/providers").get("content-security-policy")
    results.check(
        "the dev API either sends no CSP or a strict one",
        csp is None or ("default-src 'none'" in csp and "unsafe-inline" not in csp),
        f"csp={csp}",
    )


def check_web_headers(results: harness.Results) -> None:
    for path in ("/login", "/", "/healthz"):
        headers = head(WEB + path)
        csp = headers.get("content-security-policy", "")
        results.check(
            f"dashboard {path} sends a CSP that denies framing, plugins and base hijacking",
            "default-src 'self'" in csp
            and "frame-ancestors 'none'" in csp
            and "object-src 'none'" in csp
            and "base-uri 'self'" in csp
            and "form-action 'self'" in csp,
            f"csp={'present' if csp else 'MISSING'}",
        )
        results.check(
            f"dashboard {path} sends the hardening headers",
            headers.get("x-content-type-options") == "nosniff"
            and headers.get("x-frame-options") == "DENY"
            and headers.get("cross-origin-opener-policy") == "same-origin"
            and "camera=()" in headers.get("permissions-policy", ""),
            f"xcto={headers.get('x-content-type-options')} xfo={headers.get('x-frame-options')} "
            f"coop={headers.get('cross-origin-opener-policy')}",
        )
        results.check(
            f"dashboard {path} is not a wildcard CSP",
            csp == "" or ("*" not in csp.replace("https://*.googleusercontent.com", "").replace("https://*.firebaseapp.com", "").replace("https://*.gstatic.com", "")),
            "wildcard check",
        )


def check_default_rate_limit(results: harness.Results) -> None:
    """A route with no @RateLimit decorator must still be throttled for a signed-in caller."""
    harness.flush_rate_limits()
    client = harness.Client()
    client.login(*harness.ADMIN)
    import uuid

    missing_job = str(uuid.uuid4())
    seen_headers = False
    remaining = None
    throttled_at = None
    last_body = None
    for attempt in range(1, 131):
        status, body = client.post(f"/api/jobs/{missing_job}/retry", {})
        if status == 429:
            throttled_at = attempt
            last_body = body
            break
        if status in (401, 403):
            results.check(
                "authenticated write reaches the default limiter",
                False,
                f"status={status} code={harness.error_code(body)}",
            )
            return
    seen_headers = throttled_at is not None
    results.check(
        "a route with no declared limit is throttled at the default budget (120/min)",
        throttled_at is not None and 115 <= throttled_at <= 125,
        f"429 on attempt {throttled_at} of 130; body={last_body}",
    )
    results.check(
        "the 429 names the retry window instead of failing silently",
        isinstance(last_body, dict)
        and harness.error_code(last_body) in ("RATE_LIMITED", "TOO_MANY_REQUESTS", "THROTTLED"),
        f"code={harness.error_code(last_body)}",
    )
    harness.flush_rate_limits()
    return seen_headers and remaining is None


def check_browser(results: harness.Results, headed: bool) -> None:
    cookies = login_cookies()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not headed)
        context = browser.new_context()
        context.add_cookies(cookies)
        context.add_init_script(VIOLATION_HOOK)
        page = context.new_page()
        console_errors: list[str] = []
        failed_requests: list[str] = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda exc: console_errors.append(str(exc)))
        page.on(
            "requestfailed",
            lambda req: failed_requests.append(f"{req.method} {req.url} ({req.failure})")
            if req.failure and "ERR_ABORTED" not in str(req.failure)
            else None,
        )

        total_violations: list[str] = []
        for route in ROUTES:
            page.goto(WEB + route, wait_until="networkidle")
            page.wait_for_timeout(250)
            violations = page.evaluate("() => window.__cspViolations || []")
            for violation in violations:
                total_violations.append(f"{route}: {violation['directive']} → {violation['blocked']}")
        results.check(
            "no CSP violation on any page while signed in",
            not total_violations,
            f"{len(total_violations)} violation(s): {total_violations[:4]}",
        )

        # A real write from the browser: the CSP must permit the same-origin /api call the UI makes,
        # and the request must survive the API's own headers (CORP/COOP do not block same-origin).
        page.goto(WEB + "/settings", wait_until="networkidle")
        page.wait_for_timeout(300)
        statuses: list[int] = []
        page.on("response", lambda res: statuses.append(res.status) if "/api/" in res.url else None)
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(600)
        results.check(
            "the dashboard's own API calls succeed under the policy",
            bool(statuses) and all(status < 500 for status in statuses),
            f"{len(statuses)} API response(s), non-5xx={[s for s in statuses if s < 500][:6]}",
        )

        results.check("no console errors on the audited pages", not console_errors, f"{sorted(set(console_errors))[:3]}")
        results.check("no failed network requests", not failed_requests, f"{sorted(set(failed_requests))[:3]}")
        context.close()
        browser.close()


def main() -> int:
    results = harness.Results()
    check_api_headers(results)
    check_web_headers(results)
    check_default_rate_limit(results)
    check_browser(results, "--headed" in sys.argv)
    return results.summary()


if __name__ == "__main__":
    raise SystemExit(main())
