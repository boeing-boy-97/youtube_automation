import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { prisma, appendAuditLog } from '@clipforge/database';
import { parseYouTubeVideoId, isYouTubeUrl } from '@clipforge/validation';
import type { ImportUrlInput, InitiateUploadInput } from '@clipforge/validation';
import { env } from '../common/env';
import { AppConfigService } from '../common/services/config.service';
import { MediaValidationService } from '../media/media-validation.service';
import { downloadUrlToFile } from '../media/ssrf-guard';
import { StorageService } from '../storage/storage.service';
import type { RequestContext } from '../common/guards/session-auth.guard';

/** Declared to the browser at upload initiation; the browser is not allowed to pick its own. */
const PART_SIZE_BYTES = env.UPLOAD_PART_SIZE_MIB * 1024 * 1024;

export interface InitiateResult {
  sourceVideoId: string;
  storageKey: string;
  driver: 'local' | 's3';
  partSizeBytes: number;
  parts: Array<{ partNumber: number; url: string }>;
  uploadId: string | null;
  maxFileSizeBytes: number;
}

@Injectable()
export class SourcesService {
  private readonly logger = new Logger(SourcesService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly media: MediaValidationService,
    private readonly config: AppConfigService,
  ) {}

  private sourceKey(workspaceId: string, sourceId: string, fileName: string): string {
    const ext = (fileName.match(/\.[A-Za-z0-9]{1,6}$/)?.[0] ?? '.mp4').toLowerCase();
    return `ws/${workspaceId}/sources/${sourceId}/original${ext}`;
  }

  private stagingPath(sourceId: string): string {
    return join(env.WORK_DIR, 'uploads', `${sourceId}.part`);
  }

