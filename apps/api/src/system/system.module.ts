import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { DashboardController } from './dashboard.controller';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';

@Module({
  controllers: [SystemController, DashboardController, DiagnosticsController],
  providers: [SystemService, DiagnosticsService, PrismaService],
  exports: [SystemService],
})
export class SystemModule {}
