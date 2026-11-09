import { BadRequestException, NotFoundException, Injectable } from '@nestjs/common';
import { appendAuditLog, prisma } from '@clipforge/database';
import type { updateClipMetadataSchema } from '@clipforge/validation';
import type { z } from 'zod';
import { StorageService } from '../storage/storage.service';
import type { RequestContext } from '../common/guards/session-auth.guard';

type MetadataPatch = z.infer<typeof updateClipMetadataSchema>;

@Injectable()
export class ClipsService {
  constructor(private readonly storage: StorageService) {}

  async list(ctx: RequestContext, query: { page: number; pageSize: number; jobId?: string; durationKind?: number; status?: string; platform?: string }) {
    const where = {
      workspaceId: ctx.workspaceId,
      ...(query.jobId ? { jobId: query.jobId } : {}),
      ...(query.durationKind ? { durationKind: query.durationKind } : {}),
      ...(query.status ? { status: query.status as never } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.generatedClip.findMany({
        where,
        orderBy: [{ qualityScore: 'desc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          variants: { include: { mediaAsset: true } },
          metadata: true,
          publishingJobs: { include: { connectedAccount: { select: { displayName: true, platform: true } } } },
          job: { select: { id: true, sourceVideoId: true } },
        },
      }),
      prisma.generatedClip.count({ where }),
    ]);
    return {
      items: items.map((clip) => this.toDto(clip, query.platform)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  private toDto(
    clip: {
      id: string;
      title: string;
      contentCategory: string;
      qualityScore: number;
      status: string;
      startSeconds: number;
      endSeconds: number;
      durationKind: number;
      jobId: string;
      createdAt: Date;
      variants: Array<{ id: string; width: number; height: number; fps: number; durationSeconds: number | null; sizeBytes: bigint | null; mediaAsset: { storageKey: string; mimeType: string } | null; renderReport: unknown; checksumSha256: string | null }>;
      metadata: Array<{ platform: string; title: string | null; description: string | null; hashtags: string[]; tags: string[]; reviewStatus: string }>;
      publishingJobs: Array<{ id: string; platform: string; status: string; externalUrl: string | null; externalId: string | null; errorMessage: string | null; connectedAccount: { displayName: string } }>;
    },
    platformFilter?: string,
  ) {
    const hasPublicStorage = this.storage.driver === 's3';
    return {
      id: clip.id,
      title: clip.title,
      contentCategory: clip.contentCategory,
      qualityScore: clip.qualityScore,
      status: clip.status,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      durationKind: clip.durationKind,
      jobId: clip.jobId,
      createdAt: clip.createdAt.toISOString(),
      variants: clip.variants.map((variant) => ({
        id: variant.id,
        width: variant.width,
        height: variant.height,
        fps: variant.fps,
        durationSeconds: variant.durationSeconds,
        sizeBytes: variant.sizeBytes ? Number(variant.sizeBytes) : null,
        checksum: variant.checksumSha256,
        renderReport: variant.renderReport,
        previewUrl: variant.mediaAsset
          ? hasPublicStorage
            ? this.storage.publicUrl(variant.mediaAsset.storageKey)
            : `/media/clips/${variant.id}`
          : null,
        downloadUrl: variant.mediaAsset
          ? hasPublicStorage
            ? this.storage.publicUrl(variant.mediaAsset.storageKey)
            : `/media/clips/${variant.id}?download=1`
          : null,
      })),
      metadata: clip.metadata
        .filter((m) => !platformFilter || m.platform === platformFilter)
        .map((m) => ({
          platform: m.platform,
          title: m.title,
          description: m.description,
          hashtags: m.hashtags,
          tags: m.tags,
          reviewStatus: m.reviewStatus,
        })),
      publishing: clip.publishingJobs.map((job) => ({
        id: job.id,
        platform: job.platform,
        status: job.status,
        externalId: job.externalId,
        externalUrl: job.externalUrl,
        errorMessage: job.errorMessage,
        account: job.connectedAccount.displayName,
      })),
    };
  }

  async get(id: string, ctx: RequestContext) {
    const clip = await prisma.generatedClip.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: {
        variants: { include: { mediaAsset: true } },
        metadata: true,
        publishingJobs: { include: { connectedAccount: { select: { displayName: true, platform: true } }, attempts: true } },
        candidate: true,
        job: { include: { sourceVideo: true } },
      },
    });
    if (!clip) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Clip not found' });
    return {
      ...this.toDto(clip as never),
      candidate: clip.candidate
        ? {
            hook: clip.candidate.hook,
            reason: clip.candidate.reason,
            transcript: clip.candidate.transcriptText,
            visualContext: clip.candidate.visualContext,
            scores: clip.candidate.scores,
            confidence: clip.candidate.confidence,
          }
        : null,
      source: {
        id: clip.job.sourceVideo.id,
        fileName: clip.job.sourceVideo.originalFileName,
        durationSeconds: clip.job.sourceVideo.durationSeconds,
        youTubeReferenceUrl: clip.job.sourceVideo.youTubeReferenceUrl,
      },
      publishingDetail: clip.publishingJobs.map((job) => ({
        id: job.id,
        platform: job.platform,
        status: job.status,
        externalId: job.externalId,
        externalUrl: job.externalUrl,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        retryable: job.retryable,
        attempts: job.attempts.map((a) => ({
          attemptNumber: a.attemptNumber,
          operation: a.operation,
          httpStatus: a.httpStatus,
          errorCode: a.errorCode,
          errorMessage: a.errorMessage,
          startedAt: a.startedAt.toISOString(),
          durationMs: a.durationMs,
        })),
      })),
    };
  }

  async updateMetadata(id: string, patch: MetadataPatch, ctx: RequestContext) {
    const clip = await prisma.generatedClip.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!clip) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Clip not found' });
    const published = await prisma.publishingJob.findFirst({
      where: { clipId: id, platform: patch.platform, status: 'PUBLISHED' },
    });
    if (published) {
      throw new BadRequestException({
        code: 'CONFLICT',
        message: 'Metadata cannot change after a successful publish; edit it on the platform itself.',
      });
    }
    const updated = await prisma.clipMetadata.update({
      where: { clipId_platform: { clipId: id, platform: patch.platform } },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.hashtags !== undefined ? { hashtags: patch.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)) } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        reviewStatus: 'APPROVED',
      },
    });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'CLIP_METADATA_EDITED',
      targetType: 'GeneratedClip',
      targetId: id,
      summary: `Metadata updated for ${patch.platform}`,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }

  /** Records an explicit download intent in the audit trail. */
  async registerDownload(id: string, ctx: RequestContext) {
    const clip = await prisma.generatedClip.findFirst({ where: { id, workspaceId: ctx.workspaceId }, include: { variants: { include: { mediaAsset: true } } } });
    if (!clip) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Clip not found' });
    const variant = clip.variants[0];
    if (!variant?.mediaAsset) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Clip has no rendered media' });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'CLIP_METADATA_EDITED',
      targetType: 'GeneratedClip',
      targetId: id,
      summary: 'Clip download requested',
      ipAddress: ctx.ip,
    });
    return {
      url: this.storage.driver === 's3' ? this.storage.publicUrl(variant.mediaAsset.storageKey) : `/media/clips/${variant.id}?download=1`,
      fileName: `${clip.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${clip.durationKind}s.mp4`,
    };
  }
}
