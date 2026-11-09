import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { claimOutboxBatch, markOutboxFailed, markOutboxPublished } from '@clipforge/database';
import { backoffWithJitter } from '@clipforge/platform-connectors';
import { env } from '../common/env';
import { RedisService } from '../common/services/redis.service';

export const QUEUE_NAMES = {
  PIPELINE: 'clipforge.pipeline',
  RENDER: 'clipforge.render',
  PUBLISH: 'clipforge.publish',
  SCHEDULE: 'clipforge.schedule',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 500 },
  removeOnFail: { age: 7 * 24 * 3_600, count: 2_000 },
};

/**
 * BullMQ queue registry + transactional-outbox relay.
 *
 * Business code never enqueues directly: it writes an OutboxEvent inside the
 * same transaction as the state change (see @clipforge/database). The relay
 * below is the only writer to Redis, and it uses the outbox row id as the
 * BullMQ job id so a relay retry cannot duplicate work.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();
  private relayTimer: NodeJS.Timeout | null = null;

  constructor(private readonly redis: RedisService) {}

  queue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const created = new Queue(name, {
      connection: this.redis.client,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
      prefix: env.REDIS_PREFIX,
    });
    this.queues.set(name, created);
    return created;
  }

  /** Drains the outbox into BullMQ. Idempotent; safe to run in multiple processes. */
  async relayOnce(batchSize = 25): Promise<{ published: number; failed: number }> {
    const events = await claimOutboxBatch(batchSize);
    let published = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await this.queue(event.queue as QueueName).add(event.eventType, event.payload, {
          jobId: event.id,
          ...DEFAULT_JOB_OPTIONS,
          ...(event.attempts > 0 ? { delay: backoffWithJitter(event.attempts, 1_000, 60_000) } : {}),
        });
        await markOutboxPublished(event.id);
        published += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Outbox relay failed for ${event.id}: ${message}`);
        await markOutboxFailed(event.id, message, backoffWithJitter(event.attempts + 1, 1_000, 60_000));
      }
    }
    if (published || failed) this.logger.log(`Outbox relay: ${published} published, ${failed} failed`);
    return { published, failed };
  }

  startRelay(intervalMs = 1_000): void {
    if (this.relayTimer) return;
    this.relayTimer = setInterval(() => {
      void this.relayOnce().catch((error: Error) => this.logger.error(`relay loop: ${error.message}`));
    }, intervalMs);
  }

  async stopRelay(): Promise<void> {
    if (this.relayTimer) clearInterval(this.relayTimer);
    this.relayTimer = null;
  }

  /** Queue depth snapshot for the admin dashboard — reads live Redis counts. */
  async depths(): Promise<Record<string, { waiting: number; active: number; delayed: number; failed: number; completed: number }>> {
    const result: Record<string, { waiting: number; active: number; delayed: number; failed: number; completed: number }> = {};
    for (const name of Object.values(QUEUE_NAMES)) {
      const counts = await this.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      result[name] = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      };
    }
    return result;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopRelay();
    for (const queue of this.queues.values()) await queue.close().catch(() => undefined);
  }
}
