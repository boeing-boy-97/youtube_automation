'use client';

import Link from 'next/link';
import { Card, CardHeader, EmptyState, ErrorState, ProgressBar, Section, Skeleton, StatusBadge } from '@/components/ui';
import { useJobs } from '@/lib/hooks';
import { formatDuration, formatRelative } from '@/lib/api';

export default function JobsPage() {
  const jobs = useJobs();

  return (
    <div className="space-y-5">
      <Section
        as="h1"
        title="Processing monitor"
        description="Every stage is reported by the worker running it. Auto-refreshes every 5 seconds."
        action={<Link href="/create" className="btn-primary">New project</Link>}
      />
      <Card>
        <CardHeader title={jobs.data ? `${jobs.data.total} job(s)` : 'Loading jobs'} description="Queued, running, retrying and failed pipelines" />
        {jobs.isLoading ? (
          <Skeleton rows={5} />
        ) : jobs.error ? (
          <div className="p-5">
            <ErrorState message={jobs.error.message} onRetry={() => void jobs.refetch()} />
          </div>
        ) : jobs.data!.items.length === 0 ? (
          <EmptyState title="No processing jobs" description="Create a project to send a video through the AI pipeline." action={<Link href="/create" className="btn-primary">Create project</Link>} />
        ) : (
          <>
          <ul className="divide-y divide-line sm:hidden">
            {jobs.data!.items.map((job) => (
              <li key={job.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="block truncate py-1 text-sm font-medium text-ink hover:text-accent"
                    >
                      {job.source.originalFileName ?? job.id.slice(0, 8)}
                    </Link>
                    <p className="text-xs text-ink-faint">
                      {formatDuration(job.source.durationSeconds)} · {job.stage.replaceAll('_', ' ').toLowerCase()} · attempt {job.attempt}
                    </p>
                  </div>
                  <span className="shrink-0"><StatusBadge value={job.status} /></span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <ProgressBar value={job.progressPercent} tone={job.status === 'FAILED' ? 'danger' : job.status === 'COMPLETED' ? 'positive' : 'accent'} />
                  <span className="w-9 shrink-0 text-right text-xs text-ink-faint">{job.progressPercent}%</span>
                </div>
                <p className="mt-1 truncate text-xs text-ink-faint">
                  {job.clipCount} clip(s) · {formatRelative(job.createdAt)}
                  {job.progressDetail ? ` · ${job.progressDetail}` : ''}
                </p>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto sm:block">
            <table className="table w-full">
              <thead>
                <tr>
                  <th className="min-w-[140px]">Source</th>
                  <th className="hidden sm:table-cell">Stage</th>
                  <th>Status</th>
                  <th className="w-[140px] sm:w-[180px]">Progress</th>
                  <th className="hidden md:table-cell">Clips</th>
                  <th className="hidden md:table-cell">Started</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data!.items.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link href={`/jobs/${job.id}`} className="inline-flex min-h-[26px] items-center py-0.5 font-medium text-ink hover:text-accent">
                        {job.source.originalFileName ?? job.id.slice(0, 8)}
                      </Link>
                      <div className="text-xs text-ink-faint">{formatDuration(job.source.durationSeconds)} · attempt {job.attempt}</div>
                    </td>
                    <td className="hidden text-[13px] text-ink-soft sm:table-cell">{job.stage.replaceAll('_', ' ').toLowerCase()}</td>
                    <td><StatusBadge value={job.status} /></td>
                    <td>
                      <div className="flex items-center gap-2">
                        <ProgressBar value={job.progressPercent} tone={job.status === 'FAILED' ? 'danger' : job.status === 'COMPLETED' ? 'positive' : 'accent'} />
                        <span className="w-9 text-right text-xs text-ink-faint">{job.progressPercent}%</span>
                      </div>
                      {job.progressDetail ? <p className="mt-1 truncate text-xs text-ink-faint">{job.progressDetail}</p> : null}
                    </td>
                    <td className="hidden text-[13px] md:table-cell">{job.clipCount}</td>
                    <td className="hidden whitespace-nowrap text-xs text-ink-faint md:table-cell">{formatRelative(job.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>
    </div>
  );
}
