/**
 * Render worker — turns one planned clip into a real vertical MP4 with burned
 * subtitles, stores it, and advances the job once every clip is rendered.
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { prisma, transitionJob, writeOutbox, appendAuditLog, acquireJobLease, releaseJobLease } from '@clipforge/database';
import type { Prisma } from '@prisma/client';
import { env } from '../common/env';
import { sha256File } from '@clipforge/database';
import { AppConfigService } from '../common/services/config.service';
import { StorageService } from '../storage/storage.service';
import { createRuntime, createWorker, wireShutdown, startLeaseRenewal } from './base';
import { videoProcessor, ServiceCallError } from './services-client';

const runtime = createRuntime('render', env.WORKER_CONCURRENCY_RENDER);
const storage = new StorageService();
const appConfig = new AppConfigService();

interface JobConfig {
  framingMode: string;
  framingFallback: string;
  subtitlePresetId: string;
  manualOffsetX?: number;
  autoPublish: boolean;
  platforms: Array<'YOUTUBE' | 'INSTAGRAM'>;
  brandProfileId?: string;
}

async function handler(job: { data: { clipId: string; jobId: string } }): Promise<void> {
  const { clipId, jobId } = job.data;
  const leased = await acquireJobLease(jobId, runtime.workerId, env.JOB_LEASE_SECONDS);
  if (!leased) {
    runtime.logger.info(`job ${jobId} is owned by another worker — render skipped`);
    return;
  }
  const stopRenewal = startLeaseRenewal(jobId, runtime.workerId, runtime.logger);
  try {
    await renderClip(clipId, jobId);
  } finally {
    stopRenewal();
    await releaseJobLease(jobId).catch(() => undefined);
  }
}

async function renderClip(clipId: string, jobId: string): Promise<void> {
  const clip = await prisma.generatedClip.findUnique({
    where: { id: clipId },
    include: { job: { include: { sourceVideo: true } }, candidate: true, variants: true },
  });
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  if (clip.job.status === 'CANCELLED') {
    runtime.logger.info(`job ${jobId} cancelled — skipping clip ${clipId}`);
    return;
  }
  if (clip.status === 'READY' && clip.variants.length > 0) {
    await maybeAdvanceJob(jobId);
    return;
  }

  const configuration = clip.job.configuration as unknown as JobConfig;
  const liveConfig = await appConfig.resolveForProcessing(clip.workspaceId);
  const preset = await prisma.subtitlePreset.findFirst({
    where: { id: configuration.subtitlePresetId, OR: [{ workspaceId: clip.workspaceId }, { workspaceId: null }] },
  });
  if (!preset) {
    throw new Error(
      `Subtitle preset ${configuration.subtitlePresetId} no longer exists — configuration must be fixed before rendering`,
    );
  }

  const workDir = join(env.WORK_DIR, jobId);
  await mkdir(workDir, { recursive: true });
  const sourcePath = join(workDir, `source-${clip.job.sourceVideoId}.mp4`);
  await storage.downloadToFile(clip.job.sourceVideo.storageKey!, sourcePath);

  const transcript = await prisma.transcript.findFirst({
    where: { jobId, workspaceId: clip.workspaceId },
    include: { segments: { orderBy: { sequence: 'asc' } } },
  });
  if (!transcript) throw new Error('Transcript missing for rendering — cannot burn accurate subtitles');

  const words = transcript.segments
    .flatMap((segment) => segment.words as unknown as Array<{ word: string; start: number; end: number; probability: number }>)
    .filter((word) => word.end > clip.startSeconds && word.start < clip.endSeconds);
  if (words.length === 0) {
    await prisma.generatedClip.update({
      where: { id: clipId },
      data: { status: 'RENDER_FAILED' },
    });
    throw new Error(`Clip ${clipId} window contains no transcript words`);
  }

  // A job may select a brand profile explicitly; only fall back to the workspace default when the
  // job did not choose one. (Ignoring the selection silently applied the wrong branding.)
  const brandProfile = configuration.brandProfileId
    ? await prisma.brandProfile.findFirst({ where: { id: configuration.brandProfileId, workspaceId: clip.workspaceId } })
    : await prisma.brandProfile.findFirst({ where: { workspaceId: clip.workspaceId, isDefault: true } });
  if (configuration.brandProfileId && !brandProfile) {
    throw new Error(`Brand profile ${configuration.brandProfileId} no longer exists — fix the job configuration before rendering`);
  }
  let watermarkPath: string | null = null;
  if (brandProfile?.logoStorageKey) {
    watermarkPath = join(workDir, `logo-${brandProfile.id}`);
    await storage.downloadToFile(brandProfile.logoStorageKey, watermarkPath);
  }
  // Branding intro/outro are only applied when the operator enabled them and supplied an asset.
  // Background music has no configuration surface, so nothing is ever mixed in automatically.
  let introPath: string | null = null;
  if (brandProfile?.introEnabled && brandProfile.introAssetKey) {
    introPath = join(workDir, `intro-${brandProfile.id}`);
    await storage.downloadToFile(brandProfile.introAssetKey, introPath);
  }
  let outroPath: string | null = null;
  if (brandProfile?.outroEnabled && brandProfile.outroAssetKey) {
    outroPath = join(workDir, `outro-${brandProfile.id}`);
    await storage.downloadToFile(brandProfile.outroAssetKey, outroPath);
  }

  await prisma.generatedClip.update({ where: { id: clipId }, data: { status: 'RENDERING' } });

  const outputPath = join(workDir, `clip-${clipId}-${clip.durationKind}s.mp4`);
  const renderStarted = Date.now();
  const result = await videoProcessor.render({
    source_path: sourcePath,
    output_path: outputPath,
    start: clip.startSeconds,
    end: clip.endSeconds,
    words,
    subtitle_style: preset.style,
    output_width: liveConfig.renderWidth,
    output_height: liveConfig.renderHeight,
    fps: liveConfig.renderFps,
    bitrate_kbps: liveConfig.renderBitrateKbps,
    framing_mode: configuration.framingMode,
    framing_fallback: configuration.framingFallback,
    manual_offset_x: configuration.manualOffsetX,
    loudness_target_lufs: liveConfig.loudnessTargetLufs,
    watermark_path: watermarkPath,
    watermark_position: brandProfile?.watermarkPosition ?? null,
    intro_path: introPath,
    outro_path: outroPath,
  });

  const checksum = await sha256File(outputPath);
  const key = `ws/${clip.workspaceId}/clips/${clipId}/${clip.durationKind}s-${checksum.slice(0, 12)}.mp4`;
  const stored = await storage.putFile(key, outputPath, 'video/mp4');

  const asset = await prisma.mediaAsset.create({
    data: {
      workspaceId: clip.workspaceId,
      sourceVideoId: clip.job.sourceVideoId,
      kind: 'RENDERED_CLIP',
      storageKey: stored.key,
      mimeType: 'video/mp4',
      sizeBytes: BigInt(stored.sizeBytes),
      checksumSha256: checksum,
      durationSeconds: result.durationSeconds,
      metadata: { renderReport: result } as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.clipVariant.create({
    data: {
      clipId,
      mediaAssetId: asset.id,
      width: result.width,
      height: result.height,
      fps: Math.round(result.fps),
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      bitrateKbps: Math.round(result.bitrateKbps ?? 0),
      container: 'mp4',
      sizeBytes: BigInt(result.sizeBytes),
      durationSeconds: result.durationSeconds,
      renderProfile: {
        framingMode: configuration.framingMode,
        framingFallback: configuration.framingFallback,
        subtitlePresetId: preset.id,
        loudnessTargetLufs: liveConfig.loudnessTargetLufs,
      } as Prisma.InputJsonValue,
      renderReport: result as unknown as Prisma.InputJsonValue,
      checksumSha256: checksum,
    },
  });

  await prisma.generatedClip.update({ where: { id: clipId }, data: { status: 'READY' } });
  await prisma.usageRecord.create({
    data: {
      workspaceId: clip.workspaceId,
      jobId,
      kind: 'render_seconds',
      quantity: result.durationSeconds,
      unit: 'seconds',
      metadata: { clipId, elapsedMs: Date.now() - renderStarted },
    },
  });
  await appendAuditLog({
    workspaceId: clip.workspaceId,
    userId: clip.job.createdById,
    action: 'CLIP_RENDERED',
    targetType: 'GeneratedClip',
    targetId: clipId,
    summary: `Rendered ${clip.durationKind}s clip at ${result.width}x${result.height} (${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB)`,
    metadata: { framing: result.framing?.mode, fallbackUsed: result.framing?.fallbackUsed },
  });
  runtime.logger.info(`clip ${clipId} rendered ${result.width}x${result.height} ${result.durationSeconds}s`);

  await maybeAdvanceJob(jobId);
}

/**
 * When every clip of a job is rendered, advance VALIDATION → ASSET_STORAGE →
 * PUBLISHING_QUEUED and (if enabled) enqueue publishing jobs.
 */
