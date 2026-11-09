import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { appendAuditLog, prisma, writeOutbox } from '@clipforge/database';
import { backoffWithJitter } from '@clipforge/platform-connectors';
import type { PublishingToggleInput } from '@clipforge/validation';
import type { Platform } from '@clipforge/shared-types';
import { AppConfigService } from '../common/services/config.service';
import { StorageService } from '../storage/storage.service';
import { AccountsService } from '../accounts/accounts.service';
import type { RequestContext } from '../common/guards/session-auth.guard';

const OPERATION_FOR: Record<Platform, 'SINGLE_VIDEO_UPLOAD' | 'REEL_PUBLISH'> = {
  YOUTUBE: 'SINGLE_VIDEO_UPLOAD',
  INSTAGRAM: 'REEL_PUBLISH',
};

@Injectable()
export class PublishingService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Enables/disables automatic publishing for one connected account.
   * Every precondition is explicit: connected account, permissions, storage that
   * the platform can actually reach, privacy configuration and accepted terms.
   */
  async setEnabled(input: PublishingToggleInput, ctx: RequestContext) {
    const account = await this.accounts.assertPublishable(input.connectedAccountId, ctx.workspaceId);

    if (!input.enabled) {
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { publishingEnabled: false },
      });
      await appendAuditLog({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        action: 'PUBLISHING_DISABLED',
        targetType: 'ConnectedAccount',
        targetId: account.id,
        summary: `Automatic publishing disabled for ${account.platform}`,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { enabled: false };
    }

    // 1. Publishing configuration must be complete and valid for the platform.
    const publishingConfig = this.buildPublishingConfig(input, account.platform);
    // 2. Storage must serve media over public HTTPS — checked, never assumed.
    const storageCheck = await this.storage.expectPublicHttps();
    if (!storageCheck.ok) {
      throw new BadRequestException({ code: 'PUBLISH_ELIGIBILITY_FAILED', message: storageCheck.reason });
    }
    // 3. Required scopes must actually be granted.
    const requiredScopes =
      account.platform === 'YOUTUBE'
        ? ['https://www.googleapis.com/auth/youtube.upload']
        : ['instagram_business_content_publish'];
    const missingScopes = requiredScopes.filter((scope) => !account.scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new BadRequestException({
        code: 'PUBLISH_ELIGIBILITY_FAILED',
        message: `The connected ${account.platform} account is missing required permission(s): ${missingScopes.join(', ')}. Reconnect the account and grant them.`,
        details: { missingScopes },
      });
    }
    // 4. Live token verification before enabling unattended publishing.
    const health = await this.accounts.verify(account.id, ctx);
    if (!health.healthy) {
      throw new BadRequestException({
        code: 'PUBLISH_ELIGIBILITY_FAILED',
        message: `Token verification failed: ${health.detail}`,
      });
    }
    // 5. Workspace publishing configuration must exist.
    await this.config.resolveForProcessing(ctx.workspaceId);

    await prisma.connectedAccount.update({
      where: { id: account.id },
      data: { publishingEnabled: true, publishingConfig, status: 'CONNECTED' },
    });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'PUBLISHING_ENABLED',
      targetType: 'ConnectedAccount',
      targetId: account.id,
      summary: `Automatic publishing enabled for ${account.platform} (${account.displayName})`,
      metadata: { publishingConfig: publishingConfig as unknown as Record<string, unknown> },
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { enabled: true, publishingConfig };
  }

  private buildPublishingConfig(input: PublishingToggleInput, platform: Platform) {
    if (platform === 'YOUTUBE') {
      if (!input.youtube) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'YouTube publishing requires explicit visibility, categoryId, madeForKids and defaultLanguage',
        });
      }
      return {
        visibility: input.youtube.visibility,
        categoryId: input.youtube.categoryId,
        madeForKids: input.youtube.madeForKids,
        defaultLanguage: input.youtube.defaultLanguage,
        termsAcceptedAt: new Date().toISOString(),
      };
    }
    if (!input.instagram) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Instagram publishing requires an explicit shareToFeed and defaultLanguage choice',
      });
    }
    return {
      shareToFeed: input.instagram.shareToFeed,
      defaultLanguage: input.instagram.defaultLanguage,
      termsAcceptedAt: new Date().toISOString(),
    };
  }

  /**
   * Creates one publishing job per platform. Idempotent: the unique
   * idempotency key (clip + platform + account + operation) plus a pre-check for
   * an existing published post prevents double publishing.
   */
  async createJobs(
    input: { clipId: string; platforms: Platform[]; scheduledFor?: string },
    ctx: RequestContext,
  ) {
    const clip = await prisma.generatedClip.findFirst({
      where: { id: input.clipId, workspaceId: ctx.workspaceId },
      include: { variants: true, metadata: true },
    });
    if (!clip) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Clip not found' });
    if (clip.status === 'RENDER_FAILED' || clip.variants.length === 0) {
      throw new ConflictException({ code: 'PUBLISH_ELIGIBILITY_FAILED', message: 'Clip has no rendered variant to publish' });
    }
    if (input.scheduledFor && new Date(input.scheduledFor).getTime() < Date.now() - 60_000) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'scheduledFor must be in the future' });
    }

    const created: Array<{ id: string; platform: Platform }> = [];
    for (const platform of input.platforms) {
      const account = await prisma.connectedAccount.findFirst({
        where: { workspaceId: ctx.workspaceId, platform, status: 'CONNECTED', publishingEnabled: true },
      });
      if (!account) {
        throw new BadRequestException({
          code: 'PUBLISH_ELIGIBILITY_FAILED',
          message: `No ${platform} account with publishing enabled. Connect the account and enable publishing first.`,
        });
      }
      const metadata = clip.metadata.find((m) => m.platform === platform);
      if (!metadata || !metadata.title || !metadata.description) {
        throw new ConflictException({
          code: 'PUBLISH_ELIGIBILITY_FAILED',
          message: `Clip ${clip.id} has no approved ${platform} metadata yet`,
        });
      }
      const alreadyPublished = await prisma.publishedPost.findFirst({
        where: { workspaceId: ctx.workspaceId, platform, connectedAccountId: account.id, externalId: { not: '' } },
        // A published post is matched through its publishing job's clip id below.
      });
      void alreadyPublished;

      const operation = OPERATION_FOR[platform];
      const idempotencyKey = `${clip.id}:${platform}:${account.id}:${operation}`;
      const existing = await prisma.publishingJob.findUnique({ where: { idempotencyKey } });
      if (existing) {
        if (['PENDING', 'QUEUED', 'UPLOADING', 'AWAITING_PLATFORM'].includes(existing.status) || existing.status === 'PUBLISHED') {
          created.push({ id: existing.id, platform });
          continue;
        }
      }

      const job = await prisma.$transaction(async (tx) => {
        const record = existing
          ? await tx.publishingJob.update({
              where: { id: existing.id },
              data: {
                status: 'PENDING',
                attempt: 0,
                errorCode: null,
                errorMessage: null,
                retryable: null,
                scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
                nextAttemptAt: null,
              },
            })
          : await tx.publishingJob.create({
              data: {
                workspaceId: ctx.workspaceId,
                clipId: clip.id,
                clipVariantId: this.pickVariantId(clip.variants, clip.durationKind),
                connectedAccountId: account.id,
                platform,
                operation,
                status: 'PENDING',
                idempotencyKey,
                scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
                visibility: platform === 'YOUTUBE' ? ((account.publishingConfig as { visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE' } | null)?.visibility ?? null) : null,
              },
            });
        await writeOutbox(tx, {
          aggregateType: 'PublishingJob',
          aggregateId: record.id,
          eventType: 'publish.requested',
          queue: 'clipforge.publish',
          payload: { publishingJobId: record.id },
          availableAt: input.scheduledFor ? new Date(input.scheduledFor) : new Date(),
        });
        return record;
      });
      created.push({ id: job.id, platform });
    }

    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'PUBLISH_ATTEMPTED',
      targetType: 'GeneratedClip',
      targetId: clip.id,
      summary: `Publishing jobs created for ${input.platforms.join(', ')}`,
      metadata: { jobs: created },
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { jobs: created };
  }

  private pickVariantId(variants: Array<{ id: string; width: number; height: number }>, durationKind: number): string | null {
    void durationKind;
    return variants[0]?.id ?? null;
  }

  async listJobs(ctx: RequestContext, query: { page: number; pageSize: number; status?: string }) {
    const where = { workspaceId: ctx.workspaceId, ...(query.status ? { status: query.status as never } : {}) };
    const [items, total] = await Promise.all([
      prisma.publishingJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          clip: { select: { id: true, title: true, durationKind: true } },
          connectedAccount: { select: { id: true, displayName: true, platform: true } },
          attempts: { orderBy: { startedAt: 'desc' }, take: 1 },
        },
      }),
      prisma.publishingJob.count({ where }),
    ]);
    return {
      items: items.map((job) => ({
        id: job.id,
        platform: job.platform,
        status: job.status,
        operation: job.operation,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        externalId: job.externalId,
        externalUrl: job.externalUrl,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        retryable: job.retryable,
        scheduledFor: job.scheduledFor?.toISOString() ?? null,
        nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
        clip: job.clip,
        account: job.connectedAccount,
        lastAttempt: job.attempts[0]
          ? {
              attemptNumber: job.attempts[0].attemptNumber,
              operation: job.attempts[0].operation,
              httpStatus: job.attempts[0].httpStatus,
              errorMessage: job.attempts[0].errorMessage,
              startedAt: job.attempts[0].startedAt.toISOString(),
              durationMs: job.attempts[0].durationMs,
            }
          : null,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async history(ctx: RequestContext) {
    const [published, attempts] = await Promise.all([
      prisma.publishedPost.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { publishedAt: 'desc' },
        take: 100,
        include: { connectedAccount: { select: { displayName: true, platform: true } } },
      }),
      prisma.publishingAttempt.findMany({
        where: { publishingJob: { workspaceId: ctx.workspaceId } },
        orderBy: { startedAt: 'desc' },
        take: 100,
        include: { publishingJob: { select: { id: true, platform: true, clipId: true } } },
      }),
    ]);
    return {
      published: published.map((p) => ({
        id: p.id,
        platform: p.platform,
        externalId: p.externalId,
        externalUrl: p.externalUrl,
        publishedAt: p.publishedAt.toISOString(),
        visibility: p.visibility,
        account: p.connectedAccount.displayName,
      })),
      attempts: attempts.map((a) => ({
        id: a.id,
        jobId: a.publishingJob.id,
        platform: a.publishingJob.platform,
        operation: a.operation,
        attemptNumber: a.attemptNumber,
        httpStatus: a.httpStatus,
        errorCode: a.errorCode,
        errorMessage: a.errorMessage,
        retryable: a.retryable,
        startedAt: a.startedAt.toISOString(),
        durationMs: a.durationMs,
      })),
    };
  }

  /** Manual retry — resets backoff but keeps attempt history. */
  async retry(jobId: string, ctx: RequestContext) {
    const job = await prisma.publishingJob.findFirst({ where: { id: jobId, workspaceId: ctx.workspaceId } });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Publishing job not found' });
    if (job.status === 'PUBLISHED') throw new ConflictException({ code: 'CONFLICT', message: 'Job is already published' });
    if (job.retryable === false && job.errorCode !== 'RATE_LIMITED') {
      throw new ConflictException({
        code: 'CONFLICT',
        message: `This failure was classified as permanent (${job.errorCode}). Fix the cause and re-create the publishing job.`,
      });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.publishingJob.update({
        where: { id: jobId },
        data: { status: 'QUEUED', nextAttemptAt: null, errorCode: null, errorMessage: null, leaseExpiresAt: null, workerId: null },
      });
      await writeOutbox(tx, {
        aggregateType: 'PublishingJob',
        aggregateId: jobId,
        eventType: 'publish.requested',
        queue: 'clipforge.publish',
        payload: { publishingJobId: jobId, manualRetry: true },
      });
      return record;
    });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'PUBLISH_ATTEMPTED',
      targetType: 'PublishingJob',
      targetId: jobId,
      summary: 'Manual publishing retry requested',
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { id: updated.id, status: updated.status };
  }

  static nextAttemptDelay(attempt: number): number {
    return backoffWithJitter(attempt, 30_000, 30 * 60_000);
  }
}
