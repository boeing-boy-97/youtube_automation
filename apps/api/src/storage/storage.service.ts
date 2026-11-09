import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { env } from '../common/env';

export interface StoredObject {
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface MultipartUploadSession {
  key: string;
  uploadId: string | null;
  driver: 'local' | 's3';
  parts: Array<{ partNumber: number; url: string }>;
  expiresInSeconds: number;
}

/**
 * Object storage abstraction.
 *
 * `STORAGE_DRIVER` is explicit (env). There is no driver fallback: if S3 is
 * selected but misconfigured the API refuses to start (see env.ts).
 *
 * - s3   : Cloudflare R2 / AWS S3 with presigned multipart uploads and public URLs.
 * - local: filesystem driver for non-production use. It exposes objects through
 *          the API's /media route; publishing eligibility refuses to run against
 *          it because Meta and YouTube require publicly reachable HTTPS media.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client | null;
  readonly driver: 'local' | 's3';

  constructor() {
    this.driver = env.STORAGE_DRIVER;
    this.s3 =
      this.driver === 's3'
        ? new S3Client({
            region: env.S3_REGION!,
            endpoint: env.S3_ENDPOINT,
            forcePathStyle: env.S3_FORCE_PATH_STYLE ?? false,
            credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
          })
        : null;
  }

  /** Rejects key traversal and absolute paths; keys are always workspace-scoped. */
  private assertSafeKey(key: string): void {
    if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Unsafe storage key: ${key}` });
    }
  }

  private localPath(key: string): string {
    this.assertSafeKey(key);
    const root = resolve(env.STORAGE_LOCAL_ROOT!);
    const full = resolve(join(root, normalize(key)));
    if (!full.startsWith(root + sep)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Storage key escapes storage root' });
    }
    return full;
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<StoredObject> {
    this.assertSafeKey(key);
    const info = await stat(filePath);
    if (this.driver === 's3') {
      await this.s3!.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET!,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: info.size,
          ContentType: contentType,
        }),
      );
    } else {
      const target = this.localPath(key);
      await mkdir(dirname(target), { recursive: true });
      await pipeline(createReadStream(filePath), createWriteStream(target));
    }
    return { key, sizeBytes: info.size, contentType };
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    this.assertSafeKey(key);
    if (this.driver === 's3') {
      await this.s3!.send(new PutObjectCommand({ Bucket: env.S3_BUCKET!, Key: key, Body: body, ContentType: contentType }));
    } else {
      const target = this.localPath(key);
      await mkdir(dirname(target), { recursive: true });
      await pipeline(Readable.from(body), createWriteStream(target));
    }
    return { key, sizeBytes: body.byteLength, contentType };
  }

  async getStream(key: string): Promise<{ stream: Readable; contentType?: string; contentLength?: number }> {
    this.assertSafeKey(key);
    if (this.driver === 's3') {
      const out = await this.s3!.send(new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }));
      return {
        stream: out.Body as Readable,
        contentType: out.ContentType,
        contentLength: out.ContentLength,
      };
    }
    const target = this.localPath(key);
    const info = await stat(target);
    return { stream: createReadStream(target), contentLength: info.size };
  }

  /** Downloads an object to a local temp path — required by FFmpeg and upload APIs. */
  async downloadToFile(key: string, destination: string): Promise<number> {
    const { stream } = await this.getStream(key);
    await mkdir(dirname(destination), { recursive: true });
    await pipeline(stream, createWriteStream(destination));
    return (await stat(destination)).size;
  }

  async exists(key: string): Promise<boolean> {
    try {
      if (this.driver === 's3') {
        await this.s3!.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }));
      } else {
        await stat(this.localPath(key));
      }
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    this.assertSafeKey(key);
    try {
      if (this.driver === 's3') {
        await this.s3!.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }));
      } else {
        await rm(this.localPath(key), { force: true });
      }
    } catch (error) {
      this.logger.warn(`Failed to delete ${key}: ${(error as Error).message}`);
    }
  }

  /**
   * Publicly reachable URL. Returns null when the active driver cannot provide
   * one — callers must treat that as a hard publishing blocker, not a fallback.
   */
  publicUrl(key: string): string | null {
    if (this.driver === 's3') {
      if (!env.S3_PUBLIC_BASE_URL) return null;
      return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
    }
    const base = env.STORAGE_LOCAL_PUBLIC_BASE_URL!;
    return `${base.replace(/\/$/, '')}/${key}`;
  }

  /**
   * Multipart upload session. For S3 this returns presigned part URLs so the
   * browser streams bytes straight to the bucket. For the local driver the
   * client posts parts to POST /api/sources/upload/part.
   */
  async createMultipartUpload(key: string, contentType: string, partCount: number): Promise<MultipartUploadSession> {
    this.assertSafeKey(key);
    if (this.driver === 's3') {
      const created = await this.s3!.send(
        new CreateMultipartUploadCommand({ Bucket: env.S3_BUCKET!, Key: key, ContentType: contentType }),
      );
      if (!created.UploadId) throw new Error('S3 did not return an UploadId');
      const parts = await Promise.all(
        Array.from({ length: partCount }, async (_, index) => ({
          partNumber: index + 1,
          url: await getSignedUrl(
            this.s3!,
            new UploadPartCommand({
              Bucket: env.S3_BUCKET!,
              Key: key,
              UploadId: created.UploadId!,
              PartNumber: index + 1,
            }),
            { expiresIn: 3600 },
          ),
        })),
      );
      return { key, uploadId: created.UploadId, driver: 's3', parts, expiresInSeconds: 3600 };
    }
    // Local driver: parts are appended by the API; the upload id is the storage key.
    return {
      key,
      uploadId: null,
      driver: 'local',
      parts: Array.from({ length: partCount }, (_, i) => ({
        partNumber: i + 1,
        url: `/api/sources/upload/part?key=${encodeURIComponent(key)}&partNumber=${i + 1}`,
      })),
      expiresInSeconds: 3600,
    };
  }

  async completeMultipartUpload(key: string, uploadId: string | null, parts: Array<{ partNumber: number; etag: string }>): Promise<void> {
    if (this.driver !== 's3') return;
    if (!uploadId) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Missing uploadId for S3 multipart completion' });
    await this.s3!.send(
      new CompleteMultipartUploadCommand({
        Bucket: env.S3_BUCKET!,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    if (this.driver !== 's3') return;
    await this.s3!.send(new AbortMultipartUploadCommand({ Bucket: env.S3_BUCKET!, Key: key, UploadId: uploadId }));
  }

  /** Local-driver helper: append a received part to the staging file. */
  async appendLocalPart(stagingPath: string, buffer: Buffer): Promise<number> {
    await mkdir(dirname(stagingPath), { recursive: true });
    await pipeline(Readable.from(buffer), createWriteStream(stagingPath, { flags: 'a' }));
    return (await stat(stagingPath)).size;
  }

  async expectPublicHttps(): Promise<{ ok: boolean; reason?: string }> {
    const probe = this.publicUrl('health/probe.mp4');
    if (!probe) return { ok: false, reason: 'No public base URL configured for the active storage driver' };
    if (!probe.startsWith('https://')) {
      return {
        ok: false,
        reason: `Storage public URL is "${probe}", but Instagram and YouTube require publicly reachable HTTPS media. Configure S3_PUBLIC_BASE_URL (or a public HTTPS origin) before enabling automatic publishing.`,
      };
    }
    return { ok: true };
  }
}
