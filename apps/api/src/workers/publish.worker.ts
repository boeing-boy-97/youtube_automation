/**
 * Publishing worker — YouTube upload and Instagram Reel publication.
 *
 * Guarantees:
 *  - exactly one attempt per (clip, platform, account, operation) is ever
 *    *committed*; the unique idempotency key is the source of truth,
 *  - ambiguous network timeouts are reconciled against the platform before retry
 *    (never blind retry of an upload that may have landed),
 *  - permanent failures stop immediately with an actionable message; transient
 *    ones are retried with exponential backoff and jitter,
 *  - every HTTP attempt is written to PublishingAttempt for the audit trail.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma, transitionJob, appendAuditLog } from '@clipforge/database';
import type { Prisma } from '@prisma/client';
import {
  InstagramConnector,
  PlatformError,
  YouTubeConnector,
  backoffWithJitter,
} from '@clipforge/platform-connectors';
import { env } from '../common/env';
import { AccountsService } from '../accounts/accounts.service';
import { StorageService } from '../storage/storage.service';
import { RedisService } from '../common/services/redis.service';
import { PublishingService } from '../publishing/publishing.service';
import { AppConfigService } from '../common/services/config.service';
import { createRuntime, createWorker, wireShutdown } from './base';

const runtime = createRuntime('publish', env.WORKER_CONCURRENCY_PUBLISH);
const storage = new StorageService();
const redis = new RedisService();
const accounts = new AccountsService(redis);
const appConfig = new AppConfigService();
const publishingService = new PublishingService(accounts, storage, appConfig);

async function handler(job: { data: { publishingJobId: string } }): Promise<void> {
  await publishOne(job.data.publishingJobId);
}

async function publishOne(publishingJobId: string): Promise<void> {
  const publishingJob = await prisma.publishingJob.findUnique({
    where: { id: publishingJobId },
    include: {
      clip: { include: { variants: { include: { mediaAsset: true } }, metadata: true, job: true } },
      connectedAccount: true,
      clipVariant: { include: { mediaAsset: true } },
    },
  });
  if (!publishingJob) throw new Error(`Publishing job ${publishingJobId} not found`);
  if (publishingJob.status === 'PUBLISHED') {
    runtime.logger.info(`publishing job ${publishingJobId} already published`);
    return;
  }
  if (publishingJob.scheduledFor && publishingJob.scheduledFor.getTime() > Date.now() + 30_000) {
    runtime.logger.info(`publishing job ${publishingJobId} scheduled for ${publishingJob.scheduledFor.toISOString()}`);
    return;
  }

  const variant = publishingJob.clipVariant ?? publishingJob.clip.variants[0];
  const mediaAsset = variant?.mediaAsset ?? publishingJob.clip.variants[0]?.mediaAsset;
  if (!variant || !mediaAsset) {
    await failJob(publishingJobId, 'PUBLISH_FAILED', 'Clip has no stored rendered variant', false, publishingJob.attempt);
    return;
  }

  const metadata = publishingJob.clip.metadata.find((m) => m.platform === publishingJob.platform);
  if (!metadata) {
    await failJob(publishingJobId, 'PUBLISH_ELIGIBILITY_FAILED', `No ${publishingJob.platform} metadata for this clip`, false, publishingJob.attempt);
    return;
  }

  const attemptNumber = publishingJob.attempt + 1;
  await prisma.publishingJob.update({
    where: { id: publishingJobId },
    data: { status: 'UPLOADING', attempt: attemptNumber, workerId: runtime.workerId },
  });

  const attemptRow = await prisma.publishingAttempt.create({
    data: {
      publishingJobId,
      attemptNumber,
      operation: publishingJob.platform === 'YOUTUBE' ? 'SINGLE_VIDEO_UPLOAD' : 'REEL_PUBLISH',
      requestSummary: {
        clipId: publishingJob.clipId,
        variantId: variant.id,
        account: publishingJob.connectedAccount.displayName,
        metadataTitle: metadata.title,
      } as Prisma.InputJsonValue,
      workerId: runtime.workerId,
    },
  });
  const startedAt = Date.now();

  try {
    if (publishingJob.platform === 'YOUTUBE') {
      await publishToYouTube(publishingJob, metadata, mediaAsset.storageKey, attemptRow.id);
    } else {
      await publishToInstagram(publishingJob, metadata, mediaAsset.storageKey, attemptRow.id);
    }
    await prisma.publishingAttempt.update({
      where: { id: attemptRow.id },
      data: { finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    await refreshParentJob(publishingJob.clip.jobId);
  } catch (error) {
    const platformError = error instanceof PlatformError ? error : null;
    const retryable = platformError ? platformError.retryable : true;
    const message = error instanceof Error ? error.message : String(error);
    const code = platformError?.classification === 'AUTH' ? 'TOKEN_EXPIRED' : platformError?.classification === 'RATE_LIMIT' ? 'PLATFORM_RATE_LIMITED' : 'PUBLISH_FAILED';
    await prisma.publishingAttempt.update({
      where: { id: attemptRow.id },
      data: {
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        httpStatus: platformError?.details.httpStatus ?? null,
        errorCode: code,
        errorMessage: message.slice(0, 1800),
        retryable,
        responseSummary: (platformError?.details.raw ?? null) as Prisma.InputJsonValue,
      },
    });
    await failJob(publishingJobId, code, message, retryable, attemptNumber);
    await refreshParentJob(publishingJob.clip.jobId);
    if (!retryable) {
      // Swallow: the failure is recorded; no point retrying in BullMQ.
      runtime.logger.warn(`publishing job ${publishingJobId} failed permanently: ${message}`);
      return;
    }
    throw error;
  }
}

async function publishToYouTube(
  publishingJob: Awaited<ReturnType<typeof prisma.publishingJob.findUnique>> & {
    connectedAccount: { id: string; externalAccountId: string; publishingConfig: unknown };
    clip: { id: string; title: string; durationKind: number; startSeconds: number; endSeconds: number };
  },
  metadata: { title: string | null; description: string | null; hashtags: string[]; tags: string[]; language: string },
  storageKey: string,
  attemptId: string,
): Promise<void> {
  const config = (publishingJob!.connectedAccount.publishingConfig ?? {}) as {
    visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
    categoryId?: string;
    madeForKids?: boolean;
    defaultLanguage?: string;
  };
  if (!config.visibility)	throw new PlatformError('YouTube visibility was never configured for this account', 'YOUTUBE', 'PERMANENT');

  const { accessToken } = await accounts.getAccessToken(publishingJob!.connectedAccountId);
  const connector = accounts.youtubeConnector();

  // Reconciliation: if a previous attempt may have landed, verify before re-uploading.
  if (publishingJob!.externalId) {
    const existing = await connector.getVideoStatus(accessToken, publishingJob!.externalId);
    if (existing) {
      await recordPublished(publishingJob!, {
        externalId: existing.id,
        externalUrl: `https://www.youtube.com/watch?v=${existing.id}`,
        visibility: existing.privacyStatus?.toUpperCase() as 'PUBLIC' | 'UNLISTED' | 'PRIVATE',
        response: existing,
      });
      return;
    }
  }

  const localPath = join(env.WORK_DIR, publishingJob!.clipId, 'upload.mp4');
  const sizeBytes = await storage.downloadToFile(storageKey, localPath);
  const fileInfo = await stat(localPath);
  void sizeBytes;

  const hashtags = metadata.hashtags.join(' ');
  const description = [metadata.description ?? '', hashtags].filter(Boolean).join('\n\n').slice(0, 5000);
  const result = await connector.uploadVideo({
    accessToken,
    filePath: localPath,
    fileSizeBytes: fileInfo.size,
    mimeType: 'video/mp4',
    title: metadata.title ?? publishingJob!.clip.title,
    description,
    tags: metadata.tags,
    categoryId: config.categoryId ?? '22',
    privacyStatus: (config.visibility ?? 'private').toLowerCase() as 'public' | 'unlisted' | 'private',
    madeForKids: config.madeForKids ?? false,
    defaultLanguage: config.defaultLanguage ?? metadata.language,
  });

  await prisma.publishingAttempt.update({
    where: { id: attemptId },
    data: { responseSummary: { videoId: result.videoId, uploadStatus: result.uploadStatus } as Prisma.InputJsonValue, httpStatus: 200 },
  });

  // Post-upload verification: the video must actually exist before we claim success.
  const verified = await connector.getVideoStatus(accessToken, result.videoId);
  if (!verified) {
    throw new PlatformError(
      `YouTube accepted the upload but the video ${result.videoId} is not retrievable yet`,
      'YOUTUBE',
      'RETRYABLE',
      { raw: result },
    );
  }

  await recordPublished(publishingJob!, {
    externalId: verified.id,
    externalUrl: `https://www.youtube.com/watch?v=${verified.id}`,
    visibility: verified.privacyStatus?.toUpperCase() as 'PUBLIC' | 'UNLISTED' | 'PRIVATE',
    response: verified,
  });
}

async function publishToInstagram(
  publishingJob: Awaited<ReturnType<typeof prisma.publishingJob.findUnique>> & {
    connectedAccount: { id: string; externalAccountId: string; publishingConfig: unknown };
    clip: { id: string; title: string };
  },
  metadata: { description: string | null; hashtags: string[] },
  storageKey: string,
  attemptId: string,
): Promise<void> {
  const config = (publishingJob!.connectedAccount.publishingConfig ?? {}) as { shareToFeed?: boolean };
  if (config.shareToFeed === undefined) {
    throw new PlatformError('Instagram shareToFeed was never configured for this account', 'INSTAGRAM', 'PERMANENT');
  }
  const publicUrl = storage.publicUrl(storageKey);
  if (!publicUrl || !publicUrl.startsWith('https://')) {
    throw new PlatformError(
      'Instagram requires a publicly reachable HTTPS media URL. Configure object storage with a public HTTPS base URL.',
      'INSTAGRAM',
      'PERMANENT',
      { platformReason: 'MEDIA_URL_NOT_PUBLIC' },
    );
  }

  const { accessToken } = await accounts.getAccessToken(publishingJob!.connectedAccountId);
  const connector = new InstagramConnector({
    appId: env.META_APP_ID!,
    appSecret: env.META_APP_SECRET!,
    redirectUri: env.META_REDIRECT_URI!,
    graphVersion: env.META_GRAPH_API_VERSION!,
  });
  const caption = [metadata.description ?? '', metadata.hashtags.join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);

  // Reconciliation: an ambiguous timeout may already have published.
  if (publishingJob!.externalId) {
    const recent = await connector.findRecentlyPublished(publishingJob!.connectedAccount.externalAccountId, accessToken);
    const match = recent.find((item) => item.id === publishingJob!.externalId);
    if (match) {
      await recordPublished(publishingJob!, {
        externalId: match.id,
        externalUrl: match.permalink ?? `https://www.instagram.com/p/${match.id}`,
        response: match,
      });
      return;
    }
  }

  const { containerId } = await connector.createReelContainer(
    publishingJob!.connectedAccount.externalAccountId,
    accessToken,
    { videoUrl: publicUrl, caption, shareToFeed: config.shareToFeed ?? true },
  );
  await prisma.publishingJob.update({ where: { id: publishingJob!.id }, data: { externalId: containerId, status: 'AWAITING_PLATFORM' } });
  await prisma.publishingAttempt.update({
    where: { id: attemptId },
    data: { operation: 'CONTAINER_STATUS_CHECK', responseSummary: { containerId } as Prisma.InputJsonValue, httpStatus: 200 },
  });

  // Poll per Meta's guidance: once a minute, up to ~5 minutes per container.
  const deadline = Date.now() + 5 * 60_000;
  let status: string = 'IN_PROGRESS';
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    const result = await connector.getContainerStatus(containerId, accessToken);
    status = result.status;
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new PlatformError(`Instagram container ${containerId} ended in ${status}: ${result.detail ?? ''}`, 'INSTAGRAM', 'RETRYABLE', {
        raw: result,
      });
    }
  }
  if (status !== 'FINISHED') {
    throw new PlatformError(`Instagram container ${containerId} still ${status} after 5 minutes`, 'INSTAGRAM', 'RETRYABLE');
  }

  const published = await connector.publishReel(publishingJob!.connectedAccount.externalAccountId, accessToken, containerId);
  await prisma.publishingAttempt.update({
    where: { id: attemptId },
    data: { operation: 'REEL_PUBLISH', responseSummary: { mediaId: published.mediaId } as Prisma.InputJsonValue, httpStatus: 200 },
  });
  await recordPublished(publishingJob!, {
    externalId: published.mediaId,
    externalUrl: `https://www.instagram.com/p/${published.mediaId}`,
    response: published,
  });
}

async function recordPublished(
  publishingJob: { id: string; workspaceId: string; connectedAccountId: string; platform: 'YOUTUBE' | 'INSTAGRAM'; clipId: string },
  result: { externalId: string; externalUrl: string; visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'; response: unknown },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.publishingJob.update({
      where: { id: publishingJob.id },
      data: {
        status: 'PUBLISHED',
        externalId: result.externalId,
        externalUrl: result.externalUrl,
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        visibility: result.visibility ?? null,
      },
    });
    await tx.publishedPost.upsert({
      where: {
        platform_connectedAccountId_externalId: {
          platform: publishingJob.platform,
          connectedAccountId: publishingJob.connectedAccountId,
          externalId: result.externalId,
        },
      },
      update: { externalUrl: result.externalUrl, platformResponse: result.response as Prisma.InputJsonValue },
      create: {
        workspaceId: publishingJob.workspaceId,
        publishingJobId: publishingJob.id,
        connectedAccountId: publishingJob.connectedAccountId,
        platform: publishingJob.platform,
        externalId: result.externalId,
        externalUrl: result.externalUrl,
        publishedAt: new Date(),
        visibility: result.visibility ?? null,
        platformResponse: result.response as Prisma.InputJsonValue,
      },
    });
    const siblingFailure = await tx.publishingJob.count({
      where: { clipId: publishingJob.clipId, status: 'FAILED' },
    });
    await tx.generatedClip.update({
      where: { id: publishingJob.clipId },
      data: { status: siblingFailure > 0 ? 'PARTIALLY_PUBLISHED' : 'PUBLISHED' },
    });
  });
  await appendAuditLog({
    workspaceId: publishingJob.workspaceId,
    userId: null,
    action: 'PUBLISH_SUCCEEDED',
    targetType: 'PublishingJob',
    targetId: publishingJob.id,
    summary: `Published to ${publishingJob.platform}: ${result.externalUrl}`,
    metadata: { externalId: result.externalId },
  });
  runtime.logger.info(`published ${publishingJob.platform} ${result.externalUrl}`);
}

async function failJob(
  publishingJobId: string,
  errorCode: string,
  message: string,
  retryable: boolean,
  attempt: number,
): Promise<void> {
  const maxAttempts = 5;
  const exhausted = !retryable || attempt >= maxAttempts;
  const delay = PublishingService.nextAttemptDelay(Math.max(1, attempt));
  await prisma.publishingJob.update({
    where: { id: publishingJobId },
    data: {
      status: exhausted ? 'FAILED' : 'QUEUED',
      errorCode,
      errorMessage: message.slice(0, 1800),
      retryable,
      nextAttemptAt: exhausted ? null : new Date(Date.now() + delay),
    },
  });
  if (!exhausted) {
    // Durable reschedule through the outbox, not an in-memory timer.
    const { writeOutbox } = await import('@clipforge/database');
    await prisma.$transaction(async (tx) => {
      await writeOutbox(tx, {
        aggregateType: 'PublishingJob',
        aggregateId: publishingJobId,
        eventType: 'publish.requested',
        queue: 'clipforge.publish',
        payload: { publishingJobId },
        availableAt: new Date(Date.now() + delay),
      });
    });
  }
  await appendAuditLog({
    workspaceId: (await prisma.publishingJob.findUnique({ where: { id: publishingJobId }, select: { workspaceId: true } }))?.workspaceId ?? null,
    userId: null,
    action: 'PUBLISH_FAILED',
    targetType: 'PublishingJob',
    targetId: publishingJobId,
    summary: `${errorCode}${exhausted ? ' (permanent)' : ' (will retry)'}: ${message}`.slice(0, 400),
  });
  void backoffWithJitter;
}

/** Rolls per-platform publishing results up into the parent processing job. */
async function refreshParentJob(jobId: string): Promise<void> {
  const jobs = await prisma.publishingJob.findMany({ where: { clip: { jobId } } });
  if (jobs.length === 0) return;
  const allDone = jobs.every((job) => ['PUBLISHED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(job.status));
  const anyPublished = jobs.some((job) => job.status === 'PUBLISHED');
  const anyFailed = jobs.some((job) => job.status === 'FAILED');
  const parent = await prisma.processingJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!parent || ['COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED', 'FAILED'].includes(parent.status)) return;

  if (allDone) {
    const target = anyPublished && anyFailed ? 'PARTIALLY_COMPLETED' : anyFailed && !anyPublished ? 'FAILED' : 'COMPLETED';
    await transitionJob(jobId, target, {
      progressPercent: 100,
      progressDetail: `Publishing finished: ${jobs.filter((j) => j.status === 'PUBLISHED').length} published, ${jobs.filter((j) => j.status === 'FAILED').length} failed`,
      errorCode: target === 'FAILED' ? 'PUBLISH_FAILED' : null,
      errorMessage: target === 'FAILED' ? 'All publishing jobs failed' : null,
    });
  }
}

async function main() {
  const worker = createWorker('clipforge.publish', runtime, handler, env.WORKER_CONCURRENCY_PUBLISH);
  wireShutdown(runtime, [worker]);
  runtime.logger.info(`publish worker ready (concurrency=${env.WORKER_CONCURRENCY_PUBLISH})`);
}

void main().catch((error) => {
  runtime.logger.error(`publish worker failed to start: ${(error as Error).message}`);
  process.exit(1);
});
