import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountsModule } from './accounts/accounts.module';
import { AuthModule } from './auth/auth.module';
import { ClipsModule } from './clips/clips.module';
import { CsrfGuard } from './common/guards/csrf.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { SessionAuthGuard } from './common/guards/session-auth.guard';
import { JobsModule } from './jobs/jobs.module';
import { MediaController } from './media/media.controller';
import { PublishingModule } from './publishing/publishing.module';
import { QueuesModule } from './queues/queues.module';
import { SourcesModule } from './sources/sources.module';
import { StorageModule } from './storage/storage.module';
import { SystemModule } from './system/system.module';
import { UsageModule } from './usage/usage.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaService } from './common/prisma.service';

@Module({
  imports: [
    AuthModule,
    StorageModule,
    QueuesModule,
    SourcesModule,
    JobsModule,
    ClipsModule,
    AccountsModule,
    PublishingModule,
    SystemModule,
    UsageModule,
    WorkspaceModule,
    NotificationsModule,
  ],
  controllers: [MediaController],
  providers: [
    PrismaService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}
