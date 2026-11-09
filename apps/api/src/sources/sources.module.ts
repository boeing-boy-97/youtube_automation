import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AppConfigService } from '../common/services/config.service';
import { MediaValidationService } from '../media/media-validation.service';
import { StorageModule } from '../storage/storage.module';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

@Module({
  imports: [StorageModule],
  controllers: [SourcesController],
  providers: [SourcesService, MediaValidationService, PrismaService, AppConfigService],
  exports: [SourcesService],
})
export class SourcesModule {}
