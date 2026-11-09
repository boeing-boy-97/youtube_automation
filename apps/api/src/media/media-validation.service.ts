import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ProbeResult } from '@clipforge/shared-types';
import { env } from '../common/env';

export interface ValidationReport {
  passed: boolean;
  issues: string[];
  detectedMimeType: string | null;
  extension: string;
  probe: ProbeResult | null;
  sizeBytes: number;
}

const SIGNATURES: Array<{ mime: string; test: (buf: Buffer) => boolean; label: string }> = [
  {
    mime: 'video/mp4',
    label: 'MP4/MOV (ISO BMFF ftyp box)',
    test: (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp',
  },
  {
    mime: 'video/quicktime',
    label: 'QuickTime (moov/mdat atom)',
    test: (b) => b.length > 12 && (b.toString('ascii', 4, 8).startsWith('moov') || b.toString('ascii', 4, 8).startsWith('mdat') || b.toString('ascii', 4, 8) === 'ftyp'),
  },
  {
    mime: 'video/webm',
    label: 'Matroska/WebM (EBML header)',
    test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  },
];

export const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];

/** FFprobe-backed media validation. Never trusts the declared MIME type alone. */
@Injectable()
export class MediaValidationService {
  private readonly logger = new Logger(MediaValidationService.name);

  async sniffFile(filePath: string): Promise<{ mime: string | null; label: string | null }> {
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(64);
      await handle.read(buffer, 0, 64, 0);
      const match = SIGNATURES.find((s) => s.test(buffer));
      return match ? { mime: match.mime, label: match.label } : { mime: null, label: null };
    } finally {
      await handle.close();
    }
  }

  /** Calls the video-processor's real ffprobe wrapper. */
  async probe(filePath: string, apiKey = env.VIDEO_PROCESSOR_API_KEY): Promise<ProbeResult> {
    const response = await fetch(`${env.VIDEO_PROCESSOR_URL}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ path: filePath }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new BadRequestException({
        code: 'MEDIA_VALIDATION_FAILED',
        message: `ffprobe could not read the file: ${text.slice(0, 400)}`,
      });
    }
    return (await response.json()) as ProbeResult;
  }

  async validate(input: {
    filePath: string;
    originalFileName: string;
    declaredMimeType: string | null;
    sizeBytes: number;
    maxFileSizeBytes: number;
    maxDurationSeconds: number;
  }): Promise<ValidationReport> {
    const issues: string[] = [];
    const extension = extname(input.originalFileName || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      issues.push(`Extension "${extension || '(none)'}" is not allowed (${ALLOWED_EXTENSIONS.join(', ')})`);
    }
    if (input.sizeBytes > input.maxFileSizeBytes) {
      issues.push(`File is ${input.sizeBytes} bytes, above the configured limit of ${input.maxFileSizeBytes}`);
    }

    const sniffed = await this.sniffFile(input.filePath);
    if (!sniffed.mime) {
      issues.push('File signature does not match any supported video container (MP4/MOV/WebM/MKV)');
    } else if (input.declaredMimeType && !isMimeCompatible(input.declaredMimeType, sniffed.mime)) {
      issues.push(`Declared MIME type ${input.declaredMimeType} contradicts the file signature (${sniffed.label})`);
    }

    let probe: ProbeResult | null = null;
    if (issues.length === 0) {
      try {
        probe = await this.probe(input.filePath);
      } catch (error) {
        issues.push((error as Error).message);
      }
    }

    if (probe) {
      if (!probe.video_codec) issues.push('No video stream found');
      if (!probe.audio_codec) issues.push('No audio stream found — transcription requires audio');
      if (!(probe.duration_seconds > 0)) issues.push('Reported duration is zero');
      if (probe.duration_seconds > input.maxDurationSeconds) {
        issues.push(`Duration ${probe.duration_seconds.toFixed(1)}s exceeds the configured maximum of ${input.maxDurationSeconds}s`);
      }
    }

    return {
      passed: issues.length === 0,
      issues,
      detectedMimeType: sniffed.mime,
      extension,
      probe,
      sizeBytes: input.sizeBytes,
    };
  }
}

function isMimeCompatible(declared: string, detected: string): boolean {
  if (declared === detected) return true;
  const isoBmff = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v']);
  if (isoBmff.has(declared) && (detected === 'video/mp4' || detected === 'video/quicktime')) return true;
  if (detected === 'video/webm' && (declared === 'video/webm' || declared === 'video/x-matroska')) return true;
  return false;
}
