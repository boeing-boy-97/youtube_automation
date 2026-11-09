import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { PrismaService } from '../common/prisma.service';
import { AppConfigService } from '../common/services/config.service';
import { PublishingController } from './publishing.controller';
import { PublishingService } from './publishing.service';

@Module({
  imports: [AccountsModule],
  controllers: [PublishingController],
  providers: [PublishingService, PrismaService, AppConfigService],
  exports: [PublishingService],
})
export class PublishingModule {}
