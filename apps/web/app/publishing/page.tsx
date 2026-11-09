'use client';

import Link from 'next/link';
import { Card, CardHeader, EmptyState, ErrorState, Section, Skeleton, StatCard, StatusBadge } from '@/components/ui';
import { usePublishing, useRetryPublishing } from '@/lib/hooks';
import { formatRelative } from '@/lib/api';

export default function PublishingPage() {
  const publishing = usePublishing();
  const retry = useRetryPublishing();

  if (publishing.isLoading) return <Card><Skeleton rows={5} /></Card>;
  if (publishing.error) return <ErrorState message={publishing.error.message} onRetry={() => void publishing.refetch()} />;

  const { jobs, history } = publishing.data!;
  const failed = jobs.items.filter((job) => job.status === 'FAILED').length;
  const inflight = jobs.items.filter((job) => ['QUEUED', 'UPLOADING', 'AWAITING_PLATFORM', 'RETRYING'].includes(job.status)).length;

  return (
    <div className="space-y-5">
      <Section title="Publishing manager" description="One job per platform and clip. Idempotency keys prevent duplicate uploads; ambiguous timeouts are reconciled from the platform." />

      {history.published.length === 0 && inflight === 0 && failed === 0 ? (
        <ErrorState message="No account has publishing enabled yet. Connect an account and enable publishing to queue clips." />
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Publishing jobs" value={jobs.total} />
        <StatCard label="In flight" value={inflight} />
        <StatCard label="Failed" value={failed} tone={failed > 0 ? 'danger' : 'default'} />
        <StatCard label="Published posts" value={history.published.length} tone={history.published.length > 0 ? 'positive' : 'default'} />
      </div>

      <Card>
        <CardHeader title="Publishing queue" description="Retries use exponential backoff with jitter; permanent failures are not retried" />
        {jobs.items.length === 0 ? (
          <EmptyState title="Nothing queued" description="Select a clip in the library and create publishing jobs for your connected platforms." action={<Link href="/clips" className="btn-primary">Go to clip library</Link>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="table w-full">
              <thead>
                <tr><th>Clip</th><th>Platform</th><th>Status</th><th>Attempt</th><th>Detail</th><th>Scheduled</th><th></th></tr>
              </thead>
              <tbody>
                {jobs.items.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <p className="max-w-[220px] truncate text-[13px] font-medium text-ink">{job.clip.title}</p>
                      <p className="text-xs text-ink-faint">{job.clip.durationKind}s · {job.account.displayName}</p>
                    </td>
                    <td className="text-[13px]">{job.platform}</td>
                    <td><StatusBadge value={job.status} /></td>
                    <td className="text-xs text-ink-soft">{job.attempt}/{job.maxAttempts}</td>
                    <td className="max-w-[260px]">
                      {job.externalUrl ? (
                        <a href={job.externalUrl} target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">Open post</a>
                      ) : (
                        <span className="truncate text-xs text-ink-soft">{job.errorCode ? `${job.errorCode}: ` : ''}{job.errorMessage ?? job.operation.replaceAll('_', ' ').toLowerCase()}</span>
                      )}
                    </td>
                    <td className="text-xs text-ink-faint">{job.scheduledFor ? formatRelative(job.scheduledFor) : 'immediate'}</td>
                    <td>
                      {['FAILED', 'RETRYING'].includes(job.status) ? (
                        <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => retry.mutate(job.id)} disabled={retry.isPending}>
                          Retry
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Published history" description="Recorded from the platform response — includes the external id returned by YouTube/Meta" />
        {history.published.length === 0 ? (
          <EmptyState title="No published posts yet" description="Published posts appear here once a platform confirms the upload." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table w-full">
              <thead>
                <tr><th>Platform</th><th>Account</th><th>External id</th><th>Visibility</th><th>Published</th></tr>
              </thead>
              <tbody>
                {history.published.map((post) => (
                  <tr key={post.id}>
                    <td className="text-[13px] font-medium">{post.platform}</td>
                    <td className="text-[13px] text-ink-soft">{post.account}</td>
                    <td className="font-mono text-xs text-ink-soft">{post.externalId}</td>
                    <td className="text-xs">{post.visibility ?? '—'}</td>
                    <td className="text-xs text-ink-faint">
                      {formatRelative(post.publishedAt)}
                      {post.externalUrl ? <a href={post.externalUrl} target="_blank" rel="noreferrer" className="ml-2 text-accent hover:underline">open</a> : null}
                    </td>
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
