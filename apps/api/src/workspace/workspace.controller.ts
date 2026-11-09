import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { brandProfileSchema, configurationWriteSchema, subtitlePresetSchema } from '@clipforge/validation';
import { CurrentContext } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { WorkspaceService } from './workspace.service';

const MAX_LOGO_BYTES = 8 * 1024 * 1024;
const MAX_BRANDING_VIDEO_BYTES = 64 * 1024 * 1024;

@ApiTags('workspace')
@Controller('api')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('configuration')
  @ApiOperation({ summary: 'Configuration values, required keys and what is still missing' })
  configuration(@CurrentContext() ctx: RequestContext) {
    return this.workspace.configuration(ctx);
  }

  @Put('configuration')
  @ApiOperation({ summary: 'Write configuration explicitly (setup wizard)' })
  async write(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    const parsed = configurationWriteSchema.parse(body);
    return this.workspace.writeConfiguration(parsed.entries, ctx);
  }

  @Post('brand-profiles')
  createBrand(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    return this.workspace.createBrandProfile(brandProfileSchema.parse(body), ctx);
  }

  @Get('brand-profiles/:id')
  brand(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.workspace.getBrandProfile(id, ctx);
  }

  /**
   * Branding assets (logo overlay, intro, outro) must be *uploadable*: the render pipeline reads
   * them from storage, so leaving only a raw `storageKey` field made the feature unusable in the UI.
   */
  @Post('brand-assets')
  @RateLimit({ limit: 20, windowSeconds: 60, scope: 'brand-asset-upload' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_BRANDING_VIDEO_BYTES, files: 1 },
    }),
  )
  @ApiOperation({ summary: 'Upload a brand asset (LOGO image, INTRO or OUTRO video) and return its storage key' })
  async brandAsset(
    @Query('kind') kind: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentContext() ctx: RequestContext,
  ) {
    if (!kind) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Query parameter "kind" is required' });
    if (!file?.buffer?.length) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Missing multipart field "file"' });
    return this.workspace.uploadBrandAsset(kind, file, ctx);
  }

  @Post('subtitle-presets')
  createPreset(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    return this.workspace.createSubtitlePreset(subtitlePresetSchema.parse(body), ctx);
  }

  @Get('activity')
  activity(@Query('limit') limit: string | undefined, @CurrentContext() ctx: RequestContext) {
    return this.workspace.activity(ctx, limit ? Number(limit) : 100);
  }
}
