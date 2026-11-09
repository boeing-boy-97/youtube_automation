import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ClipsController } from './clips.controller';
import { ClipsService } from './clips.service';

@Module({ controllers: [ClipsController], providers: [ClipsService, PrismaService], exports: [ClipsService] })
export class ClipsModule {}
