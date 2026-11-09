import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentContext } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { SystemService } from './system.service';

@ApiTags('dashboard')
@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly system: SystemService) {}

  @Get('summary')
  summary(@CurrentContext() ctx: RequestContext) {
    return this.system.dashboard(ctx.workspaceId);
  }
}
