import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { DashboardController } from './dashboard.controller';

@Module({ controllers: [SystemController, DashboardController], providers: [SystemService, PrismaService], exports: [SystemService] })
export class SystemModule {}
