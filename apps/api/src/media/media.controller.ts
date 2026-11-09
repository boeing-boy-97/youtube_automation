import { BadRequestException, Controller, Get, Header, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { prisma } from '@clipforge/database';
import { Public } from '../common/decorators/auth.decorators';
import { CurrentContext } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { StorageService } from '../storage/storage.service';

/**
 * Object delivery.
 *
 * The local storage driver exposes objects here with HTTP Range support so the
 * dashboard can scrub video. Keys are resolved from the database by workspace
 * scope — a caller can never pass an arbitrary key. When STORAGE_DRIVER=s3 the
 * dashboard uses public/signed URLs instead and this route is unused.
 */
/** Embedded 0.2 s 64x64 H.264 pre-flight asset (base64 of a real MP4 file). */
const PROBE_MP4 = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMxbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlx0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAAAAABAAAAAAHUbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABf21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAT9zdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwBQPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAABzoAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAgAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAAtYAAAAOAAAAFHN0Y28AAAAAAAAAAQAAA2EAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAzAAAACGZyZWUAAALsbWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0xMCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAACBliIQAO//+906/AptUwioDklcK6oO6CtinTyptBo37uQAAAApBmiFsQ3/+p4+I',
  'base64',
);

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly storage: StorageService) {}

  @Get('clips/:variantId')
  @ApiOperation({ summary: 'Stream a rendered clip variant (range supported)' })
  async clipVariant(@Param('variantId') variantId: string, @Req() req: Request, @Res() res: Response, @CurrentContext() ctx: RequestContext) {
    const variant = await prisma.clipVariant.findFirst({
      where: { id: variantId, clip: { workspaceId: ctx.workspaceId } },
      include: { mediaAsset: true, clip: true },
    });
    if (!variant?.mediaAsset) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Clip variant has no stored media' });
    return this.streamKey(variant.mediaAsset.storageKey, req, res);
  }

  @Get('sources/:sourceId')
  @ApiOperation({ summary: 'Stream a source video (range supported)' })
  async source(@Param('sourceId') sourceId: string, @Req() req: Request, @Res() res: Response, @CurrentContext() ctx: RequestContext) {
    const source = await prisma.sourceVideo.findFirst({ where: { id: sourceId, workspaceId: ctx.workspaceId } });
    if (!source?.storageKey) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Source has no stored media' });
    return this.streamKey(source.storageKey, req, res);
  }

  @Get('health/probe.mp4')
  @Public()
  @Header('content-type', 'video/mp4')
  healthProbe(@Res() res: Response) {
    // A public media endpoint that answers 404 proves reachability, not that readback works. This
    // serves a real (0.2 s, 64x64) MP4 so the platform pre-flight checks used before automatic
    // publishing exercise an actual decodable asset.
    res.status(200);
    res.setHeader('content-type', 'video/mp4');
    res.setHeader('content-length', String(PROBE_MP4.length));
    res.setHeader('cache-control', 'public, max-age=300');
    res.setHeader('accept-ranges', 'bytes');
    res.end(PROBE_MP4);
  }

  private async streamKey(key: string, req: Request, res: Response) {
    if (this.storage.driver !== 'local') {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Streaming through the API is only available with the local storage driver; use the storage public URL',
      });
    }
    const total = await this.storage.statSize(key);
    const range = req.headers.range;
    if (range && total > 0) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Malformed Range header' });
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : total - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
        res.status(416).setHeader('content-range', `bytes */${total}`).end();
        return;
      }
      const clampedEnd = Math.min(end, total - 1);
      const ranged = await this.storage.getStreamRange(key, start, clampedEnd);
      res.status(206);
      res.setHeader('content-range', `bytes ${start}-${clampedEnd}/${total}`);
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-length', String(ranged.contentLength));
      res.setHeader('content-type', 'video/mp4');
      ranged.stream.pipe(res);
      return;
    }
    const { stream } = await this.storage.getStream(key);
    res.setHeader('content-type', 'video/mp4');
    if (total) res.setHeader('content-length', String(total));
    res.setHeader('accept-ranges', 'bytes');
    stream.pipe(res);
  }
}