async function maybeAdvanceJob(jobId: string): Promise<void> {
  const job = await prisma.processingJob.findUnique({
    where: { id: jobId },
    include: { clips: { include: { variants: true, metadata: true } } },
  });
  if (!job) return;
  if (['ASSET_STORAGE', 'PUBLISHING_QUEUED', 'PUBLISHING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED'].includes(job.status)) return;

  const pending = job.clips.filter((clip) => clip.status !== 'READY' && clip.status !== 'RENDER_FAILED');
  if (pending.length > 0) return;

  const ready = job.clips.filter((clip) => clip.status === 'READY' && clip.variants.length > 0);
  const failed = job.clips.filter((clip) => clip.status === 'RENDER_FAILED');

  if (ready.length === 0) {
    await transitionJob(jobId, 'FAILED', {
      errorCode: 'RENDER_FAILED',
      errorMessage: `All ${job.clips.length} clip(s) failed to render`,
      workerId: runtime.workerId,
    });
    return;
  }

  await transitionJob(jobId, 'VALIDATION', {
    progressPercent: 80,
    progressDetail: `Validated ${ready.length} rendered clip(s)`,
    workerId: runtime.workerId,
    leaseSeconds: env.JOB_LEASE_SECONDS,
  });
  await transitionJob(jobId, 'ASSET_STORAGE', {
    progressPercent: 88,
    progressDetail: `Stored ${ready.length} clip asset(s) in ${storage.driver} storage`,
    workerId: runtime.workerId,
    leaseSeconds: env.JOB_LEASE_SECONDS,
  });

  const configuration = job.configuration as unknown as JobConfig;
  const autoPublish = configuration.autoPublish && configuration.platforms.length > 0;

  if (!autoPublish) {
    await transitionJob(jobId, 'COMPLETED', {
      progressPercent: 100,
      progressDetail: `${ready.length} clip(s) ready${failed.length ? `, ${failed.length} failed` : ''}`,
      resultSummary: {
        clipsReady: ready.length,
        clipsFailed: failed.length,
        publishing: 'manual',
      } as Prisma.InputJsonValue,
      workerId: runtime.workerId,
    });
    return;
  }

  // Automatic publishing: create one job per platform per clip.
  const accounts = await prisma.connectedAccount.findMany({
    where: { workspaceId: job.workspaceId, platform: { in: configuration.platforms }, status: 'CONNECTED', publishingEnabled: true },
  });

  await prisma.$transaction(async (tx) => {
    for (const clip of ready) {
      for (const platform of configuration.platforms) {
        const account = accounts.find((candidate) => candidate.platform === platform);
        if (!account) continue;
        const operation = platform === 'YOUTUBE' ? 'SINGLE_VIDEO_UPLOAD' : 'REEL_PUBLISH';
        const idempotencyKey = `${clip.id}:${platform}:${account.id}:${operation}`;
        const existing = await tx.publishingJob.findUnique({ where: { idempotencyKey } });
        if (existing) continue;
        const record = await tx.publishingJob.create({
          data: {
            workspaceId: job.workspaceId,
            clipId: clip.id,
            clipVariantId: clip.variants[0]?.id ?? null,
            connectedAccountId: account.id,
            platform,
            operation,
            status: 'PENDING',
            idempotencyKey,
            visibility: platform === 'YOUTUBE' ? ((account.publishingConfig as { visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE' } | null)?.visibility ?? null) : null,
          },
        });
        await writeOutbox(tx, {
          aggregateType: 'PublishingJob',
          aggregateId: record.id,
          eventType: 'publish.requested',
          queue: 'clipforge.publish',
          payload: { publishingJobId: record.id },
        });
      }
    }
  });

  await transitionJob(jobId, 'PUBLISHING_QUEUED', {
    progressPercent: 92,
    progressDetail: `Publishing jobs queued for ${configuration.platforms.join(', ')}`,
    workerId: runtime.workerId,
    leaseSeconds: env.JOB_LEASE_SECONDS,
  });
  await transitionJob(jobId, 'PUBLISHING', {
    progressPercent: 95,
    progressDetail: 'Waiting for platform confirmation',
    workerId: runtime.workerId,
    leaseSeconds: env.JOB_LEASE_SECONDS,
  });
}

async function main() {
  const worker = createWorker('clipforge.render', runtime, handler, env.WORKER_CONCURRENCY_RENDER);
  wireShutdown(runtime, [worker]);
  runtime.logger.info(`render worker ready (concurrency=${env.WORKER_CONCURRENCY_RENDER})`);
}

void main().catch((error) => {
  runtime.logger.error(`render worker failed to start: ${(error as Error).message}`);
  process.exit(1);
});

void ServiceCallError;
