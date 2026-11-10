'use client';

import { useState } from 'react';
import { Card } from './ui';

/**
 * Shown when `/api/auth/session` could not be answered at all — the API origin baked into the
 * rewrite is down, wrong, or blocked. On a fresh Vercel deployment this is the most likely first
 * screen, so it names the three settings that cause it instead of a spinner.
 */
export function BackendDown({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  const runSelfCheck = async () => {
    setChecking(true);
    setReport(null);
    try {
      const response = await fetch('/healthz', { cache: 'no-store' });
      const body = (await response.json()) as {
        ok?: boolean;
        apiTarget?: string | null;
        upstream?: { status: number | null; latencyMs: number | null; error?: string | null };
      };
      const upstream = body.upstream ?? { status: null, latencyMs: null };
      setReport(
        body.ok
          ? `API origin ${body.apiTarget} answered ${upstream.status} in ${upstream.latencyMs} ms. The proxy works — try signing in again.`
          : `API origin ${body.apiTarget ?? '(not set)'} failed${upstream.error ? `: ${upstream.error}` : ` with status ${upstream.status ?? 'none'}`}.`,
      );
    } catch (error) {
      setReport(`Self-check could not run: ${(error as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="grid min-h-[100dvh] place-items-center bg-surface-muted px-4 py-10">
      <div className="w-full max-w-[620px] space-y-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink text-sm font-bold text-white">CF</span>
          <div>
            <p className="text-sm font-semibold text-ink">ClipForge AI</p>
            <p className="text-[11px] text-ink-faint">Dashboard</p>
          </div>
        </div>

        <Card className="px-5 py-5">
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">This dashboard cannot reach its API</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
            The page loaded, so the Vercel deployment is fine — but every request is proxied to the API
            origin that was baked into the build. That origin did not answer.
          </p>

          <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 text-xs text-ink-soft">{message}</pre>

          <div className="mt-4 space-y-2 text-[13px] text-ink-soft">
            <p className="font-medium text-ink">Check, in this order</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                The API is running and <code className="rounded bg-surface-sunken px-1">GET /api/system/health</code> returns
                200 on its own public URL.
              </li>
              <li>
                <code className="rounded bg-surface-sunken px-1">API_INTERNAL_URL</code> in Vercel is that exact origin
                (https, no trailing slash, no <code className="rounded bg-surface-sunken px-1">/api</code> suffix) — it is read at
                build time, so change it and <strong>redeploy</strong>.
              </li>
              <li>
                On the API, <code className="rounded bg-surface-sunken px-1">ALLOWED_ORIGINS</code> contains this dashboard&apos;s
                domain and <code className="rounded bg-surface-sunken px-1">APP_URL</code> matches it.
              </li>
            </ol>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={runSelfCheck} disabled={checking}>
              {checking ? 'Checking…' : 'Run self-check'}
            </button>
            {onRetry ? (
              <button type="button" className="btn-primary" onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </div>

          {report ? <p className="mt-3 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-ink-soft">{report}</p> : null}
        </Card>

        <p className="text-center text-xs text-ink-faint">
          Deploying: <code>docs/DEPLOY-VERCEL.md</code> · the self-check endpoint is{' '}
          <code>/healthz</code>
        </p>
      </div>
    </div>
  );
}
