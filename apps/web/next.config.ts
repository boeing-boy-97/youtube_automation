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
const target = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

if (hosted && (!process.env.API_INTERNAL_URL || /127\.0\.0\.1|localhost/.test(process.env.API_INTERNAL_URL))) {
  throw new Error(
    'API_INTERNAL_URL must be set to the public API origin (e.g. https://clipforge-api.onrender.com) ' +
      'when building for a hosted dashboard. It is baked into the /api and /media rewrites.',
  );
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
