import type { NextConfig } from 'next';

/**
 * The browser only ever talks to this Next.js origin. /api and /media are
 * proxied to the NestJS API, so session cookies stay same-origin (no CORS,
 * no token in localStorage).
 *
 * The proxy target is read when the config is evaluated, i.e. at BUILD time, and baked into the
 * rewrite rules. A dashboard built without it would silently point at 127.0.0.1 and fail in the
 * browser with "connection refused" on every request, so a hosted build refuses to be produced
 * without a real target.
 */
const hosted = Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CI_HOSTED_BUILD);
const configured = process.env.API_INTERNAL_URL?.trim();

/**
 * Accept what people actually paste: a trailing slash, or `…/api`, both of which would otherwise
 * produce `https://host/api/api/…` and 404 every call. Normalised here rather than left to chance.
 */
function normalise(raw: string): string {
  let value = raw.trim().replace(/\/+$/, '');
  if (/\/api$/i.test(value)) value = value.slice(0, -4).replace(/\/+$/, '');
  return value;
}

function fail(reason: string): never {
  throw new Error(
    [
      '',
      '  ── API_INTERNAL_URL is missing or unusable ────────────────────────────────────────────',
      `  ${reason}`,
      '',
      '  The dashboard proxies /api and /media to the API through rewrites, and those rewrites are',
      '  compiled at build time. There is nothing to fall back to: without this value the build',
      '  would ship a frontend that calls 127.0.0.1, which fails in every browser.',
      '',
      '  Fix it in Vercel (takes about a minute):',
      '    1. Open the project → Settings → Environment Variables',
      '    2. Name:  API_INTERNAL_URL',
      '       Value: the public origin of YOUR API, e.g. https://clipforge-api.onrender.com',
      '              (https, no trailing slash, no /api suffix — a wrong suffix is stripped for you)',
      '    3. Tick Production, Preview and Development → Save',
      '    4. Deployments → the newest one → ⋯ → Redeploy  (the value is frozen at build time, so',
      '       editing the variable alone changes nothing)',
      '',
      '  Do you not have the API running yet? Deploy it first — docs/DEPLOY-VERCEL.md §2',
      '  (render.yaml is the blueprint) or docs/DEPLOYMENT.md for a single-server setup.',
      '  Then verify with:  curl https://<your-api-host>/api/system/health',
      '  and after deploying the dashboard:  https://<your-app>.vercel.app/healthz',
      '',
      '  Deploying from the CLI instead?  ./scripts/deploy-vercel.sh https://<your-api-host>',
      '',
      '  Setting a placeholder just to unblock this build is allowed but pointless: the deployed',
      '  dashboard will show "This dashboard cannot reach its API" and /healthz will name the origin',
      '  it failed to reach. It never pretends to work.',
      '  ───────────────────────────────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}

if (hosted) {
  if (!configured) {
    fail('It is not set for this build. A hosted build must be given the API origin explicitly.');
  }
  if (/127\.0\.0\.1|localhost|0\.0\.0\.0/.test(configured)) {
    fail(`It points at "${configured}", which is this container, not a reachable API.`);
  }
  if (!/^https?:\/\//.test(configured)) {
    fail(`"${configured}" is not a URL — it must start with https:// (or http:// for an internal host).`);
  }
}

const target = normalise(configured ?? 'http://127.0.0.1:4000');

if (configured && normalise(configured) !== configured) {
  // Loud, because a silent rewrite makes the value in the Vercel UI disagree with what was built.
  console.warn(`[clipforge] API_INTERNAL_URL "${configured}" was normalised to "${target}" (dropped a trailing slash or /api suffix).`);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${target}/api/:path*` },
      { source: '/media/:path*', destination: `${target}/media/:path*` },
    ];
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
