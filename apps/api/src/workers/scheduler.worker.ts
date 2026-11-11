/**
 * Scheduler worker — the only process allowed to talk to BullMQ for dispatch.
 *
 * Duties:
 *  1. drain the transactional outbox into BullMQ (1s cadence),
 *  2. refresh long-lived Instagram tokens that are close to expiry,
 *  3. record a health snapshot so the admin dashboard shows real history,
 *  4. apply configured retention policies (soft-delete + delete objects),
 *  5. clean up stale work directories.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma, decryptSecret, ConfigurationService } from '@clipforge/database';
import { InstagramConnector } from '@clipforge/platform-connectors';
import { CONFIG_KEYS } from '@clipforge/shared-types';
import { env } from '../common/env';
import { QueueService } from '../queues/queue.service';
import { RedisService } from '../common/services/redis.service';
import { SystemService } from '../system/system.service';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { createRuntime, wireShutdown } from './base';

const runtime = createRuntime('scheduler', 1);
const redis = new RedisService();
const queues = new QueueService(redis);
const storage = new StorageService();
const system = new SystemService(redis, queues, storage);
const notifications = new NotificationsService();

async function refreshInstagramTokens(): Promise<void> {
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_REDIRECT_URI || !env.META_GRAPH_API_VERSION) return;
  const connector = new InstagramConnector({
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
    redirectUri: env.META_REDIRECT_URI,
    graphVersion: env.META_GRAPH_API_VERSION,
  });
  const soon = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const accounts = await prisma.connectedAccount.findMany({
    where: { platform: 'INSTAGRAM', status: 'CONNECTED', credential: { expiresAt: { lt: soon } } },
    include: { credential: true },
  });
  for (const account of accounts) {
    if (!account.credential) continue;
    try {
      const current = decryptSecret(account.credential.accessTokenEnc);
      const refreshed = await connector.refreshLongLived(current);
      const { encryptSecret } = await import('@clipforge/database');
      await prisma.oAuthCredential.update({
        where: { connectedAccountId: account.id },
        data: {
          accessTokenEnc: encryptSecret(refreshed.accessToken) as unknown as object,
          expiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000),
          refreshedAt: new Date(),
        },
      });
      await prisma.connectedAccount.update({ where: { id: account.id }, data: { tokenHealth: 'VALID', tokenCheckedAt: new Date() } });
      runtime.logger.info(`refreshed Instagram token for account ${account.id}`);
    } catch (error) {
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { tokenHealth: 'EXPIRED', status: 'EXPIRED', lastError: (error as Error).message.slice(0, 500), tokenCheckedAt: new Date() },
      });
      runtime.logger.warn(`Instagram token refresh failed for ${account.id}: ${(error as Error).message}`);
      void notifications.notify({
        workspaceId: account.workspaceId,
        category: 'AUTH_EXPIRED',
        dedupeKey: `account:${account.id}:expired`,
        summary: 'The Instagram connection expired and could not be refreshed',
        details: [
          ['Account', account.displayName],
          ['Reason', (error as Error).message.slice(0, 300)],
        ],
      });
    }
  }
}

async function healthSnapshot(): Promise<void> {
  const readiness = await system.readiness();
  const components = [
    readiness.components.db,
    readiness.components.redis,
    readiness.components.storage,
    readiness.components.ai,
    readiness.components.vp,
    ...readiness.components.integration,
  ];
  await prisma.systemHealthEvent.createMany({
    data: components.map((component) => ({
      workspaceId: null,
      component: component.component,
      severity: component.status === 'down' ? 'CRITICAL' : component.status === 'degraded' || component.status === 'unconfigured' ? 'WARNING' : 'INFO',
      status: component.status,
      message: component.message.slice(0, 900),
      details: (component.details ?? undefined) as never,
    })),
  });
  // Keep 30 days of health history.
  await prisma.systemHealthEvent.deleteMany({ where: { observedAt: { lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } } });
}

async function applyRetention(): Promise<void> {
  const workspaces = await prisma.workspace.findMany({ where: { deletedAt: null }, select: { id: true } });
  for (const workspace of workspaces) {
    const resolved = await new ConfigurationService(workspace.id).load();
    const sourceDays = resolved.values.get(CONFIG_KEYS.RETENTION_SOURCE_DAYS) as number | undefined;
    const assetDays = resolved.values.get(CONFIG_KEYS.RETENTION_ASSET_DAYS) as number | undefined;
    if (sourceDays && sourceDays > 0) {
      const cutoff = new Date(Date.now() - sourceDays * 24 * 3600 * 1000);
      const stale = await prisma.sourceVideo.findMany({
        where: { workspaceId: workspace.id, createdAt: { lt: cutoff }, deletedAt: null, storageKey: { not: null } },
        take: 25,
      });
      for (const source of stale) {
        await storage.delete(source.storageKey!);
        await prisma.sourceVideo.update({ where: { id: source.id }, data: { deletedAt: new Date(), storageKey: null } });
        runtime.logger.info(`retention: deleted source ${source.id}`);
      }
    }
    if (assetDays && assetDays > 0) {
      const cutoff = new Date(Date.now() - assetDays * 24 * 3600 * 1000);
      const assets = await prisma.mediaAsset.findMany({
        where: { workspaceId: workspace.id, createdAt: { lt: cutoff }, deletedAt: null },
        take: 50,
      });
      for (const asset of assets) {
        await storage.delete(asset.storageKey);
        await prisma.mediaAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
      }
    }
  }
}

async function cleanWorkDirs(): Promise<void> {
  const entries = await readdir(env.WORK_DIR).catch(() => [] as string[]);
  const cutoff = Date.now() - 48 * 3600 * 1000;
  for (const entry of entries) {
    if (entry === 'uploads' || entry === 'imports') continue;
    const full = join(env.WORK_DIR, entry);
    const info = await stat(full).catch(() => null);
    if (info?.isDirectory() && info.mtimeMs < cutoff) {
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Scheduled publishing watch.
 *
 * Two distinct facts worth telling an operator about:
 *  - **started**: the moment passed and the job is still queued, i.e. the dispatcher will pick it up;
 *  - **missed**: the moment passed by a wide margin and the job is *still* PENDING/QUEUED, which
 *    means nothing is consuming the queue (workers down) or the upload keeps failing to start.
 *
 * Both are read from PublishingJob rows, never from a UI action.
 */
