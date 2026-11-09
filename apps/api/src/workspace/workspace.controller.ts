import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { brandProfileSchema, configurationWriteSchema, subtitlePresetSchema } from '@clipforge/validation';
import { CurrentContext } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { WorkspaceService } from './workspace.service';

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

  @Post('subtitle-presets')
  createPreset(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    return this.workspace.createSubtitlePreset(subtitlePresetSchema.parse(body), ctx);
  }

  @Get('activity')
  activity(@Query('limit') limit: string | undefined, @CurrentContext() ctx: RequestContext) {
    return this.workspace.activity(ctx, limit ? Number(limit) : 100);
  }
}
