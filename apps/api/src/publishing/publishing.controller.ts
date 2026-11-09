import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createPublishingJobSchema, paginationSchema, publishingToggleSchema } from '@clipforge/validation';
import { CurrentContext } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { PublishingService } from './publishing.service';

@ApiTags('publishing')
@Controller('api/publishing')
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Post('enable')
  @RateLimit({ limit: 20, windowSeconds: 60, scope: 'publishing-toggle' })
  @ApiOperation({ summary: 'Enable automatic publishing for a connected account (all preconditions must be explicit)' })
  async enable(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    const parsed = publishingToggleSchema.parse(body);
    return this.publishing.setEnabled({ ...parsed, enabled: true }, ctx);
  }

  @Post('disable')
  @RateLimit({ limit: 20, windowSeconds: 60, scope: 'publishing-toggle' })
  async disable(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    const parsed = publishingToggleSchema.parse(body);
    return this.publishing.setEnabled({ ...parsed, enabled: false }, ctx);
  }

  @Post('jobs')
  @RateLimit({ limit: 60, windowSeconds: 60, scope: 'publishing-jobs' })
  @ApiOperation({ summary: 'Create per-platform publishing jobs for a clip' })
  async create(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    const parsed = createPublishingJobSchema.parse(body);
    return this.publishing.createJobs(parsed, ctx);
  }

  @Get('jobs')
  list(@Query() query: unknown, @CurrentContext() ctx: RequestContext) {
    const parsed = paginationSchema.parse(query) as { page: number; pageSize: number };
    const status = (query as { status?: string }).status;
    return this.publishing.listJobs(ctx, { ...parsed, status });
  }

  @Get('history')
  history(@CurrentContext() ctx: RequestContext) {
    return this.publishing.history(ctx);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.publishing.retry(id, ctx);
  }
}
