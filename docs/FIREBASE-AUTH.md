# Connecting Firebase Auth to ClipForge

## What this changes (and what it deliberately does not)

Firebase Authentication is added as a **second way to prove who you are** — Google sign-in next to
the existing email + password login. Everything after that step is unchanged: the API still issues
its own httpOnly session cookie, still checks CSRF, still writes the audit log.

| | Before | After |
| --- | --- | --- |
| Sign in | email + password (argon2id) | email + password **or** Google (Firebase) |
| Session | httpOnly cookie + CSRF token | **same** — Firebase never becomes the session |
| User data | PostgreSQL via Prisma | **same** — two columns added to `User` |
| Account policy | `ALLOW_SELF_REGISTRATION` | unchanged, plus `FIREBASE_ALLOW_NEW_USERS` |

**On "connect the database to Firebase":** this project keeps PostgreSQL as the source of truth.
Firestore is a document store with no joins, no transactions across collections worth the name, and
no way to express what the pipeline actually needs (job state machines, worker leases, the outbox,
the audit log, 20+ tables with foreign keys). Firebase here is the *identity provider* — the thing
it is genuinely best at — and the database stays relational. If you later want Firestore for mobile
realtime dashboards, it can mirror the `User` collection without touching the rest.

## Already have a project? Check where it stands first

Paste the web config into `.env` (it is public — it ships inside every Firebase site, so pasting it
in a chat or a repo is not a leak), then run:

```bash
./scripts/check-firebase.sh
```

It asks Google three questions and prints the one thing left to do. Real output from a project whose
web config was set but whose Authentication had never been initialised:

```
1) Is Firebase Authentication initialised?
   ✗ Firebase Authentication has never been set up in this project.
     Fix: Firebase console → your project → Build → Authentication → Get started …
2) Can the API verify what Google issues? (needs a service account)
   webConfigured=true  verifyConfigured=false  enabled=false
   ✗ the browser is configured, the API cannot verify tokens yet.
```

The `CONFIGURATION_NOT_FOUND` answer that script translates is the single most common surprise:
having a Firebase project, a web app and an API key does **not** mean Authentication is switched on —
that needs one click on **Get started**, and only then does **Google** appear as a provider.

> `firebase/analytics` from the console snippet is deliberately not imported: this app has no
> third-party analytics, and the login page should not phone Google twice to sign you in.

**What the API needs vs what the browser needs**

| Value | Where it comes from | Secret? | Goes in |
| --- | --- | --- | --- |
| `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY`, `FIREBASE_WEB_AUTH_DOMAIN`, `FIREBASE_WEB_APP_ID` | Project settings → General → Your apps | No | `.env` / API env |
| `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Project settings → Service accounts → Generate new private key | **Yes** | `.env` / API env — never in chat, never in git |
| `storageBucket`, `messagingSenderId`, `measurementId` | the console snippet | No | **not used** — this project stores media in R2/S3 |

---

## The process, click by click

You need about 12 minutes and one Google account.

### Step 1 — Create the Firebase project (2 min)

1. Open **https://console.firebase.google.com** and sign in.
2. Click **Create a project** (or **Add project**).
3. Project name: `clipforge` → **Continue**.
4. Google Analytics: **disable it** (you do not need it; nothing in this app uses it) → **Create project**.
5. Wait for "Your new project is ready" → **Continue**.

### Step 2 — Turn on the Google sign-in provider (1 min)

1. Left sidebar → **Build → Authentication** → **Get started**.
2. Tab **Sign-in method** → in the provider list click **Google**.
3. Toggle **Enable** on.
4. **Project public-facing name**: `ClipForge`
5. **Project support email**: your email.
6. **Save**.

> Want email/password handled by Firebase too? Do **not** enable it here. This app already has a
> hardened password path (argon2id, lockout, rate limit); two password systems would fight.

### Step 3 — Authorise your domains (2 min)

Google refuses to run the popup on a domain Firebase does not know.

1. **Authentication → Settings** tab → **Authorized domains**.
2. `localhost` is already listed — that is why it works locally.
3. Click **Add domain** and add, one at a time:
   - `your-app.vercel.app` ← your real Vercel domain, without `https://`
   - `your-app-git-main-yourname.vercel.app` ← if you use preview deployments
   - your custom domain, if any (e.g. `clips.example.com`)

