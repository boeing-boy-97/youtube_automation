import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  prisma,
  writeOutbox,
  transitionJob,
  appendAuditLog,
  ConfigurationRequiredError,
  IllegalTransitionError,
} from '@clipforge/database';
import type { CreateJobInput } from '@clipforge/validation';
import { PIPELINE_STATES, type JobState } from '@clipforge/shared-types';

// Concrete pipeline stages a retry may resume from (the array type is the full union).
const PIPELINE_STAGES: readonly JobState[] = PIPELINE_STATES;
import { AppConfigService } from '../common/services/config.service';
import type { RequestContext } from '../common/guards/session-auth.guard';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(private readonly config: AppConfigService) {}

  async create(input: CreateJobInput, ctx: RequestContext) {
    const source = await prisma.sourceVideo.findFirst({
      where: { id: input.sourceVideoId, workspaceId: ctx.workspaceId, deletedAt: null },
      include: { jobs: { where: { status: { notIn: ['FAILED', 'CANCELLED', 'COMPLETED', 'PARTIALLY_COMPLETED'] } } } },
    });
    if (!source) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Source video not found' });
    if (source.status !== 'VALIDATED') {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Source is ${source.status}; wait until validation completes` });
    }
    if (!source.rightsDeclaration) {
      throw new BadRequestException({ code: 'RIGHTS_NOT_DECLARED', message: 'A rights declaration is required before processing' });
    }
    const active = source.jobs[0];
    if (active) {
      throw new ConflictException({ code: 'CONFLICT', message: `Source already has an active job (${active.id})` });
    }

    // Fails closed with HTTP 428 + the exact missing configuration keys.
    const configuration = await this.config.resolveForProcessing(ctx.workspaceId);

    if (input.configuration.maxClips > configuration.maxOutputClips) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `maxClips ${input.configuration.maxClips} exceeds the configured maximum of ${configuration.maxOutputClips}`,
      });
    }
    const preset = await prisma.subtitlePreset.findFirst({
      where: { id: input.configuration.subtitlePresetId, OR: [{ workspaceId: ctx.workspaceId }, { workspaceId: null }] },
    });
    if (!preset) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Subtitle preset not found' });

    if (input.configuration.autoPublish) {
      if (input.configuration.platforms.length === 0) {
        throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'autoPublish requires at least one platform' });
      }
      for (const platform of input.configuration.platforms) {
        const account = await prisma.connectedAccount.findFirst({
          where: { workspaceId: ctx.workspaceId, platform, status: 'CONNECTED', publishingEnabled: true },
        });
        if (!account) {
          throw new BadRequestException({
            code: 'PUBLISH_ELIGIBILITY_FAILED',
            message: `Automatic publishing is not enabled for ${platform}. Connect the account and enable publishing first.`,
          });
        }
      }
      const storagePublic = await import('../storage/storage.service');
      void storagePublic;
    }

    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.processingJob.create({
        data: {
          workspaceId: ctx.workspaceId,
          sourceVideoId: source.id,
          createdById: ctx.userId,
          status: 'QUEUED',
          stage: 'QUEUED',
          configuration: {
            ...input.configuration,
            resolved: {
              aiTextModel: configuration.aiTextModel,
              aiVisionModel: configuration.aiVisionModel,
              duplicateThreshold: configuration.duplicateThreshold,
              loudnessTargetLufs: configuration.loudnessTargetLufs,
              renderWidth: configuration.renderWidth,
              renderHeight: configuration.renderHeight,
              renderFps: configuration.renderFps,
              renderBitrateKbps: configuration.renderBitrateKbps,
            },
            subtitlePresetStyle: preset.style,
          },
        },
      });
      await tx.jobStage.create({
        data: { jobId: created.id, stage: 'QUEUED', status: 'SUCCEEDED', progressPercent: 100, finishedAt: new Date() },
      });
      await writeOutbox(tx, {
        aggregateType: 'ProcessingJob',
        aggregateId: created.id,
        eventType: 'job.queued',
        queue: 'clipforge.pipeline',
        payload: { jobId: created.id },
      });
      return created;
    });

    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'JOB_CREATED',
      targetType: 'ProcessingJob',
      targetId: job.id,
      summary: `Processing job created for source ${source.originalFileName ?? source.id}`,
      metadata: { configuration: input.configuration as unknown as Record<string, unknown> },
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return this.detail(job.id, ctx);
  }

  async list(ctx: RequestContext, query: { page: number; pageSize: number; status?: string; sourceVideoId?: string }) {
    const where = {
      workspaceId: ctx.workspaceId,
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.sourceVideoId ? { sourceVideoId: query.sourceVideoId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.processingJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { sourceVideo: { select: { originalFileName: true, durationSeconds: true } }, _count: { select: { clips: true } } },
      }),
      prisma.processingJob.count({ where }),
    ]);
    return {
      items: items.map((job) => ({
        id: job.id,
        status: job.status,
        stage: job.stage,
        progressPercent: job.progressPercent,
        progressDetail: job.progressDetail,
        attempt: job.attempt,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
        estimatedCompletionAt: job.estimatedCompletionAt?.toISOString() ?? null,
        source: {
          id: job.sourceVideoId,
          originalFileName: job.sourceVideo.originalFileName,
          durationSeconds: job.sourceVideo.durationSeconds,
        },
        clipCount: job._count.clips,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async detail(id: string, ctx: RequestContext) {
    const job = await prisma.processingJob.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: {
        stages: { orderBy: { createdAt: 'asc' } },
        sourceVideo: true,
        _count: { select: { clips: true } },
      },
    });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Job not found' });
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      progressPercent: job.progressPercent,
      progressDetail: job.progressDetail,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      workerId: job.workerId,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      errorDetails: job.errorDetails,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      estimatedCompletionAt: job.estimatedCompletionAt?.toISOString() ?? null,
      heartbeatAt: job.heartbeatAt?.toISOString() ?? null,
      leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
      source: {
        id: job.sourceVideo.id,
        originalFileName: job.sourceVideo.originalFileName,
        durationSeconds: job.sourceVideo.durationSeconds,
        width: job.sourceVideo.width,
        height: job.sourceVideo.height,
        mediaUrl: `/media/sources/${job.sourceVideo.id}`,
      },
      configuration: job.configuration,
      resultSummary: job.resultSummary,
      clipCount: job._count.clips,
      events: job.stages.map((stage) => ({
        id: stage.id,
        stage: stage.stage,
        status: stage.status,
        progressPercent: stage.progressPercent,
        errorCode: stage.errorCode,
        errorMessage: stage.errorMessage,
        startedAt: stage.startedAt?.toISOString() ?? null,
        finishedAt: stage.finishedAt?.toISOString() ?? null,
        durationMs: stage.durationMs,
        attempt: stage.attempt,
      })),
      pipeline: PIPELINE_STATES,
    };
  }

  async cancel(id: string, ctx: RequestContext) {
    const job = await prisma.processingJob.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Job not found' });
    // FAILED is terminal for cancellation too: there is no FAILED -> CANCELLED edge, so asking to
    // cancel a failed job used to surface an IllegalTransitionError as HTTP 500 instead of a conflict.
    if (['COMPLETED', 'CANCELLED', 'PARTIALLY_COMPLETED', 'FAILED'].includes(job.status)) {
      throw new ConflictException({ code: 'CONFLICT', message: `Job is already ${job.status}` });
    }
    try {
      await transitionJob(id, 'CANCELLED', { progressDetail: `Cancelled by ${ctx.email}` });
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        throw new ConflictException({ code: 'CONFLICT', message: `Job in ${job.status} cannot be cancelled` });
      }
      throw error;
    }
    await prisma.jobStage.updateMany({ where: { jobId: id, status: 'RUNNING' }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'JOB_CANCELLED',
      targetType: 'ProcessingJob',
      targetId: id,
      summary: 'Job cancelled by user',
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.detail(id, ctx);
  }

  /** Manual retry: re-enters the state machine and re-enqueues a durable intent. */
  async retry(id: string, ctx: RequestContext) {
    const job = await prisma.processingJob.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: { stages: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'asc' } } },
    });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Job not found' });
    if (!['FAILED', 'PARTIALLY_COMPLETED', 'NEEDS_CONFIGURATION', 'RETRYING'].includes(job.status)) {
      throw new ConflictException({ code: 'CONFLICT', message: `Job in ${job.status} cannot be retried` });
    }
    if (job.attempt >= job.maxAttempts + 3) {
      throw new ConflictException({ code: 'CONFLICT', message: 'Retry budget exhausted for this job' });
    }
    try {
      await this.config.resolveForProcessing(ctx.workspaceId);
    } catch (error) {
      if (error instanceof ConfigurationRequiredError) throw error;
      throw error;
    }

    // Only real pipeline stages count as a resume point. Control/terminal rows (FAILED, RETRYING,
    // CANCELLED…) are also written as "SUCCEEDED" JobStage entries, and resuming from one of those
    // produced an illegal RETRYING -> FAILED transition (HTTP 500) on every retry.
    const resumeCandidates = job.stages
      .filter((stage) => stage.status === 'SUCCEEDED' && PIPELINE_STAGES.includes(stage.stage as JobState))
      .filter((stage) => stage.stage !== 'QUEUED')
      .map((stage) => stage.stage as JobState);
    const lastSuccessful: JobState = resumeCandidates.at(-1) ?? 'PROBING';
    await transitionJob(id, 'RETRYING', { errorCode: null, errorMessage: null, progressDetail: 'Manual retry requested' });
    await transitionJob(id, lastSuccessful, {
      progressDetail: `Retrying from ${lastSuccessful}`,
      enqueue: { queue: 'clipforge.pipeline', eventType: 'job.retry', payload: { jobId: id, resumeFrom: lastSuccessful } },
    });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'JOB_RETRIED',
      targetType: 'ProcessingJob',
      targetId: id,
      summary: `Manual retry from stage ${lastSuccessful}`,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.detail(id, ctx);
  }

  async events(id: string, ctx: RequestContext) {
    const job = await prisma.processingJob.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Job not found' });
    const stages = await prisma.jobStage.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
    return {
      jobId: id,
      status: job.status,
      progressPercent: job.progressPercent,
      progressDetail: job.progressDetail,
      updatedAt: job.updatedAt.toISOString(),
      events: stages.map((s) => ({
        stage: s.stage,
        status: s.status,
        progressPercent: s.progressPercent,
        errorCode: s.errorCode,
        errorMessage: s.errorMessage,
        startedAt: s.startedAt?.toISOString() ?? null,
        finishedAt: s.finishedAt?.toISOString() ?? null,
      })),
    };
  }
}
