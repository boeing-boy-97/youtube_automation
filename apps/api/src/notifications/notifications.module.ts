import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * The service is exported because other modules (auth, accounts, jobs) inject it to emit events.
 * It is a singleton per process: the bot identity probe cache and the in-flight delivery set are
 * intentionally process-local.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