async function watchScheduledPublishing(): Promise<void> {
  const now = Date.now();
  const due = await prisma.publishingJob.findMany({
    where: {
      status: { in: ['PENDING', 'QUEUED'] },
      scheduledFor: { not: null, lte: new Date(now + 60_000) },
    },
    select: { id: true, workspaceId: true, platform: true, scheduledFor: true, clipId: true, status: true },
    take: 50,
  });
  for (const job of due) {
    const scheduledAt = job.scheduledFor!.getTime();
    const overdueMs = now - scheduledAt;
    if (overdueMs > 30 * 60_000) {
      void notifications.notify({
        workspaceId: job.workspaceId,
        category: 'SCHEDULE_MISSED',
        dedupeKey: `publish:${job.id}:missed`,
        summary: `Scheduled ${job.platform} publish is ${Math.round(overdueMs / 60_000)} min overdue`,
        details: [['Scheduled for', job.scheduledFor!.toISOString()], ['Still', job.status]],
        clipId: job.clipId,
      });
    } else if (overdueMs >= 0) {
      void notifications.notify({
        workspaceId: job.workspaceId,
        category: 'SCHEDULED_STARTED',
        dedupeKey: `publish:${job.id}:scheduled-started`,
        summary: `Scheduled ${job.platform} publish is due and queued for dispatch`,
        details: [['Scheduled for', job.scheduledFor!.toISOString()]],
        clipId: job.clipId,
      });
    }
  }
}

