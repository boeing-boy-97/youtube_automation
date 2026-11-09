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
          <div className="overflow-x-auto">
            <table className="table w-full">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Stage</th>
                  <th>Status</th>
                  <th className="w-[180px]">Progress</th>
                  <th>Clips</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data!.items.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link href={`/jobs/${job.id}`} className="font-medium text-ink hover:text-accent">
                        {job.source.originalFileName ?? job.id.slice(0, 8)}
                      </Link>
                      <div className="text-xs text-ink-faint">{formatDuration(job.source.durationSeconds)} · attempt {job.attempt}</div>
                    </td>
                    <td className="text-[13px] text-ink-soft">{job.stage.replaceAll('_', ' ').toLowerCase()}</td>
                    <td><StatusBadge value={job.status} /></td>
                    <td>
                      <div className="flex items-center gap-2">
                        <ProgressBar value={job.progressPercent} tone={job.status === 'FAILED' ? 'danger' : job.status === 'COMPLETED' ? 'positive' : 'accent'} />
                        <span className="w-9 text-right text-xs text-ink-faint">{job.progressPercent}%</span>
                      </div>
                      {job.progressDetail ? <p className="mt-1 truncate text-xs text-ink-faint">{job.progressDetail}</p> : null}
                    </td>
                    <td className="text-[13px]">{job.clipCount}</td>
                    <td className="text-xs text-ink-faint">{formatRelative(job.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
