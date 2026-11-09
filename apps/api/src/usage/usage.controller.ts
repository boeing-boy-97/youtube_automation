import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { usageRecordsQuerySchema, usageSummaryQuerySchema } from '@clipforge/validation';
import { CurrentContext, Roles } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { UsageService } from './usage.service';

/**
 * Usage and cost reporting.
 *
 * Operator-only: spend per workspace is commercially sensitive and is not part of a member's job.
 * Every query is scoped to the caller's workspace — a workspace id is never accepted from the
 * client, so one tenant cannot read another's ledger.
 */
@ApiTags('usage')
@Roles('OWNER', 'ADMIN')
@Controller('api/usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Spend and volumes per usage kind for a window (default: last 30 days)' })
  summary(@Query() query: unknown, @CurrentContext() ctx: RequestContext) {
    return this.usage.summary(ctx.workspaceId, usageSummaryQuerySchema.parse(query ?? {}));
  }

  @Get('daily')
  @ApiOperation({ summary: 'Daily spend series for a window' })
  daily(@Query() query: unknown, @CurrentContext() ctx: RequestContext) {
    return this.usage.daily(ctx.workspaceId, usageSummaryQuerySchema.parse(query ?? {}));
  }

  @Get('records')
  @ApiOperation({ summary: 'Raw usage ledger, newest first' })
  records(@Query() query: unknown, @CurrentContext() ctx: RequestContext) {
    return this.usage.records(ctx.workspaceId, usageRecordsQuerySchema.parse(query ?? {}) as never);
  }
}