### Step 4 — Copy the browser config (2 min)

1. Gear icon (top left) → **Project settings** → tab **General**.
2. Scroll to **Your apps** → click the **`</>`** (Web) icon.
3. App nickname: `clipforge-web`. **Do not** tick Firebase Hosting.
4. **Register app**.
5. Under **SDK setup and configuration** choose **Config** and copy these four values:

```
apiKey:     AIza...
authDomain: clipforge-xxxxx.firebaseapp.com
projectId:  clipforge-xxxxx
appId:      1:1234567890:web:abcdef123456
```

> These four are **public**. They ship inside every website that uses Firebase and they cannot be
> used to read your database. The API hands them to the login page for you
> (`GET /api/auth/providers`), so **you do not put them in Vercel**.

### Step 5 — Create the service account the API verifies with (2 min)

The browser gets a token; only the server can check that the token is real. That needs a service account.

1. **Project settings** → tab **Service accounts**.
2. Click **Generate new private key** → **Generate key**.
3. A `.json` file downloads. **Treat it like a password** — it can mint tokens for your project.

Open it in a text editor. You need three fields:

```json
{
  "project_id": "clipforge-xxxxx",
  "client_email": "firebase-adminsdk-abc12@clipforge-xxxxx.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
}
```

### Step 6 — Put them in the API's environment (2 min)

Edit `.env` (locally) or the API service's environment on Render. Paste the values **exactly**,
keeping the `\n` sequences inside `private_key` as-is:

```bash
FIREBASE_PROJECT_ID=clipforge-xxxxx
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-abc12@clipforge-xxxxx.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"

# The public browser config from step 4 — served to the login page by the API
FIREBASE_WEB_API_KEY=AIza...
FIREBASE_WEB_AUTH_DOMAIN=clipforge-xxxxx.firebaseapp.com
FIREBASE_WEB_APP_ID=1:1234567890:web:abcdef123456

# Who is allowed in (see step 8)
FIREBASE_ALLOW_NEW_USERS=false
FIREBASE_REQUIRE_VERIFIED_EMAIL=true
```

Prefer one variable over three? Use the whole file instead of its fields:

```bash
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'
```

Two things that break people:

- On Render/Heroku-style paste boxes, multi-line values get mangled. Use the **`\n`-escaped
  single-line** form shown above, not real line breaks.
- Setting **some but not all** of the three service-account fields stops the API at boot with
  `Firebase Auth is half-configured`. That is intentional: a partially configured verifier would
  reject every Google login at runtime instead of telling you now.

### Step 7 — Restart and verify (2 min)

```bash
# local
npm run build -w @clipforge/api && node apps/api/dist/main.js

# check what the API now advertises
curl -s http://127.0.0.1:4000/api/auth/providers
```

Expect `"enabled": true` and a `config` object:

```json
{"password":true,"selfRegistrationEnabled":false,
 "firebase":{"enabled":true,
   "config":{"apiKey":"AIza...","authDomain":"clipforge-xxxxx.firebaseapp.com","projectId":"clipforge-xxxxx","appId":"1:...:web:..."},
   "allowNewUsers":false,"error":null}}
```

Then open `http://127.0.0.1:3000/login`: **Continue with Google** is now enabled, above the email
form. Sign in with the Google account whose address matches an existing ClipForge user — it is
linked to that account and you land on the dashboard.

### Step 8 — Decide who may sign in (1 min)

| Setting | Default | What it means |
| --- | --- | --- |
| `FIREBASE_ALLOW_NEW_USERS` | `false` | A valid Google account that ClipForge has never seen is **refused**. Set `true` if you want Google sign-up to create the user and their own workspace. |
| `FIREBASE_REQUIRE_VERIFIED_EMAIL` | `true` | Refuses a token whose email the provider has not verified. Leave it on. |

The safe path for an existing deployment: keep both defaults, and link your own account by signing in
with Google using the same email as your existing ClipForge user. New teammates get an account from
an administrator (or flip `FIREBASE_ALLOW_NEW_USERS=true`).

### Step 9 — Hosted deployment

| Where | What to add |
| --- | --- |
| **API** (Render) | the six `FIREBASE_*` values from step 6, then redeploy |
| **Vercel** | **nothing** — the dashboard asks the API for the public config at runtime |
| **Firebase** | step 3 domains must include the Vercel domain |

