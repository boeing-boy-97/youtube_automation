'use client';

import { useSystemOverview } from '@/lib/hooks';
import { Card, CardHeader, ErrorState, Section, Skeleton, StatCard, StatusBadge } from '@/components/ui';
import { formatRelative } from '@/lib/api';

export default function AdminPage() {
  const system = useSystemOverview();

  if (system.isLoading) return <Card><Skeleton rows={8} /></Card>;
  if (system.error) return <ErrorState message={system.error.message} onRetry={() => void system.refetch()} />;
  const data = system.data!;
  const components = [
    data.readiness.components.db,
    data.readiness.components.redis,
    data.readiness.components.storage,
    data.readiness.components.ai,
    data.readiness.components.vp,
    ...data.readiness.components.integration,
  ];

  return (
    <div className="space-y-5">
      <Section title="System administration" description="Read-only operational view. Values are measured live from the database, Redis and the internal services." />

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="API uptime" value={`${Math.floor(data.uptimeSeconds / 60)}m`} hint={`Since last restart · ${data.timezone}`} />
        <StatCard label="Workers alive" value={data.workers.filter((worker) => worker.alive).length} hint={`${data.workers.length} registered`} tone={data.workers.some((worker) => !worker.alive) ? 'danger' : 'positive'} />
        <StatCard label="Queue failures" value={Object.values(data.queues).reduce((sum, queue) => sum + queue.failed, 0)} hint="Across all queues" />
        <StatCard label="Overall readiness" value={data.readiness.ready ? 'Ready' : 'Blocked'} tone={data.readiness.ready ? 'positive' : 'danger'} hint={data.readiness.processingReady ? 'Processing configured' : 'Processing not configured'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Components" description="Health probes run on each request" />
          <ul className="divide-y divide-line">
            {components.map((component) => (
              <li key={component.component} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div>
                  <p className="text-[13px] font-medium text-ink">{component.component}</p>
                  <p className="text-xs text-ink-faint">{component.message}{component.latencyMs !== undefined ? ` · ${component.latencyMs}ms` : ''}</p>
                </div>
                <StatusBadge value={component.status} />
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Workers" description="Heartbeat age proves the worker is alive; recovery sweeps requeue abandoned jobs" />
          {data.workers.length === 0 ? (
            <p className="px-5 py-6 text-sm text-danger">No worker heartbeats found. Start the worker processes — queued jobs will not progress.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.workers.map((worker) => (
                <li key={`${worker.role}-${worker.workerId}`} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div>
                    <p className="text-[13px] font-medium text-ink">{worker.role}</p>
                    <p className="font-mono text-xs text-ink-faint">{worker.workerId} · heartbeat {worker.lastHeartbeatAgoSeconds}s ago</p>
                  </div>
                  <StatusBadge value={worker.alive ? 'healthy' : 'down'} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Queues" description="BullMQ counts read directly from Redis" />
        <div className="overflow-x-auto">
          <table className="table w-full">
            <thead><tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Failed</th><th>Completed</th></tr></thead>
            <tbody>
              {Object.entries(data.queues).map(([name, counts]) => (
                <tr key={name}>
                  <td className="font-mono text-xs">{name}</td>
                  <td>{counts.waiting}</td>
                  <td>{counts.active}</td>
                  <td>{counts.delayed}</td>
                  <td className={counts.failed > 0 ? 'font-medium text-danger' : ''}>{counts.failed}</td>
                  <td>{counts.completed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Health events" description="Recorded by the monitoring probes" />
        {data.healthEvents.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-soft">No health events recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.healthEvents.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div>
                  <p className="text-[13px] font-medium text-ink">{event.component} · {event.severity}</p>
                  <p className="text-xs text-ink-faint">{event.message}</p>
                </div>
                <span className="flex items-center gap-2">
                  <StatusBadge value={event.status} />
                  <span className="text-xs text-ink-faint">{formatRelative(event.observedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
