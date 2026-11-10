import { NextResponse } from 'next/server';

/**
 * Deployment self-check for the dashboard.
 *
 * `/api/*` and `/media/*` are rewrites to the API origin baked in at build time, so the single most
 * common failure after a deploy is "the frontend is live, the proxy points somewhere wrong". This
 * endpoint reports what the build was pointed at and probes it live, which makes the diagnosis one
 * URL instead of a browser console.
 *
 * It deliberately reports only the origin and a status — never a cookie, a token or a body.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Inlined by next.config at build time, so this is what the rewrites were compiled with — the
// environment variable itself need not exist at runtime.
const TARGET = (process.env.CLIPFORGE_API_TARGET ?? process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const NOT_CONFIGURED = TARGET.includes('api-not-configured.invalid');

export async function GET() {
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(`${TARGET}/api/system/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    status = response.status;
  } catch (cause) {
    error = (cause as Error)?.name === 'TimeoutError' ? 'Timed out after 5s' : (cause as Error)?.message ?? 'Request failed';
  }
  const latencyMs = Date.now() - started;
  const ok = status !== null && status >= 200 && status < 300;

  return NextResponse.json(
    {
      ok,
      service: 'clipforge-dashboard',
      apiTarget: TARGET || null,
      origin: new URL(TARGET || 'http://invalid').origin,
      upstream: { status, latencyMs, error },
      region: process.env.VERCEL_REGION ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      hint: ok
        ? 'The dashboard proxy reaches the API.'
        : NOT_CONFIGURED
          ? 'No API origin was configured for this build. Set API_INTERNAL_URL in Vercel (or apiOrigin in apps/web/api-target.json) and redeploy — rewrites are baked at build time.'
          : 'Set API_INTERNAL_URL to the public API origin (https, no /api suffix) and redeploy — the rewrites are baked at build time.',
    },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