/** Local calendar date (YYYY-MM-DD) in a workspace's timezone, so "daily" means the operator's day. */
function localDateIn(timezone: string | null, date = new Date()): { date: string; hour: number } {
  const zone = timezone?.trim() || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
  } catch {
    return { date: date.toISOString().slice(0, 10), hour: date.getUTCHours() };
  }
}

/**
 * One message per workspace per local day, sent in the configured hour. The dedupe key is the
 * local date, so a restart inside the summary hour cannot send it twice.
 */
async function dailySummaries(): Promise<void> {
  const workspaces = await prisma.workspace.findMany({ where: { deletedAt: null }, select: { id: true, timezone: true } });
  for (const workspace of workspaces) {
    const settings = await notifications.settings(workspace.id);
    if (!settings.enabled || !settings.categories.includes('DAILY_SUMMARY')) continue;
    const { date, hour } = localDateIn(workspace.timezone);
    if (hour !== settings.dailySummaryHour) continue;
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [completed, failed, cancelled, clips, published] = await Promise.all([
      prisma.processingJob.count({ where: { workspaceId: workspace.id, status: 'COMPLETED', updatedAt: { gte: since } } }),
      prisma.processingJob.count({ where: { workspaceId: workspace.id, status: 'FAILED', updatedAt: { gte: since } } }),
      prisma.processingJob.count({ where: { workspaceId: workspace.id, status: 'CANCELLED', updatedAt: { gte: since } } }),
      prisma.generatedClip.count({ where: { workspaceId: workspace.id, createdAt: { gte: since } } }),
      prisma.publishedPost.count({ where: { workspaceId: workspace.id, publishedAt: { gte: since } } }),
    ]);
    void notifications.notify({
      workspaceId: workspace.id,
      category: 'DAILY_SUMMARY',
      dedupeKey: `daily:${date}`,
      summary: `Last 24 hours: ${completed} completed, ${failed} failed, ${published} published`,
      details: [
        ['Workflows completed', completed],
        ['Workflows failed', failed],
        ['Workflows stopped', cancelled],
        ['Clips created', clips],
        ['Posts published', published],
      ],
    });
  }
}

let tick = 0;
async function loop(): Promise<void> {
  await queues.relayOnce(50).catch((error: Error) => runtime.logger.error(`outbox relay: ${error.message}`));
  tick += 1;
  if (tick % 60 === 0) {
    await healthSnapshot().catch((error: Error) => runtime.logger.error(`health snapshot: ${error.message}`));
  }
  if (tick % 300 === 0) {
    await refreshInstagramTokens().catch((error: Error) => runtime.logger.error(`token refresh: ${error.message}`));
  }
  if (tick % 900 === 0) {
    await applyRetention().catch((error: Error) => runtime.logger.error(`retention: ${error.message}`));
    await cleanWorkDirs().catch((error: Error) => runtime.logger.error(`cleanup: ${error.message}`));
  }
  if (tick % 30 === 0) {
    await watchScheduledPublishing().catch((error: Error) => runtime.logger.error(`schedule watch: ${error.message}`));
  }
  if (tick % 600 === 0) {
    await dailySummaries().catch((error: Error) => runtime.logger.error(`daily summary: ${error.message}`));
    // Recover notifications a crash left half-sent. The scheduler is the process that always runs.
    await notifications.retryPending().catch((error: Error) => runtime.logger.error(`notification retry: ${error.message}`));
  }
}

async function main() {
  runtime.logger.info('scheduler worker starting (outbox relay + periodic maintenance)');
  // Anything the previous process left PENDING is retried before the first tick.
  await notifications.retryPending().catch((error: Error) => runtime.logger.error(`notification retry: ${error.message}`));
  setInterval(() => {
    void loop();
  }, 1_000);
  const shutdown = async () => {
    await queues.stopRelay();
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  wireShutdown(runtime, []);
}

void main();