  async initiate(input: InitiateUploadInput, ctx: RequestContext): Promise<InitiateResult> {
    const configuration = await this.config.resolveForProcessing(ctx.workspaceId);
    if (input.sizeBytes > configuration.maxFileSizeBytes) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `File is ${input.sizeBytes} bytes; the configured maximum is ${configuration.maxFileSizeBytes} bytes`,
      });
    }
    if (input.youTubeReferenceUrl && !isYouTubeUrl(input.youTubeReferenceUrl)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Reference URL must be a YouTube URL' });
    }

    const source = await prisma.sourceVideo.create({
      data: {
        workspaceId: ctx.workspaceId,
        createdById: ctx.userId,
        kind: 'UPLOAD',
        status: 'INITIATED',
        originalFileName: input.fileName,
        declaredMimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        youTubeReferenceUrl: input.youTubeReferenceUrl ?? null,
        youTubeReferenceId: input.youTubeReferenceUrl ? parseYouTubeVideoId(input.youTubeReferenceUrl) : null,
      },
    });

    const key = this.sourceKey(ctx.workspaceId, source.id, input.fileName);
    const partCount = Math.max(1, Math.ceil(input.sizeBytes / PART_SIZE_BYTES));
    const session = await this.storage.createMultipartUpload(key, input.mimeType, partCount);

    await prisma.sourceVideo.update({ where: { id: source.id }, data: { storageKey: key } });
    await mkdir(dirname(this.stagingPath(source.id)), { recursive: true });

    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'SOURCE_UPLOADED',
      targetType: 'SourceVideo',
      targetId: source.id,
      summary: `Upload initiated for ${input.fileName} (${input.sizeBytes} bytes, ${partCount} part(s), driver=${session.driver})`,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return {
      sourceVideoId: source.id,
      storageKey: key,
      driver: session.driver,
      partSizeBytes: PART_SIZE_BYTES,
      parts: session.parts,
      uploadId: session.uploadId,
      maxFileSizeBytes: configuration.maxFileSizeBytes,
    };
  }

  /**
   * Local driver only: store one part at its deterministic offset.
   *
   * The part number is authoritative, so retries and out-of-order delivery are harmless. The
   * declared filename size is enforced against the bytes actually written, which stops a client
   * from declaring a small file and then streaming an unbounded amount to disk.
   */
  async receivePart(
    sourceVideoId: string,
    partNumber: number,
    buffer: Buffer,
    ctx: RequestContext,
  ): Promise<{ receivedBytes: number; declaredBytes: number; partNumber: number }> {
    if (this.storage.driver !== 'local') {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Part uploads are only used with the local storage driver' });
    }
    const source = await prisma.sourceVideo.findFirst({ where: { id: sourceVideoId, workspaceId: ctx.workspaceId } });
    if (!source) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Source not found' });
    if (source.status !== 'INITIATED') throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Upload is already ${source.status}` });
    if (!Number.isInteger(partNumber) || partNumber < 1) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'partNumber must be >= 1' });
    if (!source.sizeBytes) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Upload has no declared size' });

    const declaredBytes = Number(source.sizeBytes);
    const partCount = Math.max(1, Math.ceil(declaredBytes / PART_SIZE_BYTES));
    if (partNumber > partCount) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `partNumber ${partNumber} exceeds the ${partCount} part(s) declared for a ${declaredBytes}-byte upload`,
      });
    }

    const offset = (partNumber - 1) * PART_SIZE_BYTES;
    if (offset + buffer.length > declaredBytes) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `Part ${partNumber} would write ${offset + buffer.length} bytes, above the declared ${declaredBytes} bytes`,
      });
    }

    const written = await this.storage.writeLocalPartAt(this.stagingPath(sourceVideoId), offset, buffer);
    if (written > declaredBytes) {
      // Belt and braces: never leave more bytes on disk than the client declared.
      await rm(this.stagingPath(sourceVideoId), { force: true });
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `Staged upload grew to ${written} bytes, above the declared ${declaredBytes} bytes; upload discarded`,
      });
    }
    return { receivedBytes: written, declaredBytes, partNumber };
  }

  async completeUpload(
    sourceVideoId: string,
    rights: { accepted: true; statement: string },
    ctx: RequestContext,
    parts: Array<{ partNumber: number; etag: string }> = [],
    uploadId: string | null = null,
  ) {
    const source = await prisma.sourceVideo.findFirst({ where: { id: sourceVideoId, workspaceId: ctx.workspaceId } });
    if (!source) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Source not found' });
    if (source.status !== 'INITIATED') throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Upload is already ${source.status}` });
    if (!source.storageKey) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Source has no storage key' });

    const staging = this.stagingPath(sourceVideoId);
    let sizeBytes: number;
    let localPathForProbe: string;

    if (this.storage.driver === 'local') {
      const info = await stat(staging).catch(() => null);
      if (!info || info.size === 0) {
        throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'No uploaded bytes found for this source' });
      }
      const declared = source.sizeBytes ? Number(source.sizeBytes) : 0;
      if (declared > 0 && info.size !== declared) {
        // A missing part leaves a sparse hole, so only an exact size match proves completeness.
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Upload is incomplete: ${info.size} of ${declared} bytes were received. Retry the missing part(s).`,
        });
      }
      sizeBytes = info.size;
      localPathForProbe = staging;
    } else {
      await this.storage.completeMultipartUpload(source.storageKey, uploadId, parts);
      localPathForProbe = join(env.WORK_DIR, 'validation', `${sourceVideoId}.mp4`);
      await mkdir(dirname(localPathForProbe), { recursive: true });
      sizeBytes = await this.storage.downloadToFile(source.storageKey, localPathForProbe);
    }

    // Persist the rights declaration *before* validation so it is auditable even on rejection.
    await prisma.sourceVideo.update({
      where: { id: sourceVideoId },
      data: {
        rightsDeclaration: {
          accepted: true,
          acceptedAt: new Date().toISOString(),
          acceptedByUserId: ctx.userId,
          statement: rights.statement,
        },
      },
    });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'RIGHTS_DECLARED',
      targetType: 'SourceVideo',
      targetId: sourceVideoId,
      summary: 'Rights declaration accepted for source media',
      metadata: { statement: rights.statement },
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });

    const configuration = await this.config.resolveForProcessing(ctx.workspaceId);
    const report = await this.media.validate({
      filePath: localPathForProbe,
      originalFileName: source.originalFileName ?? 'upload.mp4',
      declaredMimeType: source.declaredMimeType,
      sizeBytes,
      maxFileSizeBytes: configuration.maxFileSizeBytes,
      maxDurationSeconds: configuration.maxDurationSeconds,
    });

    if (!report.passed) {
      await prisma.sourceVideo.update({
        where: { id: sourceVideoId },
        data: {
          status: 'REJECTED',
          rejectionReason: report.issues.join('; ').slice(0, 2000),
          validationReport: report as unknown as object,
          detectedMimeType: report.detectedMimeType,
        },
      });
      await rm(staging, { force: true });
      throw new BadRequestException({
        code: 'MEDIA_VALIDATION_FAILED',
        message: `Source rejected: ${report.issues.join('; ')}`,
        details: report.issues,
      });
    }

    if (this.storage.driver === 'local') {
      await this.storage.putFile(source.storageKey, staging, report.detectedMimeType ?? 'video/mp4');
      await rm(staging, { force: true });
    }

    const updated = await prisma.sourceVideo.update({
      where: { id: sourceVideoId },
      data: {
        status: 'VALIDATED',
        detectedMimeType: report.detectedMimeType,
        sizeBytes: BigInt(sizeBytes),
        probeResult: (report.probe ?? {}) as object,
        validationReport: report as unknown as object,
        durationSeconds: report.probe?.duration_seconds ?? null,
        width: report.probe?.width ?? null,
        height: report.probe?.height ?? null,
        frameRate: report.probe?.frame_rate ?? null,
      },
    });
    await prisma.usageRecord.create({
      data: {
        workspaceId: ctx.workspaceId,
        kind: 'storage_bytes',
        quantity: sizeBytes,
        unit: 'bytes',
        metadata: { sourceVideoId },
      },
    });
    return this.toDto(updated);
  }

  /** Authorized external media import (direct file URL) with SSRF + size guards. */
  async importFromUrl(input: ImportUrlInput, ctx: RequestContext) {
    const configuration = await this.config.resolveForProcessing(ctx.workspaceId);
    const source = await prisma.sourceVideo.create({
      data: {
        workspaceId: ctx.workspaceId,
        createdById: ctx.userId,
        kind: 'DIRECT_URL',
        status: 'INITIATED',
        sourceUrl: input.url,
        originalFileName: input.fileName ?? 'imported-video.mp4',
        youTubeReferenceUrl: input.youTubeReferenceUrl ?? null,
        youTubeReferenceId: input.youTubeReferenceUrl ? parseYouTubeVideoId(input.youTubeReferenceUrl) : null,
        rightsDeclaration: {
          accepted: true,
          acceptedAt: new Date().toISOString(),
          acceptedByUserId: ctx.userId,
          statement: input.rightsDeclaration.statement,
        },
      },
    });

    const tempPath = join(env.WORK_DIR, 'imports', `${source.id}.mp4`);
    await mkdir(dirname(tempPath), { recursive: true });

    try {
      const download = await downloadUrlToFile(input.url, tempPath, {
        maxBytes: configuration.maxFileSizeBytes,
        timeoutMs: 120_000,
        requireHttps: env.NODE_ENV === 'production',
      });
      const report = await this.media.validate({
        filePath: tempPath,
        originalFileName: input.fileName ?? 'imported-video.mp4',
        declaredMimeType: download.contentType,
        sizeBytes: download.sizeBytes,
        maxFileSizeBytes: configuration.maxFileSizeBytes,
        maxDurationSeconds: configuration.maxDurationSeconds,
      });
      if (!report.passed) {
        await prisma.sourceVideo.update({
          where: { id: source.id },
          data: { status: 'REJECTED', rejectionReason: report.issues.join('; ').slice(0, 2000), validationReport: report as unknown as object },
        });
        throw new BadRequestException({ code: 'MEDIA_VALIDATION_FAILED', message: `Source rejected: ${report.issues.join('; ')}`, details: report.issues });
      }

      const key = this.sourceKey(ctx.workspaceId, source.id, input.fileName ?? 'imported-video.mp4');
      await this.storage.putFile(key, tempPath, report.detectedMimeType ?? 'video/mp4');
      const updated = await prisma.sourceVideo.update({
        where: { id: source.id },
        data: {
          status: 'VALIDATED',
          storageKey: key,
          detectedMimeType: report.detectedMimeType,
          sizeBytes: BigInt(download.sizeBytes),
          probeResult: (report.probe ?? {}) as object,
          validationReport: report as unknown as object,
          durationSeconds: report.probe?.duration_seconds ?? null,
          width: report.probe?.width ?? null,
          height: report.probe?.height ?? null,
          frameRate: report.probe?.frame_rate ?? null,
        },
      });
      await appendAuditLog({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        action: 'SOURCE_UPLOADED',
        targetType: 'SourceVideo',
        targetId: source.id,
        summary: `Imported media from ${new URL(input.url).hostname} (${download.sizeBytes} bytes)`,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return this.toDto(updated);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  async list(ctx: RequestContext, query: { page: number; pageSize: number }) {
    const [items, total] = await Promise.all([
      prisma.sourceVideo.findMany({
        where: { workspaceId: ctx.workspaceId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.sourceVideo.count({ where: { workspaceId: ctx.workspaceId, deletedAt: null } }),
    ]);
    return { items: items.map((s) => this.toDto(s)), page: query.page, pageSize: query.pageSize, total };
  }

  async get(id: string, ctx: RequestContext) {
    const source = await prisma.sourceVideo.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null } });
    if (!source) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Source not found' });
    return this.toDto(source);
  }

  /** Resolves a source file to a local path for processing (downloads from storage if needed). */
  async materialize(sourceVideoId: string, workspaceId: string, destination: string): Promise<{ path: string; sizeBytes: number }> {
    const source = await prisma.sourceVideo.findFirst({ where: { id: sourceVideoId, workspaceId } });
    if (!source || !source.storageKey) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Source has no stored object' });
    const info = await stat(destination).catch(() => null);
    if (info && info.size > 0) return { path: destination, sizeBytes: info.size };
    const sizeBytes = await this.storage.downloadToFile(source.storageKey, destination);
    return { path: destination, sizeBytes };
  }

  assertOwnership(context: RequestContext, workspaceId: string): void {
    if (context.workspaceId !== workspaceId) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Resource belongs to another workspace' });
    }
  }

  private toDto(source: {
    id: string;
    kind: string;
    status: string;
    originalFileName: string | null;
    sizeBytes: bigint | null;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    frameRate: number | null;
    youTubeReferenceUrl: string | null;
    sourceUrl: string | null;
    rejectionReason: string | null;
    storageKey: string | null;
    probeResult: unknown;
    createdAt: Date;
  }) {
    return {
      id: source.id,
      kind: source.kind,
      status: source.status,
      originalFileName: source.originalFileName,
      sizeBytes: source.sizeBytes ? Number(source.sizeBytes) : null,
      durationSeconds: source.durationSeconds,
      width: source.width,
      height: source.height,
      frameRate: source.frameRate,
      youTubeReferenceUrl: source.youTubeReferenceUrl,
      sourceUrl: source.sourceUrl,
      rejectionReason: source.rejectionReason,
      // Never expose the raw storage key; hand out a media URL when one exists.
      mediaUrl: source.storageKey ? this.storage.publicUrl(source.storageKey) : null,
      probe: source.probeResult,
      createdAt: source.createdAt.toISOString(),
    };
  }
}
