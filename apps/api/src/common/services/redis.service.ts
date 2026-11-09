import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../env';

/**
 * Redis is used for: rate limits, worker presence/heartbeats, queue metadata and
 * short-lived caches. It is never the source of truth for business state —
 * that lives in PostgreSQL.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  readonly subscriber: Redis;

  constructor() {
    const options = { maxRetriesPerRequest: null as null, enableReadyCheck: true, lazyConnect: false };
    this.client = new Redis(env.REDIS_URL, options);
    this.subscriber = new Redis(env.REDIS_URL, options);
  }

  key(...parts: string[]): string {
    return [env.REDIS_PREFIX, ...parts].join(':');
  }

  async hit(identifier: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number; resetSeconds: number }> {
    const key = this.key('ratelimit', identifier);
    const count = await this.client.incr(key);
    if (count === 1) await this.client.expire(key, windowSeconds);
    const ttl = await this.client.ttl(key);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSeconds: ttl < 0 ? windowSeconds : ttl };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
    await this.subscriber.quit().catch(() => undefined);
  }
}
