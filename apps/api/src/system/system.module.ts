import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { DashboardController } from './dashboard.controller';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [SystemController, DashboardController, DiagnosticsController],
  providers: [SystemService, DiagnosticsService, PrismaService],
  exports: [SystemService],
})
export class SystemModule {}
