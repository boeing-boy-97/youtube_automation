'use client';

import Link from 'next/link';
import { Card, CardHeader, EmptyState, ErrorState, ProgressBar, Section, Skeleton, StatCard, StatusBadge } from '@/components/ui';
import { useDashboard, useSession, useSystemOverview } from '@/lib/hooks';
import { formatDuration, formatRelative } from '@/lib/api';

export default function DashboardPage() {
  const dashboard = useDashboard();
  const session = useSession();
  const isOperator = ['OWNER', 'ADMIN'].includes(session.data?.user?.role ?? '');
  const system = useSystemOverview(isOperator);

  if (dashboard.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index}>
            <Skeleton rows={2} />
          </Card>
        ))}
      </div>
    );
  }
  if (dashboard.error) {
    return <ErrorState message={dashboard.error.message} onRetry={() => void dashboard.refetch()} />;
  }
  const data = dashboard.data!;
  const counts = data.counts;

  return (
    <div className="space-y-7">
      <Section
        as="h1" title="Workspace overview" description="Every number below comes from the database — nothing is simulated.">
        <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
          <StatCard label="Source videos" value={counts.sources} hint="Uploaded and validated media" />
          <StatCard label="Generated clips" value={counts.clips} hint={`${data.variantBreakdown.map((v) => `${v.count}×${v.durationKind}s`).join(' · ') || 'none yet'}`} />
          <StatCard label="Published posts" value={counts.published} hint={data.publishedByPlatform.map((p) => `${p.platform}: ${p.count}`).join(' · ') || 'No publishes yet'} tone={counts.published > 0 ? 'positive' : 'default'} />
          <StatCard label="Active processing" value={counts.processing} hint={counts.failed > 0 ? `${counts.failed} failed job(s) need attention` : 'No failed jobs'} tone={counts.failed > 0 ? 'danger' : 'default'} />
        </div>
      </Section>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Recent processing jobs" description="Live stage and progress reported by the workers" action={<Link href="/jobs" className="inline-flex min-h-[24px] items-center text-[13px] font-medium text-accent hover:underline">View all</Link>} />
          {data.recentJobs.length === 0 ? (
            <EmptyState title="No processing jobs yet" description="Upload a source video to start generating vertical clips." action={<Link href="/create" className="btn-primary">Create project</Link>} />
          ) : (
            <ul className="divide-y divide-line">
              {data.recentJobs.map((job) => (
                <li key={job.id} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/jobs/${job.id}`} className="block truncate py-1 text-sm font-medium text-ink hover:text-accent">
                        {job.fileName ?? 'Untitled source'}
                      </Link>
                      <p className="text-xs text-ink-faint">
                        {formatDuration(job.durationSeconds)} · {formatRelative(job.createdAt)}
                      </p>
                    </div>
                    <StatusBadge value={job.status} />
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <ProgressBar value={job.progressPercent} tone={job.status === 'FAILED' ? 'danger' : job.status === 'COMPLETED' ? 'positive' : 'accent'} />
                    <span className="w-10 shrink-0 text-right text-xs text-ink-faint">{job.progressPercent}%</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Latest clips" description="Highest scoring clips from recent jobs" />
          {data.recentClips.length === 0 ? (
            <EmptyState title="No clips yet" description="Clips appear here as soon as rendering finishes." />
          ) : (
            <ul className="divide-y divide-line">
              {data.recentClips.map((clip) => (
                <li key={clip.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <Link href={`/clips?highlight=${clip.id}`} className="block truncate py-1 text-[13px] font-medium text-ink hover:text-accent">
                      {clip.title || 'Untitled clip'}
                    </Link>
                    <p className="text-xs text-ink-faint">{clip.durationKind}s · score {clip.qualityScore}/100</p>
                  </div>
                  <StatusBadge value={clip.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent activity" description="Audit trail written by the API" action={<Link href="/activity" className="inline-flex min-h-[24px] items-center text-[13px] font-medium text-accent hover:underline">Full log</Link>} />
          <ul className="divide-y divide-line">
            {data.recentActivity.slice(0, 7).map((item) => (
              <li key={item.id} className="px-5 py-2.5">
                <p className="text-[13px] text-ink">{item.summary}</p>
                <p className="text-xs text-ink-faint">{item.action.replaceAll('_', ' ').toLowerCase()} · {formatRelative(item.createdAt)}</p>
              </li>
            ))}
            {data.recentActivity.length === 0 ? <li className="px-5 py-6 text-sm text-ink-soft">No activity recorded yet.</li> : null}
          </ul>
        </Card>

        <Card>
          <CardHeader
            title="System health"
            description="Measured from the running services"
            action={isOperator ? <Link href="/admin" className="inline-flex min-h-[24px] items-center text-[13px] font-medium text-accent hover:underline">Details</Link> : undefined}
          />
          <div className="space-y-2 px-5 py-4">
            {system.data ? (
              <>
                {[
                  system.data.readiness.components.db,
                  system.data.readiness.components.redis,
                  system.data.readiness.components.storage,
                  system.data.readiness.components.ai,
                  system.data.readiness.components.vp,
                  ...system.data.readiness.components.integration,
                ].map((component) => (
                  <div key={component.component} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
                    <span className="min-w-0 font-medium text-ink">{component.component}</span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 max-w-[220px] truncate text-xs text-ink-faint">{component.message}</span>
                      <span className="shrink-0"><StatusBadge value={component.status} /></span>
                    </span>
                  </div>
                ))}
              </>
            ) : !isOperator ? (
              <p className="text-[13px] text-ink-soft">Service health is visible to workspace owners and admins.</p>
            ) : system.error ? (
              <p className="text-[13px] text-ink-soft">{system.error.message}</p>
            ) : (
              <Skeleton rows={4} />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
