import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

@Module({ controllers: [UsageController], providers: [UsageService, PrismaService], exports: [UsageService] })
export class UsageModule {}
