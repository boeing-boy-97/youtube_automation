"""Browser-level UI audit for the ClipForge dashboard.

Runs the real Next.js build in headless Chromium against the real API at five viewports
(phone → desktop) and asserts the things a static review cannot: no horizontal page overflow,
the mobile drawer/bottom bar actually work, controls are big enough to tap, every control has an
accessible name, and no page logs a console error.

Usage:  python3 tests/e2e/ui_responsive.py [--screens]
"""

from __future__ import annotations

import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402

WEB = os.environ.get("CLIPFORGE_WEB_ORIGIN", "http://127.0.0.1:3000")
ARTIFACTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "artifacts", "ui")

VIEWPORTS = [
    ("phone-360", 360, 740),
    ("phone-390", 390, 844),
    ("tablet-768", 768, 1024),
    ("laptop-1024", 1024, 768),
    ("desktop-1440", 1440, 900),
]

ROUTES = ["/", "/create", "/jobs", "/clips", "/publishing", "/accounts", "/brand", "/settings", "/activity", "/admin"]

OVERFLOW_PROBE = """() => {
  // Ground truth: can the user actually scroll the page sideways? `scrollWidth` also counts
  // content that an inner `overflow-x-auto` container legitimately scrolls on its own.
  const before = window.scrollX;
  window.scrollTo(2000, window.scrollY);
  const scrolled = window.scrollX;
  window.scrollTo(before, window.scrollY);
  let worst = null;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= window.innerWidth + 1) continue;
    let clipped = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) { clipped = true; break; }
    }
    if (clipped) continue;
    if (!worst || r.right > worst.right) {
      worst = { right: Math.round(r.right), tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 70) };
    }
  }
  return { overflow: Math.round(scrolled), worst };
}"""

A11Y_PROBE = """() => {
  const problems = [];
  const name = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim() ||
      (el.getAttribute('alt') || '')).slice(0, 40);
  for (const el of document.querySelectorAll('button, a[href]')) {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (!name(el)) problems.push(`unnamed ${el.tagName.toLowerCase()} (${Math.round(r.width)}x${Math.round(r.height)})`);
    if (r.height < 24 || r.width < 24) problems.push(`small target ${name(el) || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  for (const el of document.querySelectorAll('img')) {
    if (!el.hasAttribute('alt')) problems.push(`img without alt: ${(el.getAttribute('src') || '').slice(0, 40)}`);
  }
  for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
    const id = el.getAttribute('id');
    const labelled =
      (id && document.querySelector(`label[for="${id}"]`)) ||
      el.closest('label') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('aria-labelledby');
    if (!labelled) problems.push(`unlabelled field: ${id || el.getAttribute('name') || el.tagName}`);
  }
  const h1 = document.querySelectorAll('h1').length;
  if (h1 === 0) problems.push('no h1 on page');
  if (h1 > 1) problems.push(`${h1} h1 elements`);
  return problems;
}"""


def login_cookies() -> list[dict]:
    client = harness.Client()
    harness.flush_login_ratelimit()
    status = client.login(*harness.ADMIN)
    assert status < 300, f"login failed: {status}"
    cookies = []
    for cookie in client.jar:  # type: ignore[attr-defined]
        cookies.append(
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": "127.0.0.1",
                "path": cookie.path or "/",
                "httpOnly": False,
                "secure": False,
                "sameSite": "Lax",
            }
        )
    return cookies


def main() -> int:
    screens = "--screens" in sys.argv
    cookies = login_cookies()
    failures: list[str] = []
    checks = 0
    console_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for label, width, height in VIEWPORTS:
            context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
            context.add_cookies(cookies)
            page = context.new_page()
            page.on("console", lambda msg: console_errors.append(f"{msg.type}: {msg.text}") if msg.type == "error" else None)
            page.on("pageerror", lambda exc: console_errors.append(f"pageerror: {exc}"))
            mobile = width < 1024

            for route in ROUTES:
                page.goto(WEB + route, wait_until="networkidle")
                page.wait_for_timeout(120)

                # 1. no horizontal overflow of the page itself
                probe = page.evaluate(OVERFLOW_PROBE)
                checks += 1
                if probe["overflow"] > 1:
                    failures.append(f"[{label} {route}] page overflows by {probe['overflow']}px: {probe['worst']}")

                # 2. navigation shape matches the viewport
                checks += 1
                sidebar = page.locator("aside nav").first
                sidebar_visible = sidebar.is_visible() if sidebar.count() else False
                bottom = page.locator('nav[aria-label="Quick navigation"]')
                bottom_visible = bottom.count() > 0 and bottom.first.is_visible()
                burger = page.locator('button[aria-label="Open navigation"]')
                burger_visible = burger.count() > 0 and burger.first.is_visible()
                if mobile and (sidebar_visible or not bottom_visible or not burger_visible):
                    failures.append(f"[{label} {route}] mobile nav wrong: sidebar={sidebar_visible} bottom={bottom_visible} burger={burger_visible}")
                if not mobile and (not sidebar_visible or bottom_visible or burger_visible):
                    failures.append(f"[{label} {route}] desktop nav wrong: sidebar={sidebar_visible} bottom={bottom_visible} burger={burger_visible}")

                # 3. accessibility basics
                problems = page.evaluate(A11Y_PROBE)
                checks += 1
                if problems:
                    failures.append(f"[{label} {route}] a11y: {'; '.join(problems[:4])}")

                if screens and route in ("/", "/jobs", "/create"):
                    os.makedirs(ARTIFACTS, exist_ok=True)
                    page.screenshot(path=os.path.join(ARTIFACTS, f"{label}{route.replace('/', '_') or '_root'}.png"), full_page=False)

            # 4. the drawer opens, traps, closes on Escape, and navigates
            if mobile:
                page.goto(WEB + "/", wait_until="networkidle")
                page.locator('button[aria-label="Open navigation"]').first.click()
                dialog = page.locator('[role="dialog"][aria-label="Navigation"]')
                page.wait_for_timeout(350)  # let the slide-in finish before measuring/screenshotting
                checks += 1
                if not dialog.is_visible():
                    failures.append(f"[{label}] drawer did not open")
                else:
                    checks += 1
                    if page.evaluate("() => document.body.style.overflow") != "hidden":
                        failures.append(f"[{label}] drawer did not lock background scroll")
                    if screens:
                        page.screenshot(path=os.path.join(ARTIFACTS, f"{label}_drawer.png"))
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(250)
                    checks += 1
                    if dialog.count() and dialog.is_visible():
                        failures.append(f"[{label}] Escape did not close the drawer")
                    page.locator('button[aria-label="Open navigation"]').first.click()
                    page.locator('[role="dialog"] a[href="/clips"]').first.click()
                    page.wait_for_url("**/clips", timeout=10000)
                    checks += 1
                    if dialog.count() and dialog.is_visible():
                        failures.append(f"[{label}] drawer stayed open after navigation")
                    # scroll lock must be released after closing
                    checks += 1
                    if page.evaluate("() => document.body.style.overflow") == "hidden":
                        failures.append(f"[{label}] background scroll stayed locked after the drawer closed")

            context.close()
        browser.close()

    if console_errors:
        unique = sorted(set(console_errors))
        failures.append(f"console errors: {len(unique)} — " + " | ".join(unique[:5]))

    print(f"checks: {checks}, failures: {len(failures)}")
    for line in failures:
        print("  FAIL " + line)
    status = 0 if not failures else 1
    print("UI RESPONSIVE:", "OK" if status == 0 else "FAILED")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
