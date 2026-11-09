import { Worker, Job, type WorkerOptions } from 'bullmq';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { env, loadEnv } from '../common/env';
import { workerLogger } from '../common/services/logger.service';
import { prisma, heartbeatJob, releaseJobLease } from '@clipforge/database';

export type WorkerRole = 'ai' | 'render' | 'publish' | 'scheduler' | 'recovery';

export interface WorkerRuntime {
  workerId: string;
  role: WorkerRole;
  logger: ReturnType<typeof workerLogger.child>;
  redis: Redis;
  heartbeatTimer: NodeJS.Timeout;
  stop: () => Promise<void>;
}

export const WORKER_ROLES: Record<WorkerRole, string> = {
  ai: 'worker:ai',
  render: 'worker:render',
  publish: 'worker:publish',
  scheduler: 'worker:scheduler',
  recovery: 'worker:recovery',
};

/**
 * Boots a long-lived worker process:
 *  - registers itself in Redis with a heartbeat so the admin dashboard shows real liveness
 *  - renews leases for the jobs it owns (so recovery can distinguish crash from slow)
 *  - handles SIGTERM/SIGINT by draining cleanly (no partial writes left dangling)
 */
export function createRuntime(role: WorkerRole, concurrency: number): WorkerRuntime {
  loadEnv();
  const workerId = `${role}-${process.env.HOSTNAME ?? 'host'}-${randomUUID().slice(0, 8)}`;
  const logger = workerLogger.child({ workerId, role });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const beat = async () => {
    await redis
      .set(
        `${env.REDIS_PREFIX}:worker:${workerId}`,
        JSON.stringify({ role: WORKER_ROLES[role], workerId, concurrency, updatedAt: new Date().toISOString() }),
        'EX',
        45,
      )
      .catch((error: Error) => logger.error(`heartbeat failed: ${error.message}`));
  };
  void beat();
  const heartbeatTimer = setInterval(() => void beat(), 15_000);

  const stop = async () => {
    clearInterval(heartbeatTimer);
    await redis.del(`${env.REDIS_PREFIX}:worker:${workerId}`).catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  };

  return { workerId, role, logger, redis, heartbeatTimer, stop };
}

/** Renews a job lease for the lifetime of the handler. */
export function startLeaseRenewal(jobId: string, workerId: string, logger: WorkerRuntime['logger']): () => void {
  const timer = setInterval(() => {
    void heartbeatJob(jobId, workerId, env.JOB_LEASE_SECONDS).catch((error: Error) =>
      logger.error(`lease renewal failed for job ${jobId}: ${error.message}`),
    );
  }, env.JOB_HEARTBEAT_SECONDS * 1000);
  return () => clearInterval(timer);
}

export function createWorker(
  queue: string,
  runtime: WorkerRuntime,
  handler: (job: Job, runtime: WorkerRuntime) => Promise<void>,
  concurrency: number,
): Worker {
  const worker = new Worker(
    queue,
    async (job) => {
      const started = Date.now();
      runtime.logger.info(`start ${queue}#${job.id} attempt=${job.attemptsMade + 1}`);
      try {
        await handler(job, runtime);
        runtime.logger.info(`done ${queue}#${job.id} in ${Date.now() - started}ms`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runtime.logger.error(`failed ${queue}#${job.id} after ${Date.now() - started}ms: ${message}`);
        throw error;
      }
    },
    {
      connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
      concurrency,
      prefix: env.REDIS_PREFIX,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    } satisfies WorkerOptions,
  );

  worker.on('failed', (job, error) => {
    runtime.logger.error(`bullmq failed event ${queue}#${job?.id}: ${error.message}`);
  });
  worker.on('error', (error) => runtime.logger.error(`worker error (${queue}): ${error.message}`));
  return worker;
}

/** Shared graceful-shutdown wiring for every worker entrypoint. */
export function wireShutdown(runtime: WorkerRuntime, workers: Worker[]): void {
  const shutdown = async (signal: string) => {
    runtime.logger.info(`${signal} received — draining`);
    await Promise.all(workers.map((worker) => worker.close().catch(() => undefined)));
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => runtime.logger.error(`unhandled rejection: ${String(reason)}`));
}

export async function releaseLeaseQuietly(jobId: string): Promise<void> {
  await releaseJobLease(jobId).catch(() => undefined);
}
