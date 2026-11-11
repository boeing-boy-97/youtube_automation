import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The browser only ever talks to this Next.js origin. /api and /media are proxied to the NestJS
 * API through rewrites, so session cookies stay same-origin (no CORS, no token in localStorage).
 *
 * Rewrites are compiled at BUILD time, so the API origin is a build input, not a runtime setting.
 * It is resolved from, in order:
 *
 *   1. process.env.API_INTERNAL_URL            (Vercel → Settings → Environment Variables)
 *   2. ./api-target.json  { "apiOrigin": … }   (commit the origin; Vercel rebuilds on push)
 *   3. http://127.0.0.1:4000                   (local development)
 *
 * A hosted build that has neither (1) nor (2) no longer fails: it is built against a sentinel host
 * that cannot resolve, so the deployment succeeds, every request fails visibly, the dashboard shows
 * "This dashboard cannot reach its API" and /healthz names the missing setting. A failing build only
 * ever blocked people who had not yet stood up an API; a deployment that explains itself does not.
 */
const hosted = Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CI_HOSTED_BUILD);
const SENTINEL = 'https://api-not-configured.invalid';
const LOCAL_DEFAULT = 'http://127.0.0.1:4000';

function fromFile(): { origin: string | null; note: string | null } {
  try {
    const file = path.join(process.cwd(), 'api-target.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { apiOrigin?: unknown };
    const value = typeof parsed.apiOrigin === 'string' ? parsed.apiOrigin.trim() : '';
    return { origin: value.length > 0 ? value : null, note: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { origin: null, note: null };
    return { origin: null, note: `api-target.json could not be read (${(error as Error).message}).` };
  }
}

/** Accept what people actually paste: a trailing slash, or `…/api` (which would give /api/api/…). */
function normalise(raw: string): string {
  let value = raw.trim().replace(/\/+$/, '');
  if (/\/api$/i.test(value)) value = value.slice(0, -4).replace(/\/+$/, '');
  return value;
}

function warn(lines: string[]): void {
  console.warn(['', '  ⚠  ClipForge deployment notice', ...lines.map((line) => `     ${line}`), ''].join('\n'));
}

const fromEnv = process.env.API_INTERNAL_URL?.trim();
// Local builds always talk to the local API; the committed origin is a deployment setting.
const fromJson = fromEnv || !hosted ? { origin: null, note: null } : fromFile();

let target: string;
let problem: string | null = null;

const isLocalAddress = (value: string) => /127\.0\.0\.1|localhost|0\.0\.0\.0/.test(value);

if (fromEnv) {
  target = normalise(fromEnv);
  if (!/^https?:\/\//.test(target)) {
    problem = `API_INTERNAL_URL is "${fromEnv}", which is not a URL.`;
    target = SENTINEL;
  } else if (hosted && isLocalAddress(target)) {
    // Only a *hosted* build is wrong to point at localhost; a local build is supposed to.
    problem = `API_INTERNAL_URL points at "${fromEnv}", which is the build container, not a reachable API.`;
    target = SENTINEL;
  } else if (target !== fromEnv) {
    warn([`API_INTERNAL_URL "${fromEnv}" was normalised to "${target}" (trailing slash or /api suffix dropped).`]);
  }
} else if (fromJson.origin) {
  target = normalise(fromJson.origin);
  if (!/^https?:\/\//.test(target) || (hosted && isLocalAddress(target))) {
    problem = `api-target.json holds "${fromJson.origin}", which is not a public http(s) origin.`;
    target = SENTINEL;
  } else if (fromJson.note) {
    warn([fromJson.note]);
  } else {
    warn([`Using the API origin committed in apps/web/api-target.json: ${target}`]);
  }
} else {
  target = hosted ? SENTINEL : LOCAL_DEFAULT;
  if (hosted) {
    problem = 'Neither API_INTERNAL_URL nor apps/web/api-target.json gave an API origin.';
  }
}

if (problem) {
  warn([
    `No usable API origin for this build: ${problem}`,
    '',
    `The build will succeed, pointing at ${SENTINEL}, so /api and /media fail fast instead of`,
    'silently calling 127.0.0.1. Sign-in cannot work until this is set.',
    '',
    'Fix it one of two ways, then redeploy (the origin is frozen into the rewrites at build time):',
    '  A. Vercel → Settings → Environment Variables → API_INTERNAL_URL = https://your-api-host',
    '  B. Edit apps/web/api-target.json in GitHub: { "apiOrigin": "https://your-api-host" }',
    '',
    'Check the result at https://<your-app>.vercel.app/healthz — it names the origin it uses.',
  ]);
}

/**
 * Security headers are set by Next itself, not only by `vercel.json`, so a self-hosted or
 * `next start` deployment gets the same protection as the Vercel one.
 *
 * The CSP is deliberately explicit rather than "default-src 'self'" plus hope:
 *
 *  - `script-src 'unsafe-inline'` is required because Next streams its hydration payload as inline
 *    scripts without a nonce. Moving to a nonce (middleware-generated) would remove it and is the
 *    documented follow-up; until then the policy still blocks every *external* script origin, eval,
 *    framing, base-uri hijacking and form hijacking.
 *  - Firebase/Google entries exist because "Continue with Google" loads the Firebase auth iframe and
 *    calls identitytoolkit; without them the button would fail under the policy.
 *  - `media-src 'self' blob:` covers the clip player; `img-src … data: blob:` covers inline SVG and
 *    generated posters.
 */
const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  // dev needs eval for React Fast Refresh; production must not have it.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} https://apis.google.com https://www.gstatic.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.googleusercontent.com https://www.gstatic.com",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
  "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ['upgrade-insecure-requests']),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // Only sent over TLS; ignored on http, so it is safe to add unconditionally.
  { key: 'Strict-Transport-Security', value: 'max-age=15552000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Inlined at build time so /healthz can report what this deployment was actually compiled with,
  // even when the environment variable is absent at runtime.
  env: { CLIPFORGE_API_TARGET: target },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${target}/api/:path*` },
      { source: '/media/:path*', destination: `${target}/media/:path*` },
    ];
  },
  // Lint is part of the build again: a rule that catches a real bug must be able to fail a deploy.
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

export default nextConfig;
