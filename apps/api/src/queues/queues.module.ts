import { Global, Module } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';
import { QueueService } from './queue.service';

@Global()
@Module({ providers: [RedisService, QueueService], exports: [RedisService, QueueService] })
export class QueuesModule {}
