import {
  canTransition,
  isTerminal,
  type JobState,
} from '@clipforge/shared-types';
import type { Prisma } from '@prisma/client';
import { prisma } from './client';
import { writeOutbox } from './outbox';

export class IllegalTransitionError extends Error {
  code = 'ILLEGAL_JOB_TRANSITION';
  constructor(from: JobState, to: JobState) {
    super(`Illegal job transition ${from} -> ${to}`);
  }
}

export interface CreateJobInput {
  workspaceId: string;
  sourceVideoId: string;
  createdById: string;
  configuration: Record<string, unknown>;
  maxAttempts?: number;
}

/**
 * Creates the job + its initial stage row + the outbox intent atomically.
 * Nothing is put in memory: a crash immediately after this commit still results
 * in the job being queued by the relay.
 */
export async function createProcessingJob(input: CreateJobInput) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.processingJob.create({
      data: {
        workspaceId: input.workspaceId,
        sourceVideoId: input.sourceVideoId,
        createdById: input.createdById,
        status: 'QUEUED',
        stage: 'QUEUED',
        configuration: input.configuration as Prisma.InputJsonValue,
        maxAttempts: input.maxAttempts ?? 3,
      },
    });
    await tx.jobStage.create({ data: { jobId: job.id, stage: 'QUEUED', status: 'SUCCEEDED', progressPercent: 100, finishedAt: new Date() } });
    await writeOutbox(tx, {
      aggregateType: 'ProcessingJob',
      aggregateId: job.id,
      eventType: 'job.queued',
      queue: 'clipforge.pipeline',
      payload: { jobId: job.id },
    });
    return job;
  });
}

export interface TransitionOptions {
  progressPercent?: number;
  progressDetail?: string | null;
  workerId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorDetails?: Prisma.InputJsonValue | null;
  resultSummary?: Prisma.InputJsonValue | null;
  enqueue?: { queue: string; eventType: string; payload: Record<string, unknown> };
  leaseSeconds?: number;
}

/**
 * Advances the durable state machine. Rejects illegal transitions, appends a
 * JobStage row for the entered stage, and optionally writes an outbox intent —
 * all in one transaction.
 */