Then check `https://<your-app>.vercel.app/login`: the Google button is live, and
`curl -s https://<api-host>/api/auth/providers` returns `"enabled": true`.

---

## How the sign-in actually flows

```
Browser                        Vercel (Next.js)                API (NestJS)              Firebase
  │ click "Continue with Google"      │                            │                       │
  ├──────────── popup (firebase js sdk, loaded on demand) ───────────────────────────────►│
  │◄──────────────────── ID token (JWT, ~1 h) ────────────────────────────────────────────┤
  ├── POST /api/auth/firebase {idToken} ──►│ ── rewrite ──►  verify with service account ──►│
  │                                        │                 link/provision the User row  │
  │◄────────── Set-Cookie: cf_session (httpOnly) + csrfToken ─┤                            │
  │  Firebase session is signed out; the cookie is the session │                           │
```

What that buys you:

- **No token in localStorage.** The ID token lives for one request; the session is an httpOnly
  cookie the browser cannot read, so XSS cannot steal it.
- **Revocation works immediately.** `verifyIdToken(token, true)` checks revocation, so disabling a
  user in the Firebase console locks them out on their next request.
- **One source of truth.** Two parallel "logged in" states (Firebase + cookie) is how apps end up
  with a user who is signed out in one tab and in on another.
- **Everything is audited.** `AUTH_LOGIN` rows record `Login via google.com from <ip>`.

### Account-linking rules (enforced in `AuthService.resolveFirebaseUser`)

| Situation | Result |
| --- | --- |
| Google email matches an existing user, no Firebase link yet | link it; the password keeps working |
| Same Firebase UID signs in again | same user, no duplicate |
| A *different* Google account claims an already-linked email | refused |
| Account is `SUSPENDED` or deleted | refused, before any session exists |
| Unverified email and `FIREBASE_REQUIRE_VERIFIED_EMAIL=true` | refused (`EMAIL_NOT_VERIFIED`) |
| Unknown email, `FIREBASE_ALLOW_NEW_USERS=false` | refused with a message naming the setting |
| Identity with no email claim | refused |

---

## Troubleshooting

| What you see | Cause | Fix |
| --- | --- | --- |
| Button greyed out, "Google sign-in is not enabled on this deployment" | the API has no `FIREBASE_*` service account, or `enabled:false` | step 6, then restart the API |
| `Google sign-in unavailable: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON` | the JSON blob was pasted with line breaks | use the escaped single-line form |
| `auth/unauthorized-domain` | the domain is not in Firebase's authorized list | step 3 — add the exact host, no `https://` |
| Popup opens then closes with nothing | popup blocked, or the app was closed | allow pop-ups for the site; the message says which |
| `error:0909006C:PEM routines::no start line` in the API log | `FIREBASE_PRIVATE_KEY` lost its `\n` escapes | re-paste with the escapes intact, or use the JSON blob |
| `No ClipForge account uses this Google address` | `FIREBASE_ALLOW_NEW_USERS=false` and no such user | sign in with the email of an existing account, or set it to `true` |
| `This email is already linked to a different Google account` | the row is linked to another UID | sign in with the original Google account, or unlink it in SQL (see below) |
| Sign-in succeeds, then every save returns `403 CSRF_FAILED` | `APP_URL` / `ALLOWED_ORIGINS` on the API do not match the dashboard origin | fix both, restart the API |
| `{"code":"FIREBASE_NOT_CONFIGURED"}` from `POST /api/auth/firebase` | expected on a password-only deployment | see step 6 |

Unlinking one account (rare, deliberate):

```sql
UPDATE "User" SET "firebaseUid" = NULL WHERE email = 'person@example.com';
```

## Rolling back

Set `FIREBASE_ALLOW_NEW_USERS=false`, remove the `FIREBASE_*` variables and restart the API. The
Google button disappears, password login is untouched, and the two nullable columns
(`firebaseUid`, `avatarUrl`) stay harmlessly in place. Drop them with a migration only if you are
sure you will never turn Google back on.

## Verification in this repo

```bash
npm run test:unit            # includes tests/unit/firebase-config.test.ts
npm run test:integration     # includes tests/integration/firebase-auth.test.ts (real DB, 8 cases)
python3 tests/e2e/firebase_auth.py   # live API + browser: providers contract, refusal, UI state
```
