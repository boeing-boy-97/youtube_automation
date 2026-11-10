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

/**
 * Did the host that answered actually answer as ClipForge? A wrong-but-live origin is the worst
 * case: `fetch` succeeds, so every check looks "up", while every route 404s. The API's health body
 * carries a `checks` array; nobody else's does.
 */
function looksLikeClipForge(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const checks = (body as { checks?: unknown }).checks;
  return Array.isArray(checks) && checks.some((c) => typeof c === 'object' && c !== null && 'component' in c);
}

export async function GET() {
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  let identity: 'clipforge' | 'other' | 'unknown' = 'unknown';
  try {
    const response = await fetch(`${TARGET}/api/system/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    status = response.status;
    if (response.ok) {
      identity = looksLikeClipForge(await response.json().catch(() => null)) ? 'clipforge' : 'other';
    } else if (response.status === 404) {
      // Something is listening there, it just does not serve this API's routes.
      identity = 'other';
    }
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
      identity,
      region: process.env.VERCEL_REGION ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      hint: ok
        ? 'The dashboard proxy reaches the API.'
        : NOT_CONFIGURED
          ? 'No API origin was configured for this build. Set API_INTERNAL_URL in Vercel (or apiOrigin in apps/web/api-target.json) and redeploy — rewrites are baked at build time.'
          : identity === 'other'
            ? `That host answered ${status} — it is not your ClipForge API. Render names are global, so a taken name gets a suffix (clipforge-api-xxxx.onrender.com): copy the URL from your Render service page and use exactly that.`
            : error
              ? `The API origin did not answer (${error}). A free Render instance sleeps after 15 min and needs ~30 s to wake — otherwise the URL is wrong.`
              : `The API answered ${status} but is not healthy. Open ${TARGET}/api/system/health for its own report.`,
    },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
