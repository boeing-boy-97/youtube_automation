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
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Storage liveness probe endpoint' } });
  }

  private async streamKey(key: string, req: Request, res: Response) {
    if (this.storage.driver !== 'local') {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Streaming through the API is only available with the local storage driver; use the storage public URL',
      });
    }
    const { stream, contentLength } = await this.storage.getStream(key);
    const total = contentLength ?? 0;
    const range = req.headers.range;
    if (range && total > 0) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (!match) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Malformed Range header' });
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.status(416).setHeader('content-range', `bytes */${total}`).end();
        return;
      }
      res.status(206);
      res.setHeader('content-range', `bytes ${start}-${end}/${total}`);
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-length', String(end - start + 1));
      res.setHeader('content-type', 'video/mp4');
      stream.pipe(res);
      return;
    }
    res.setHeader('content-type', 'video/mp4');
    if (total) res.setHeader('content-length', String(total));
    res.setHeader('accept-ranges', 'bytes');
    stream.pipe(res);
  }
}
