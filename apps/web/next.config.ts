import type { NextConfig } from 'next';

/**
 * The browser only ever talks to this Next.js origin. /api and /media are
 * proxied to the NestJS API, so session cookies stay same-origin (no CORS,
 * no token in localStorage).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    const target = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    return [
      { source: '/api/:path*', destination: `${target}/api/:path*` },
      { source: '/media/:path*', destination: `${target}/media/:path*` },
    ];
  },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
