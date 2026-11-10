'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, StatusBadge } from './ui';

interface DeployProbe {
  ok: boolean;
  apiTarget: string | null;
  upstream: { status: number | null; latencyMs: number | null; error: string | null };
  region: string | null;
  commit: string | null;
  hint: string;
}

/**
 * The one link that is easy to break on Vercel: the dashboard's build-time API origin. Everything
 * else on /admin is served *by* the API, so it can only be trusted once this probe is green.
 */
export function DeployCheck() {
  const probe = useQuery({
    queryKey: ['deploy-check'],
    queryFn: async () => {
      const response = await fetch('/healthz', { cache: 'no-store' });
      return (await response.json()) as DeployProbe;
    },
    refetchInterval: 30_000,
    retry: false,
  });

  const data = probe.data;
  return (
    <Card>
      <CardHeader
        title="Dashboard → API link"
        description="What this deployment was built against, probed live every 30 seconds"
        action={<StatusBadge value={probe.isLoading ? 'CHECKING' : data?.ok ? 'CONNECTED' : 'FAILED'} />}
      />
      {probe.error ? (
        <p className="px-5 py-4 text-[13px] text-danger">Self-check failed: {(probe.error as Error).message}</p>
      ) : (
        <dl className="divide-y divide-line">
          {[
            ['API origin baked at build time', data?.apiTarget ?? '—'],
            ['Upstream status', data ? `${data.upstream.status ?? 'no response'}${data.upstream.latencyMs !== null ? ` · ${data.upstream.latencyMs} ms` : ''}` : '—'],
            ['Upstream error', data?.upstream.error ?? 'none'],
            ['Vercel region', data?.region ?? 'local build'],
            ['Commit', data?.commit ?? 'local build'],
          ].map(([label, value]) => (
            <div key={label} className="flex items-start justify-between gap-4 px-5 py-2.5">
              <dt className="text-[13px] text-ink-soft">{label}</dt>
              <dd className="max-w-[60%] break-all text-right font-mono text-xs text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="border-t border-line px-5 py-3 text-xs text-ink-faint">{data?.hint ?? 'Probing the API origin…'}</p>
    </Card>
  );
}
