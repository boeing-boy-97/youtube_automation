# Account security — second factor, recovery, devices

Everything described here is implemented in `apps/api/src/auth/` and `apps/web/app/security`, and is
covered by unit, integration and live end-to-end tests (see *Verification* at the bottom).

## The three sign-in postures

| `User.otpMode` | What a sign-in needs | Who it is for |
|---|---|---|
| `OFF` (default) | password only | existing accounts; nothing changes until a user opts in |
| `EMAIL` | password + a six-digit code by email | anyone with SMTP configured |
| `TELEGRAM` | password + a code in the linked Telegram chat | users who linked a chat |
| `DUAL` | password + **both** codes | accounts that want a stolen password to be useless |

A policy can only be enabled when the channel can actually deliver. `PUT /api/auth/security/otp-mode`
answers `400 CHANNEL_UNAVAILABLE` with the reason (no SMTP, or no linked chat) instead of accepting a
setting that would lock the account out of itself.

## Code rules (they are the feature)

* six digits from `crypto.randomInt(0, 1_000_000)` — uniform, no modulo bias, not `Math.random()`
* five-minute TTL (`OTP_TTL_SECONDS`), checked against the database
* five attempts (`OTP_MAX_ATTEMPTS`); every wrong attempt increments **before** returning, so a crash
  cannot refund attempts
* sixty-second resend cooldown (`OTP_RESEND_COOLDOWN_SECONDS`) per challenge
* single use: `consumedAt` is set with a conditional `updateMany`, so a replay cannot win a race
* stored as HMAC-SHA256 over `<challengeId>:<code>` keyed by `OTP_SECRET` (falling back to
  `SESSION_SECRET`); the challenge id salts it, so identical codes have different hashes
* the code is never logged, never returned by the API, and never stored in plaintext

`POST /api/auth/login` returns `{ otpRequired: true, mode, challenges[], resendAfterSeconds,
deliveryProblem }` and **sets no cookie**. The session is created only by
`POST /api/auth/security/otp/step-up/complete` after every required channel verifies.

`deliveryProblem` is the honest half of the feature: if SMTP is down or Telegram rejected the chat, the
response says which channel failed and why, rather than showing a code form that can never succeed.

## Password recovery

`POST /api/auth/security/forgot-password` answers `{ "requested": true }` for every address, whether or
not the account exists — the response body is byte-identical, so the endpoint is not an enumeration
oracle and does not leak the challenge id.

`POST /api/auth/security/reset-password` takes `{ email, code, newPassword }`. On success the password
changes, **every session is revoked** (including an attacker's already-open one), and an
`AUTH_PASSWORD_RESET` audit row is written.

## Recovery codes

Ten single-use codes (`XXXXX-XXXXX`), shown once, stored as SHA-256 hashes. Generating a new set
deletes the previous unused set, so the number of live codes is always exactly ten or zero.
`POST /api/auth/security/recovery-codes/redeem` takes `{ email, code, newPassword }`, consumes the code,
resets the password and revokes all sessions. `GET /api/auth/security/recovery-codes` reports how many
remain — useful as a "you are one lost phone away from a locked account" warning.

## Devices and sign-in history

`GET /api/auth/security/sessions` lists active sessions with a human device label
(`Chrome on Linux`, `Python client`, …), the IP, first seen, last seen, expiry, and which one is
current. `DELETE /api/auth/security/sessions/:id` revokes one;
`POST /api/auth/security/sessions/revoke-all` signs out everywhere (optionally keeping the current
device).

`GET /api/auth/security/login-history` returns the last 20 attempts: `SUCCESS`, `FAILED_PASSWORD`,
`OTP_CHALLENGE`, `OTP_FAILED`, `BLOCKED`, with method, device, IP and whether it was flagged as
suspicious.

**Suspicious sign-in:** a success is flagged when the IP *and* the device label are both unseen in the
last 30 days of successes. The first ever sign-in is never flagged (everything would be new). Flags
raise a `SECURITY_ALERT` notification through the same Telegram pipeline as every other event — no
second delivery path to drift.

## Telegram linking

1. `POST /api/auth/security/telegram/link/start { chatId }` sends a six-digit code to that chat. If the
   bot cannot message the chat, the error is returned (`400 OTP_DELIVERY_FAILED`) rather than a silent
   "linking…" state.
2. `POST /api/auth/security/telegram/link/complete { challengeId, code, chatId }` stores the chat id.

`POST /api/auth/security/telegram/unlink` forgets the chat and **downgrades** the policy
(`DUAL → EMAIL`, `TELEGRAM → OFF`) instead of leaving the account with a factor that has nowhere to go.
Only the masked chat id (`-••••7890`) is ever returned to the browser.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SMTP_HOST` | — | relay host; unset ⇒ email channel reports unavailable |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (465) |
| `SMTP_USER`, `SMTP_PASS` | — | optional auth |
| `SMTP_FROM` | — | required with `SMTP_HOST`; e.g. `ClipForge <no-reply@example.com>` |
| `OTP_TTL_SECONDS` | `300` | code lifetime |
| `OTP_RESEND_COOLDOWN_SECONDS` | `60` | |
| `OTP_MAX_ATTEMPTS` | `5` | |
| `OTP_SECRET` | falls back to `SESSION_SECRET` | key for code hashing |

No secret is ever sent to the browser: `/overview` reports `channels.email` as a boolean, and the
diagnostics page reports `configured` plus the host name only.

## Verification

```
npm run test:unit                                  # 97 (17 new: code format, hashing, masking, SMTP config, device labels)
npm run test:integration                           # 41
.venv/bin/python tests/e2e/authorization_matrix.py # 27
.venv/bin/python tests/e2e/telegram_notifications.py # 36
bash tests/e2e/run_auth_security.sh                # 46 — real SMTP sink, real codes, real cookies
```

`run_auth_security.sh` starts `tests/e2e/smtp_sink.py` (a real SMTP server on port 1025), restarts the
API with `SMTP_HOST=127.0.0.1`, and drives the whole flow: policy refusal for an unavailable channel,
password-only login still working, step-up with a wrong code (`attemptsRemaining` decrements), the
right code opening a session, replay rejected, resend cooldown, history rows, hashed storage, session
revocation, password reset revoking sessions, recovery-code redemption (and reuse failing), and a
Telegram link to an unknown chat failing loudly. It restores `otpMode = OFF` for the admin account in a
`finally` block, so a failed run cannot leave the next suite locked out.

The browser flow was also driven with Playwright (real SMTP, code typed by hand into the form):
`artifacts/ui/login-step-up.png` and `artifacts/ui/security-page.png`.

## Known limitations

* **No invite/member management.** With self-registration closed by default there is no API to add a
  second user; the RBAC fixture in the E2E suite is inserted with SQL (`ensure_member`). This is the
  largest remaining auth gap and is listed in the upgrade plan.
* **No passkeys/WebAuthn.** TOTP apps are also unsupported — the factor is email/Telegram codes only.
* **Telegram linking needs a human** the first time: the bot cannot message a chat that has never
  contacted it, so the user must send the bot `/start` before linking. The E2E suite therefore proves
  the *failure* path for an unknown chat; the success path is covered by the delivery code shared with
  the notification tests.
* **Suspicious-login detection is heuristic** (new IP + new device) and deliberately quiet: it will not
  catch a travelling attacker who keeps the same device fingerprint.
