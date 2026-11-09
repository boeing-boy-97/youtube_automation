import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createJobSchema, jobListQuerySchema } from '@clipforge/validation';
import { CurrentContext } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { JobsService } from './jobs.service';

@ApiTags('processing')
@Controller('api/jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  @RateLimit({ limit: 10, windowSeconds: 60, scope: 'job-create' })
  @ApiOperation({ summary: 'Create a processing job (fails closed with 428 when configuration is missing)' })
  create(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    return this.jobs.create(createJobSchema.parse(body), ctx);
  }

  @Get()
  list(@Query() query: unknown, @CurrentContext() ctx: RequestContext) {
    return this.jobs.list(ctx, jobListQuerySchema.parse(query));
  }

  @Get(':id')
  detail(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.jobs.detail(id, ctx);
  }

  @Get(':id/events')
  events(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.jobs.events(id, ctx);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.jobs.cancel(id, ctx);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.jobs.retry(id, ctx);
  }
}
