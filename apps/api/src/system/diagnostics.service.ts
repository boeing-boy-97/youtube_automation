import { statfs } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { prisma } from '@clipforge/database';
import { env } from '../common/env';
import { QueueService } from '../queues/queue.service';
import { SystemService } from './system.service';
import {
  describeFinding,
  worstSeverity,
  type DiagnosticFinding,
  type DiagnosticsReport,
} from './diagnostics.types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Builds the operator diagnostics report. Thresholds are deliberately conservative and are written
 * into the finding text, so nobody has to read this file to understand why something is flagged.
 */
@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly system: SystemService,
    private readonly queues: QueueService,
  ) {}

  async report(workspaceId: string): Promise<DiagnosticsReport> {
    const [
      readiness,
      queueDepths,
      stuckJobs,
      stuckPublishing,
      outboxBacklog,
      expiringCredentials,
      failedJobs,
      disk,
      healthEvents,
    ] = await Promise.all([
      this.system.readiness(),
      this.queues.depths(),
      this.stuckJobs(),
      this.stuckPublishingJobs(),
      this.outboxBacklog(),
      this.expiringCredentials(workspaceId),
      this.recentFailedJobs(workspaceId),
      this.diskUsage(),
      prisma.systemHealthEvent.findMany({ orderBy: { observedAt: 'desc' }, take: 10 }),
    ]);

    const findings: DiagnosticFinding[] = [
      ...this.componentFindings(readiness.components),
      ...this.workerFindings(readiness.workers),
      ...this.queueFindings(queueDepths),
      stuckJobs,
      stuckPublishing,
      outboxBacklog,
      expiringCredentials,
      disk,
    ];

    if (failedJobs.length > 0) {
      findings.push(
        describeFinding(
          'jobs.recent-failures',
          'Jobs failed in the last 24 hours',
          'info',
          `${failedJobs.length} job(s) in this workspace failed in the last 24h with code(s): ${[...new Set(failedJobs.map((job) => job.errorCode ?? 'UNKNOWN'))].join(', ')}.`,
          'Open each job to see the stage error; retry is safe once the cause is fixed.',
          {
            count: failedJobs.length,
            samples: failedJobs.map((job) => ({
              id: job.id,
              status: job.status,
              stage: job.stage,
              errorCode: job.errorCode,
              attempts: `${job.attempt}/${job.maxAttempts}`,
              createdAt: job.createdAt.toISOString(),
            })),
          },
        ),
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      version: process.env.npm_package_version ?? '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      worst: worstSeverity(findings),
      findings,
      components: [
        readiness.components.db,
        readiness.components.redis,
        readiness.components.storage,
        readiness.components.ai,
        readiness.components.vp,
        ...readiness.components.integration,
      ],
      environment: {
        nodeEnv: env.NODE_ENV,
        timezone: env.TIMEZONE,
        storageDriver: env.STORAGE_DRIVER,
        jobLeaseSeconds: env.JOB_LEASE_SECONDS,
        workerConcurrency: {
          ai: env.WORKER_CONCURRENCY_AI,
          render: env.WORKER_CONCURRENCY_RENDER,
          publish: env.WORKER_CONCURRENCY_PUBLISH,
        },
      },
      // Kept last for readability in the UI; the raw components are re-exposed above.
      ...({ healthEvents: healthEvents.map((event) => ({
        component: event.component,
        severity: event.severity,
        status: event.status,
        message: event.message,
        observedAt: event.observedAt.toISOString(),
      })) } as Record<string, unknown>),
    } as DiagnosticsReport;
  }

  private componentFindings(components: Record<string, unknown>): DiagnosticFinding[] {
    const flatten = Object.values(components)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is { component: string; status: string; message: string } =>
        Boolean(value) && typeof value === 'object' && 'component' in (value as Record<string, unknown>),
      );
    return flatten
      .filter((component) => component.status === 'down' || component.status === 'degraded')
      .map((component) =>
        describeFinding(
          `component.${component.component}`,
          `${component.component} is ${component.status}`,
          component.status === 'down' ? 'critical' : 'warning',
          component.message,
          component.status === 'down'
            ? 'Restart the dependency and confirm /api/system/readiness returns healthy before accepting work.'
            : 'Investigate the reported message; processing may still work but is degraded.',
        ),
      );
  }

  private workerFindings(workers: Array<{ role: string; workerId: string; alive: boolean; lastHeartbeatAgoSeconds: number }>): DiagnosticFinding[] {
    const findings: DiagnosticFinding[] = [];
    const expectedRoles = ['ai', 'render', 'publish', 'scheduler', 'recovery'];
    const aliveRoles = new Set(workers.filter((worker) => worker.alive).map((worker) => worker.role));
    const missing = expectedRoles.filter((role) => !aliveRoles.has(role));
    if (missing.length > 0) {
      findings.push(
        describeFinding(
          'workers.missing',
          'Worker roles are not heartbeating',
          missing.includes('ai') || missing.includes('render') ? 'critical' : 'warning',
          `No heartbeat within 60s from: ${missing.join(', ')}.`,
          'Start the missing worker processes (npm run worker:<role>) and check their logs.',
          { count: missing.length, samples: missing.map((role) => ({ role })) },
        ),
      );
    }
    return findings;
  }

  private queueFindings(depths: Record<string, { waiting: number; active: number; failed: number; delayed?: number }>): DiagnosticFinding[] {
    const findings: DiagnosticFinding[] = [];
    const failed = Object.entries(depths).filter(([, depth]) => depth.failed > 0);
    if (failed.length > 0) {
      findings.push(
        describeFinding(
          'queues.failed',
          'Queues hold failed jobs',
          'warning',
          failed.map(([queue, depth]) => `${queue}: ${depth.failed} failed`).join('; '),
          'Failed BullMQ jobs are inspectable per queue; re-drive them from the job page rather than clearing the queue.',
          { count: failed.reduce((sum, [, depth]) => sum + depth.failed, 0) },
        ),
      );
    }
    return findings;
  }

  private async stuckJobs(): Promise<DiagnosticFinding> {
    // A job is stuck when it is not terminal, holds no live lease, and has not been touched since
    // the lease window. The recovery worker should catch these within one sweep; if one survives a
    // sweep, something is wrong with recovery itself.
    const cutoff = new Date(Date.now() - Math.max(env.JOB_LEASE_SECONDS * 2, 5 * MINUTE));
    const jobs = await prisma.processingJob.findMany({
      where: {
        status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIALLY_COMPLETED', 'NEEDS_CONFIGURATION'] },
        updatedAt: { lt: cutoff },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
      },
      orderBy: { updatedAt: 'asc' },
      take: 20,
      select: { id: true, status: true, stage: true, attempt: true, maxAttempts: true, updatedAt: true, workerId: true },
    });
    if (jobs.length === 0) {
      return describeFinding('jobs.stuck', 'No stuck processing jobs', 'ok', 'Every non-terminal job holds a live lease or was updated recently.', '');
    }
    const oldest = (Date.now() - jobs[0].updatedAt.getTime()) / 1000;
    return describeFinding(
      'jobs.stuck',
      'Processing jobs are stuck',
      'critical',
      `${jobs.length} job(s) have no live lease and have not changed for more than ${Math.round(oldest)}s.`,
      'Check the recovery worker log; if it is alive, the job may need a manual retry (POST /api/jobs/:id/retry).',
      {
        count: jobs.length,
        oldestSeconds: Math.round(oldest),
        samples: jobs.map((job) => ({
          id: job.id,
          status: job.status,
          stage: job.stage,
          attempts: `${job.attempt}/${job.maxAttempts}`,
          lastWorker: job.workerId,
          updatedAt: job.updatedAt.toISOString(),
        })),
      },
    );
  }

  private async stuckPublishingJobs(): Promise<DiagnosticFinding> {
    const cutoff = new Date(Date.now() - 10 * MINUTE);
    const jobs = await prisma.publishingJob.findMany({
      where: { status: { in: ['UPLOADING', 'AWAITING_PLATFORM'] }, updatedAt: { lt: cutoff } },
      orderBy: { updatedAt: 'asc' },
      take: 20,
      select: { id: true, platform: true, status: true, attempt: true, maxAttempts: true, updatedAt: true },
    });
    if (jobs.length === 0) {
      return describeFinding('publishing.stuck', 'No stalled publishing jobs', 'ok', 'Nothing has been in-flight for more than 10 minutes.', '');
    }
    return describeFinding(
      'publishing.stuck',
      'Publishing jobs are stalled',
      'critical',
      `${jobs.length} publishing job(s) have been in-flight for more than 10 minutes.`,
      'The recovery worker re-queues these after 10 minutes; verify it is running and check platform API status.',
      {
        count: jobs.length,
        oldestSeconds: Math.round((Date.now() - jobs[0].updatedAt.getTime()) / 1000),
        samples: jobs.map((job) => ({
          id: job.id,
          platform: job.platform,
          status: job.status,
          attempts: `${job.attempt}/${job.maxAttempts}`,
          updatedAt: job.updatedAt.toISOString(),
        })),
      },
    );
  }

  private async outboxBacklog(): Promise<DiagnosticFinding> {
    const [pending, oldest] = await Promise.all([
      prisma.outboxEvent.count({ where: { publishedAt: null } }),
      prisma.outboxEvent.findFirst({ where: { publishedAt: null }, orderBy: { createdAt: 'asc' }, select: { createdAt: true, eventType: true } }),
    ]);
    if (pending === 0) {
      return describeFinding('outbox.backlog', 'Outbox is empty', 'ok', 'Every transactional event has been relayed to its queue.', '');
    }
    const ageSeconds = oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000) : 0;
    const severity = ageSeconds > HOUR / 1000 ? 'critical' : ageSeconds > 60 ? 'warning' : 'info';
    return describeFinding(
      'outbox.backlog',
      'Outbox events are waiting',
      severity,
      `${pending} unpublished event(s); the oldest (${oldest?.eventType ?? 'unknown'}) is ${ageSeconds}s old.`,
      'The relay runs inside each worker; if the backlog grows, no worker is polling. Start the workers and re-check.',
      { count: pending, oldestSeconds: ageSeconds },
    );
  }

  private async expiringCredentials(workspaceId: string): Promise<DiagnosticFinding> {
    const soon = new Date(Date.now() + 24 * HOUR);
    const rows = await prisma.oAuthCredential.findMany({
      where: { connectedAccount: { workspaceId }, expiresAt: { lt: soon } },
      select: { id: true, connectedAccountId: true, expiresAt: true, connectedAccount: { select: { platform: true, displayName: true } } },
      take: 20,
    });
    const expired = rows.filter((row) => row.expiresAt && row.expiresAt.getTime() <= Date.now());
    if (rows.length === 0) {
      return describeFinding('credentials.expiry', 'No credentials expire within 24h', 'ok', 'Connected accounts have valid access tokens.', '');
    }
    return describeFinding(
      'credentials.expiry',
      expired.length > 0 ? 'Connected account tokens have expired' : 'Connected account tokens expire soon',
      expired.length > 0 ? 'critical' : 'warning',
      `${rows.length} credential(s) expire within 24h${expired.length ? `, ${expired.length} already expired` : ''}.`,
      'The scheduler refreshes tokens that support refresh; accounts without a refresh token must be reconnected by an owner.',
      {
        count: rows.length,
        samples: rows.map((row) => ({
          account: row.connectedAccount.displayName,
          platform: row.connectedAccount.platform,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        })),
      },
    );
  }

  private async recentFailedJobs(workspaceId: string) {
    return prisma.processingJob.findMany({
      where: { workspaceId, status: 'FAILED', updatedAt: { gte: new Date(Date.now() - 24 * HOUR) } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, status: true, stage: true, errorCode: true, attempt: true, maxAttempts: true, createdAt: true },
    });
  }

  private async diskUsage(): Promise<DiagnosticFinding> {
    try {
      const stats = await statfs(env.WORK_DIR);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usedPercent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;
      const severity = usedPercent >= 95 ? 'critical' : usedPercent >= 85 ? 'warning' : 'ok';
      return describeFinding(
        'disk.work-dir',
        severity === 'ok' ? 'Work directory has free space' : 'Work directory is filling up',
        severity,
        `${usedPercent}% of the filesystem holding WORK_DIR (${env.WORK_DIR}) is used; ${(freeBytes / 1024 ** 3).toFixed(1)} GiB free.`,
        severity === 'ok' ? '' : 'Prune work directories and rendered assets, or grow the volume before accepting more jobs.',
        { count: usedPercent },
      );
    } catch (error) {
      return describeFinding(
        'disk.work-dir',
        'Work directory could not be measured',
        'warning',
        (error as Error).message,
        'Confirm WORK_DIR exists and is readable by the API process.',
      );
    }
  }
}
