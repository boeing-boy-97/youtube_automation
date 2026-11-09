import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

@Module({ controllers: [WorkspaceController], providers: [WorkspaceService, PrismaService], exports: [WorkspaceService] })
export class WorkspaceModule {}
