import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiOkResponse } from '@nestjs/swagger';
import { CurrentContext, Roles } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { DiagnosticsService } from './diagnostics.service';

/**
 * Diagnostics live in their own controller so the route table reads as two surfaces: `/api/system`
 * (health, queues, events) and `/api/system/diagnostics` (actionable findings).
 */
@ApiTags('system')
@Roles('OWNER', 'ADMIN')
@Controller('api/system')
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get('diagnostics')
  @ApiOperation({ summary: 'Actionable diagnostics: stuck work, outbox backlog, expiring tokens, disk' })
  @ApiOkResponse({ description: 'Findings ordered by severity with a recommended action each' })
  report(@CurrentContext() ctx: RequestContext) {
    return this.diagnostics.report(ctx.workspaceId);
  }
}
