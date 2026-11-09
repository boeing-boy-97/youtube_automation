/**
 * Recovery worker — makes the platform survive crashes.
 *
 * Every 30 seconds it looks for jobs whose worker lease expired while unfinished,
 * checks whether the previous stage actually completed (by inspecting its durable
 * artefacts, not assumptions), then resumes from the last successful stage.
 */
import { prisma, transitionJob, writeOutbox, releaseJobLease, appendAuditLog } from '@clipforge/database';
import { findAbandonedJobs } from '@clipforge/database';
import { env } from '../common/env';
import { createRuntime, wireShutdown } from './base';

const runtime = createRuntime('recovery', 1);

async function sweep(): Promise<void> {
  const staleAfter = Math.max(60, env.JOB_LEASE_SECONDS);
  const abandoned = await findAbandonedJobs(staleAfter);
  for (const entry of abandoned) {
    const job = await prisma.processingJob.findUnique({
      where: { id: entry.jobId },
      include: { stages: { orderBy: { createdAt: 'asc' } }, clips: true },
    });
    if (!job) continue;

    // Only reclaim if the lease really is dead.
    if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > Date.now()) continue;

    // Check whether the in-flight stage actually produced its durable output.
    const renderedClips = job.clips.filter((clip) => clip.status === 'READY').length;
    const lastSucceeded = entry.lastSuccessfulStage;
    let resumeFrom = lastSucceeded;

    if (job.stage === 'RENDERING' && renderedClips > 0) {
      // Rendering partially completed: re-enqueue only the clips still pending.
      const pending = job.clips.filter((clip) => clip.status === 'PLANNED' || clip.status === 'RENDERING');
      runtime.logger.info(`recovering ${pending.length} pending render(s) for job ${job.id}`);
      await prisma.$transaction(async (tx) => {
        for (const clip of pending) {
          await writeOutbox(tx, {
            aggregateType: 'GeneratedClip',
            aggregateId: clip.id,
            eventType: 'clip.render',
            queue: 'clipforge.render',
            payload: { clipId: clip.id, jobId: job.id },
          });
        }
      });
      await releaseJobLease(job.id);
      continue;
    }

    // Post-render stages must not fall back to analysis: clips are already rendered.
    const postRender = ['VALIDATION', 'ASSET_STORAGE', 'PUBLISHING_QUEUED', 'PUBLISHING'];
    if (postRender.includes(job.stage) && renderedClips > 0) resumeFrom = 'VALIDATION';
    if (!job.stages.length) resumeFrom = 'PROBING';
    const recoverable = ['PROBING', 'TRANSCRIBING', 'AI_ANALYSIS', 'CLIP_SELECTION', 'RENDERING', 'VALIDATION', 'ASSET_STORAGE', 'PUBLISHING_QUEUED'];
    if (!recoverable.includes(resumeFrom)) continue;

    // Never sweep forever: the retry budget is finite and is consumed on each RETRYING entry.
    if (job.attempt >= job.maxAttempts) {
      runtime.logger.error(`job ${job.id} exhausted ${job.maxAttempts} attempt(s); marking FAILED`);
      try {
        await transitionJob(job.id, 'FAILED', {
          errorCode: 'RETRY_BUDGET_EXHAUSTED',
          errorMessage: `Worker loss recovery exhausted all ${job.maxAttempts} attempt(s) at stage ${job.stage}`,
          progressDetail: `Failed after ${job.attempt} attempt(s)`,
        });
        await appendAuditLog({
          workspaceId: job.workspaceId,
          userId: job.createdById,
          action: 'JOB_STAGE_CHANGED',
          targetType: 'ProcessingJob',
          targetId: job.id,
          summary: `Job failed: retry budget exhausted after worker loss at ${job.stage}`,
        });
      } catch (error) {
        runtime.logger.error(`could not fail exhausted job ${job.id}: ${(error as Error).message}`);
      }
      continue;
    }

    runtime.logger.warn(`reclaiming abandoned job ${job.id} (stage=${job.stage}, resume=${resumeFrom})`);
    try {
      await transitionJob(job.id, 'RETRYING', {
        progressDetail: `Worker lease expired at stage ${job.stage}; recovering from ${resumeFrom}`,
        errorCode: 'WORKER_LOST',
        errorMessage: `Worker ${job.workerId ?? 'unknown'} stopped heartbeating`,
      });
      await transitionJob(job.id, resumeFrom as never, {
        progressDetail: `Resumed from ${resumeFrom} after worker loss`,
        workerId: null,
        enqueue: { queue: 'clipforge.pipeline', eventType: 'job.recover', payload: { jobId: job.id, resumeFrom } },
      });
      await releaseJobLease(job.id);
    } catch (error) {
      runtime.logger.error(`recovery failed for job ${job.id}: ${(error as Error).message}`);
    }
  }

  // Publishing jobs whose worker died mid-flight.
  const stuckPublishing = await prisma.publishingJob.findMany({
    where: {
      status: { in: ['UPLOADING', 'AWAITING_PLATFORM'] },
      updatedAt: { lt: new Date(Date.now() - 10 * 60_000) },
    },
    take: 20,
  });
  for (const publishingJob of stuckPublishing) {
    if (publishingJob.attempt >= publishingJob.maxAttempts) {
      runtime.logger.error(`publishing job ${publishingJob.id} exhausted ${publishingJob.maxAttempts} attempt(s); marking FAILED`);
      await prisma.publishingJob.update({
        where: { id: publishingJob.id },
        data: {
          status: 'FAILED',
          retryable: false,
          errorCode: 'RETRY_BUDGET_EXHAUSTED',
          errorMessage: `Publishing stalled at ${publishingJob.status}; ${publishingJob.attempt} attempt(s) exhausted`,
          completedAt: new Date(),
        },
      });
      continue;
    }
    runtime.logger.warn(`reclaiming stalled publishing job ${publishingJob.id}`);
    await prisma.$transaction(async (tx) => {
      await tx.publishingJob.update({
        where: { id: publishingJob.id },
        data: { status: 'QUEUED', workerId: null, leaseExpiresAt: null },
      });
      await writeOutbox(tx, {
        aggregateType: 'PublishingJob',
        aggregateId: publishingJob.id,
        eventType: 'publish.requested',
        queue: 'clipforge.publish',
        payload: { publishingJobId: publishingJob.id, recovered: true },
      });
    });
  }
}

async function main() {
  runtime.logger.info('recovery worker started (30s sweep)');
  setInterval(() => {
    void sweep().catch((error: Error) => runtime.logger.error(`recovery sweep: ${error.message}`));
  }, 30_000);
  wireShutdown(runtime, []);
}

void main();
