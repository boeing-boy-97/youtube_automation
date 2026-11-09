import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentContext, Public } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { SystemService } from './system.service';

@ApiTags('system')
@Controller('api/system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Liveness: API, PostgreSQL and Redis' })
  health() {
    return this.system.health();
  }

  @Get('readiness')
  @Public()
  @ApiOperation({ summary: 'Readiness: every dependency plus integration configuration status' })
  readiness() {
    return this.system.readiness();
  }

  @Get('worker-status')
  workerStatus() {
    return this.system.workers();
  }

  @Get('queue-status')
  queueStatus(@CurrentContext() ctx: RequestContext) {
    void ctx;
    return this.system.systemOverview(ctx.workspaceId).then((o) => o.queues);
  }

  @Get('overview')
  overview(@CurrentContext() ctx: RequestContext) {
    return this.system.systemOverview(ctx.workspaceId);
  }

  @Get('events')
  events(@CurrentContext() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.system.systemEvents(ctx.workspaceId, limit ? Number(limit) : 50);
  }
}
