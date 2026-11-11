'use client';

import { useDiagnostics, useIsOperator, useSystemOverview, type DiagnosticSeverity } from '@/lib/hooks';
import { Badge, Card, CardHeader, ErrorState, Section, Skeleton, StatCard, StatusBadge } from '@/components/ui';
import { formatRelative } from '@/lib/api';
import { DeployCheck } from '@/components/deploy-check';
import { NotificationsPanel } from '@/components/notifications-panel';

/** One colour vocabulary across the app: green = fine, amber = look soon, red = act now. */
const SEVERITY_TONE: Record<DiagnosticSeverity, 'positive' | 'neutral' | 'caution' | 'danger'> = {
  ok: 'positive',
  info: 'neutral',
  warning: 'caution',
  critical: 'danger',
};

export default function AdminPage() {
  const isOperator = useIsOperator();
  const system = useSystemOverview(isOperator);
  const diagnostics = useDiagnostics(isOperator);

  if (!isOperator) {
    return (
      <Card className="px-5 py-4">
        <p className="text-[13px] font-semibold text-ink">Operators only</p>
        <p className="mt-1 text-[13px] text-ink-soft">
          System health, worker leases and queue depths are visible to workspace owners and admins.
        </p>
      </Card>
    );
  }
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
      <Section
        as="h1" title="System administration" description="Read-only operational view. Values are measured live from the database, Redis and the internal services." />

      <DeployCheck />

      <NotificationsPanel />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <StatCard label="API uptime" value={`${Math.floor(data.uptimeSeconds / 60)}m`} hint={`Since last restart · ${data.timezone}`} />
        <StatCard label="Workers alive" value={data.workers.filter((worker) => worker.alive).length} hint={`${data.workers.length} registered`} tone={data.workers.some((worker) => !worker.alive) ? 'danger' : 'positive'} />
        <StatCard label="Queue failures" value={Object.values(data.queues).reduce((sum, queue) => sum + queue.failed, 0)} hint="Across all queues" />
            <StatCard
          label="Services"
          value={data.readiness.ready ? 'Reachable' : 'Blocked'}
          tone={data.readiness.ready ? 'positive' : 'danger'}
          hint="PostgreSQL, Redis and storage"
        />
        <StatCard
          label="Processing chain"
          value={data.readiness.processingReady ? 'Ready' : 'Incomplete'}
          tone={data.readiness.processingReady ? 'positive' : 'caution'}
          hint={
            data.readiness.processingReady
              ? 'AI engine, video processor and AI provider all healthy'
              : `Blocked by: ${components
                  .filter((component) => ['ai', 'vp', 'gemini'].includes(component.component) && component.status !== 'healthy')
                  .map((component) => component.component)
                  .join(', ') || 'unknown'}`
          }
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Components" description="Health probes run on each request" />
          <ul className="divide-y divide-line">
            {components.map((component) => (
              <li key={component.component} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-ink">{component.component}</p>
                  <p className="truncate text-xs text-ink-faint">{component.message}{component.latencyMs !== undefined ? ` · ${component.latencyMs}ms` : ''}</p>
                </div>
                <span className="shrink-0"><StatusBadge value={component.status} /></span>
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
                <li key={`${worker.role}-${worker.workerId}`} className="flex items-start justify-between gap-3 px-5 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-ink">{worker.role}</p>
                    <p className="truncate font-mono text-xs text-ink-faint">{worker.workerId} · heartbeat {worker.lastHeartbeatAgoSeconds}s ago</p>
                  </div>
                  <span className="shrink-0"><StatusBadge value={worker.alive ? 'healthy' : 'down'} /></span>
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
        <CardHeader title="Diagnostics" description="Actionable findings with a measured detail and the step that resolves each one" />
        {diagnostics.isLoading ? (
          <Skeleton rows={4} />
        ) : diagnostics.error ? (
          <div className="p-5"><ErrorState message={diagnostics.error.message} onRetry={() => void diagnostics.refetch()} /></div>
        ) : (
          <ul className="divide-y divide-line">
            {diagnostics.data!.findings.map((finding) => (
              <li key={finding.id} className="flex items-start justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-ink">{finding.title}</p>
                  <p className="text-xs text-ink-soft">{finding.detail}</p>
                  {finding.action ? <p className="mt-0.5 text-xs text-ink-faint">→ {finding.action}</p> : null}
                </div>
                <span className="shrink-0"><Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Badge></span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Health events" description="Recorded by the monitoring probes" />
        {data.healthEvents.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-soft">No health events recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.healthEvents.slice(0, 12).map((event) => (
              <li key={event.id} className="flex items-start justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-ink">{event.component} · {event.severity}</p>
                  <p className="truncate text-xs text-ink-faint">{event.message}</p>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusBadge value={event.status} />
                  <span className="whitespace-nowrap text-xs text-ink-faint">{formatRelative(event.observedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
