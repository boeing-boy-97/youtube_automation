'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useJob } from '@/lib/hooks';
import { Card, CardHeader, EmptyState, ErrorState, ProgressBar, Skeleton, StatusBadge } from '@/components/ui';
import { formatDuration, formatRelative } from '@/lib/api';

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const job = useJob(params.id);
  const client = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  // Retry / cancel are real operator actions, so they live in the UI rather than only in the API.
  const retry = useMutation({
    mutationFn: () => api(`/api/jobs/${params.id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      setActionError(null);
      void client.invalidateQueries({ queryKey: ['job', params.id] });
      void client.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error: Error) => setActionError(error.message),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/api/jobs/${params.id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      setActionError(null);
      void client.invalidateQueries({ queryKey: ['job', params.id] });
      void client.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error: Error) => setActionError(error.message),
  });

  if (job.isLoading) return <div className="grid gap-4"><Card><Skeleton rows={6} /></Card></div>;
  if (job.error) return <ErrorState message={job.error.message} onRetry={() => void job.refetch()} />;
  const data = job.data!;
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIALLY_COMPLETED', 'NEEDS_CONFIGURATION'].includes(data.status);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/jobs" className="text-[13px] text-ink-soft hover:text-accent">← Processing monitor</Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">{data.source.originalFileName ?? 'Processing job'}</h1>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            Job {data.id.slice(0, 8)} · attempt {data.attempt} of {data.maxAttempts} · {formatDuration(data.source.durationSeconds)} source
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge value={data.status} />
          {data.clipCount > 0 ? <Link href="/clips" className="btn-secondary">View {data.clipCount} clip(s)</Link> : null}
          {['FAILED', 'PARTIALLY_COMPLETED', 'CANCELLED'].includes(data.status) ? (
            <button type="button" className="btn-secondary" onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? 'Queueing…' : 'Retry job'}
            </button>
          ) : null}
          {!terminal ? (
            <button type="button" className="btn-secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              {cancel.isPending ? 'Cancelling…' : 'Cancel job'}
            </button>
          ) : null}
        </div>
      </div>

      {actionError ? <ErrorState code="ACTION_FAILED" message={actionError} /> : null}

      {data.errorMessage ? (
        <ErrorState code={data.errorCode ?? 'PIPELINE_ERROR'} message={data.errorMessage} />
      ) : null}

      <Card>
        <CardHeader
          title="Progress"
          description={data.progressDetail ?? 'Waiting for the next stage'}
          action={<span className="text-[13px] font-medium text-ink">{data.progressPercent}%</span>}
        />
        <div className="space-y-4 px-5 py-4">
          <ProgressBar value={data.progressPercent} tone={data.status === 'FAILED' ? 'danger' : data.status === 'COMPLETED' ? 'positive' : 'accent'} />
          <ol className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {data.pipeline.map((stage) => {
              const event = [...data.events].reverse().find((item) => item.stage === stage && item.status !== 'RETRYING');
              const active = data.stage === stage && !terminal;
              return (
                <li
                  key={stage}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[13px] ${
                    active ? 'border-accent/40 bg-accent-soft text-accent-strong' : event ? 'border-line bg-white text-ink' : 'border-dashed border-line text-ink-faint'
                  }`}
                >
                  <span className="truncate">{stage.replaceAll('_', ' ').toLowerCase()}</span>
                  {event ? <StatusBadge value={event.status} /> : <span className="text-xs">{active ? 'running' : 'pending'}</span>}
                </li>
              );
            })}
          </ol>
          <div className="grid gap-3 border-t border-line pt-3 text-[13px] text-ink-soft sm:grid-cols-3">
            <p>Worker: <span className="text-ink">{data.workerId ?? 'unassigned'}</span></p>
            <p>Heartbeat: <span className="text-ink">{data.heartbeatAt ? formatRelative(data.heartbeatAt) : '—'}</span></p>
            <p>Lease: <span className="text-ink">{data.leaseExpiresAt ? formatRelative(data.leaseExpiresAt) : 'released'}</span></p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Stage timeline" description="Recorded by the pipeline worker for this job" />
        {data.events.length === 0 ? (
          <EmptyState title="No stage events yet" description="The worker records an event each time a stage starts or finishes." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table w-full">
              <thead>
                <tr><th>Stage</th><th>Status</th><th>Started</th><th>Duration</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <tr key={event.id}>
                    <td className="text-[13px] font-medium">{event.stage.replaceAll('_', ' ').toLowerCase()}</td>
                    <td><StatusBadge value={event.status} /></td>
                    <td className="text-xs text-ink-faint">{event.startedAt ? formatRelative(event.startedAt) : '—'}</td>
                    <td className="text-xs text-ink-soft">{event.durationMs ? `${(event.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                    <td className="max-w-[320px] truncate text-xs text-ink-soft">{event.errorMessage ?? `${event.progressPercent}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Configuration snapshot" description="The exact settings this job used — stored with the job so re-runs stay reproducible" />
        <pre className="max-h-72 overflow-auto px-5 py-4 font-mono text-xs leading-relaxed text-ink-soft">
{JSON.stringify(data.configuration, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