export async function transitionJob(jobId: string, to: JobState, options: TransitionOptions = {}) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.processingJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job ${jobId} not found`);
    const from = job.status as JobState;
    if (from === to) {
      return job;
    }
    if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);

    const now = new Date();
    const terminal = isTerminal(to);
    const leaseExpiresAt = options.leaseSeconds
      ? new Date(now.getTime() + options.leaseSeconds * 1000)
      : terminal
        ? null
        : job.leaseExpiresAt;

    const updated = await tx.processingJob.update({
      where: { id: jobId },
      data: {
        status: to,
        stage: to,
        // One RETRYING transition == one consumed retry attempt.
        ...(to === 'RETRYING' ? { attempt: { increment: 1 } } : {}),
        ...(options.progressPercent !== undefined ? { progressPercent: options.progressPercent } : {}),
        ...(options.progressDetail !== undefined ? { progressDetail: options.progressDetail } : {}),
        ...(options.workerId !== undefined ? { workerId: options.workerId } : {}),
        ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
        ...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
        ...(options.errorDetails ? { errorDetails: options.errorDetails } : {}),
        ...(options.resultSummary ? { resultSummary: options.resultSummary } : {}),
        leaseExpiresAt,
        heartbeatAt: terminal ? job.heartbeatAt : now,
        startedAt: job.startedAt ?? now,
        completedAt: terminal ? now : null,
      },
    });

    // Close out stages that were still in flight. Without this every stage a job passed through
    // stayed RUNNING forever, so the timeline (and any operator looking at it) was misleading.
    await tx.jobStage.updateMany({
      where: { jobId, stage: { not: to }, status: 'RUNNING' },
      data: {
        status: to === 'FAILED' || (options.errorCode && to === 'RETRYING') ? 'FAILED' : 'SUCCEEDED',
        finishedAt: now,
      },
    });

    await tx.jobStage.upsert({
      where: { jobId_stage: { jobId, stage: to } },
      update: {
        status: terminal || to === 'RETRYING' ? 'SUCCEEDED' : 'RUNNING',
        startedAt: now,
        finishedAt: terminal ? now : null,
        progressPercent: options.progressPercent ?? 0,
        ...(options.errorCode ? { errorCode: options.errorCode, errorMessage: options.errorMessage ?? null } : {}),
        workerId: options.workerId ?? null,
      },
      create: {
        jobId,
        stage: to,
        status: terminal ? 'SUCCEEDED' : 'RUNNING',
        startedAt: now,
        finishedAt: terminal ? now : null,
        progressPercent: options.progressPercent ?? 0,
        workerId: options.workerId ?? null,
        ...(options.errorCode ? { errorCode: options.errorCode, errorMessage: options.errorMessage ?? null } : {}),
      },
    });

    // A stage row records when it started and when it finished but never how long it took, so the
    // timeline showed "—" for every stage. Prisma cannot compute a duration in an update, so this
    // derives it from the two timestamps it already stores.
    await tx.$executeRaw`
      UPDATE "JobStage"
         SET "durationMs" = GREATEST(0, ROUND(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000))::int
       WHERE "jobId" = ${jobId}::uuid
         AND "durationMs" IS NULL
         AND "startedAt" IS NOT NULL
         AND "finishedAt" IS NOT NULL
    `;

    if (options.enqueue) {
      await writeOutbox(tx, {
        aggregateType: 'ProcessingJob',
        aggregateId: jobId,
        eventType: options.enqueue.eventType,
        queue: options.enqueue.queue,
        payload: options.enqueue.payload,
      });
    }
    return updated;
  });
}

/** Worker lease acquisition. Returns false when another live worker holds the job. */
export async function acquireJobLease(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
  const now = new Date();
  const expires = new Date(now.getTime() + leaseSeconds * 1000);
  const result = await prisma.processingJob.updateMany({
    where: {
      id: jobId,
      OR: [{ workerId: null }, { workerId }, { leaseExpiresAt: { lt: now } }],
      status: { notIn: ['COMPLETED', 'CANCELLED', 'PARTIALLY_COMPLETED'] },
    },
    // NOTE: `attempt` is the retry counter, not a lease counter. Incrementing it here made a
    // healthy job burn its whole retry budget just by moving between pipeline and render workers,
    // so a single transient failure then exhausted maxAttempts immediately.
    data: { workerId, leaseExpiresAt: expires, heartbeatAt: now },
  });
  return result.count === 1;
}

export async function heartbeatJob(jobId: string, workerId: string, leaseSeconds: number): Promise<void> {
  await prisma.processingJob.updateMany({
    where: { id: jobId, workerId },
    data: { heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000) },
  });
}

export async function releaseJobLease(jobId: string): Promise<void> {
  await prisma.processingJob.updateMany({ where: { id: jobId }, data: { workerId: null, leaseExpiresAt: null } });
}

/**
 * Recovery sweep: jobs whose worker lease expired while unfinished.
 * Returns the last successful stage so the job can resume instead of restarting.
 */
export async function findAbandonedJobs(staleAfterSeconds: number) {
  const cutoff = new Date(Date.now() - staleAfterSeconds * 1000);
  const jobs = await prisma.processingJob.findMany({
    where: {
      status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED', 'PARTIALLY_COMPLETED', 'NEEDS_CONFIGURATION', 'QUEUED'] },
      // Only a genuinely silent worker is abandoned: either its lease expired, or
      // it has not heartbeated within the stale window. A released lease alone is
      // NOT evidence of abandonment (the worker releases it between stages).
      OR: [{ leaseExpiresAt: { lt: new Date() } }, { heartbeatAt: { lt: cutoff } }, { heartbeatAt: null }],
    },
    include: { stages: { where: { status: 'SUCCEEDED' }, orderBy: { finishedAt: 'asc' } } },
    take: 50,
  });
  return jobs.map((job) => ({
    jobId: job.id,
    workspaceId: job.workspaceId,
    status: job.status as JobState,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    lastSuccessfulStage: (job.stages.filter((stage) => !['RETRYING', 'QUEUED', 'FAILED', 'CANCELLED'].includes(stage.stage)).at(-1)?.stage as JobState | undefined) ??
      ('PROBING' as JobState),
  }));
}

export async function appendAuditLog(input: {
  workspaceId?: string | null;
  userId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      workspaceId: input.workspaceId ?? null,
      userId: input.userId ?? null,
      action: input.action as never,
      targetType: input.targetType,
      targetId: input.targetId,
      summary: input.summary,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}
