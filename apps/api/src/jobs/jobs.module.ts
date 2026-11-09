import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AppConfigService } from '../common/services/config.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({ controllers: [JobsController], providers: [JobsService, PrismaService, AppConfigService], exports: [JobsService] })
export class JobsModule {}
