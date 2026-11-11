/**
 * Telegram notification delivery.
 *
 * Design constraints, in the order they shaped the code:
 *
 *  1. **A notification may never break the work it reports on.** `notify()` returns a status
 *     object and never throws. The pipeline worker calls it inside a stage; if Telegram is down,
 *     the stage still succeeds.
 *  2. **At-most-once.** Every event carries a `dedupeKey` ("job:<id>:started"). The delivery row is
 *     inserted *before* the HTTP call against a unique (workspaceId, dedupeKey), so a retried
 *     BullMQ job, a lease recovery or a process restart cannot send the same event twice.
 *  3. **Durable across restarts.** Attempts, errors and `nextAttemptAt` are database columns, not
 *     memory. `retryPending()` picks up whatever was interrupted.
 *  4. **Settings live in the database, the token lives in the environment.** The dashboard can
 *     toggle categories and set a chat id; nothing can read the bot token back out.
 *  5. **No simulation.** Every call site passes a fact taken from a committed database state
 *     (a job transition, a published post row), never from a UI action.
 */
import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { prisma, ConfigurationService } from '@clipforge/database';
import {
  CONFIG_KEYS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  type NotificationCategory,
  type NotificationDeliveryView,
  type NotificationSettings,
  type NotificationStatus,
} from '@clipforge/shared-types';
import { env } from '../common/env';
import { TelegramClient, TelegramApiError } from './telegram.client';
import { renderNotification, shortId } from './notification-format';

export interface NotifyInput {
  workspaceId: string;
  category: NotificationCategory;
  /**
   * Stable identity of the event. The same key never produces two messages.
   * Convention: `<aggregate>:<id>:<what-happened>`, e.g. `job:9f…:started`.
   */
  dedupeKey: string;
  /** One line stating the fact that just became true. */
  summary: string;
  details?: Array<[label: string, value: string | number | null | undefined]>;
  jobId?: string | null;
  clipId?: string | null;
  /** Milliseconds to wait for delivery when `await` is set. */
  await?: boolean;
}

export type NotifyOutcome = 'SENT' | 'FAILED' | 'SKIPPED_DISABLED' | 'SKIPPED_DUPLICATE' | 'NOT_CONFIGURED';

export interface NotifyResult {
  outcome: NotifyOutcome;
  deliveryId: string | null;
  detail: string | null;
}

interface BotProbeCache {
  at: number;
  reachable: boolean;
  username: string | null;
  error: string | null;
}

const BOT_PROBE_TTL_MS = 60_000;

/**
 * Injection token for a pre-built client.
 *
 * Production never provides it — the service builds its own client from the environment. Tests and
 * the workers pass one in, which is why the constructor takes an object rather than a bare client:
 * `new NotificationsService({ client })` works identically outside the Nest container.
 */
export const NOTIFICATION_CLIENT = 'CLIPFORGE_NOTIFICATION_CLIENT';

export interface NotificationClientOptions {
  client?: TelegramClient | null;
}
/** A pending row older than this is considered abandoned by a crash rather than in flight. */
const STALE_PENDING_MS = 2 * 60_000;

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger('Notifications');
  private readonly client: TelegramClient | null;
  private probeCache: BotProbeCache | null = null;
  /** Serialises delivery attempts per instance so a burst of events cannot fork the retry budget. */
  private readonly inFlight = new Set<string>();

  constructor(@Optional() @Inject(NOTIFICATION_CLIENT) options?: NotificationClientOptions) {
    this.client = options?.client ?? NotificationsService.buildClient();
  }

  /**
   * API process boot: retry whatever the previous process left PENDING. The scheduler does the same
   * for the worker fleet; doing it here too means a dashboard-only deployment still recovers.
   */
  onModuleInit(): void {
    void this.retryPending().catch((error: Error) => this.logger.warn(`startup retry failed: ${error.message}`));
  }

  /** Null when no token is configured — every call site handles that as "not configured", not as an error. */
  private static buildClient(): TelegramClient | null {
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    return new TelegramClient({
      token: env.TELEGRAM_BOT_TOKEN,
      baseUrl: env.TELEGRAM_API_BASE,
      timeoutMs: env.TELEGRAM_TIMEOUT_MS,
      maxAttempts: env.TELEGRAM_MAX_ATTEMPTS,
    });
  }

  // ------------------------------------------------------------------ settings

  async settings(workspaceId: string): Promise<NotificationSettings> {
    const resolved = await new ConfigurationService(workspaceId).load();
    const enabled = resolved.values.get(CONFIG_KEYS.NOTIFICATIONS_ENABLED);
    const chatId = resolved.values.get(CONFIG_KEYS.NOTIFICATIONS_CHAT_ID);
    const categories = resolved.values.get(CONFIG_KEYS.NOTIFICATIONS_CATEGORIES);
    const hour = resolved.values.get(CONFIG_KEYS.NOTIFICATIONS_DAILY_SUMMARY_HOUR);
    return {
      enabled: enabled === true,
      chatId: typeof chatId === 'string' && chatId.trim() ? chatId.trim() : null,
      categories: Array.isArray(categories)
        ? (categories.filter((c): c is NotificationCategory => NOTIFICATION_CATEGORIES.includes(c as NotificationCategory)))
        : defaultCategories(),
      dailySummaryHour: typeof hour === 'number' && hour >= 0 && hour <= 23 ? hour : 9,
    };
  }

  /** Effective chat id: the dashboard override wins, the environment is the fallback. */
  async effectiveChatId(workspaceId: string): Promise<string | null> {
    const settings = await this.settings(workspaceId);
    return settings.chatId ?? (env.TELEGRAM_CHAT_ID?.trim() || null);
  }

  async updateSettings(
    workspaceId: string,
    input: Partial<NotificationSettings>,
    actorUserId: string | null,
  ): Promise<NotificationSettings> {
    const current = await this.settings(workspaceId);
    const next: NotificationSettings = {
      enabled: input.enabled ?? current.enabled,
      chatId: input.chatId !== undefined ? input.chatId : current.chatId,
      categories: input.categories ?? current.categories,
      dailySummaryHour: input.dailySummaryHour ?? current.dailySummaryHour,
    };
    await ConfigurationService.set(workspaceId, CONFIG_KEYS.NOTIFICATIONS_ENABLED, next.enabled, actorUserId);
    await ConfigurationService.set(workspaceId, CONFIG_KEYS.NOTIFICATIONS_CHAT_ID, next.chatId, actorUserId);
    await ConfigurationService.set(workspaceId, CONFIG_KEYS.NOTIFICATIONS_CATEGORIES, next.categories, actorUserId);
    await ConfigurationService.set(workspaceId, CONFIG_KEYS.NOTIFICATIONS_DAILY_SUMMARY_HOUR, next.dailySummaryHour, actorUserId);
    // Any settings change invalidates the cached identity probe (a new chat id may be unroutable).
    this.probeCache = null;
    return this.settings(workspaceId);
  }

  // -------------------------------------------------------------------- status

  async status(workspaceId: string): Promise<NotificationStatus> {
    const settings = await this.settings(workspaceId);
    const chatId = settings.chatId ?? (env.TELEGRAM_CHAT_ID?.trim() || null);
    // Report what this process can actually do: the client is null exactly when the token is
    // absent, so this stays true for an injected client (tests, or a future second provider).
    const tokenConfigured = Boolean(this.client);
    const bot = await this.probeBot();
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [lastSent, lastFailed, counters] = await Promise.all([
      prisma.notificationDelivery.findFirst({
        where: { workspaceId, status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true, category: true },
      }),
      prisma.notificationDelivery.findFirst({
        where: { workspaceId, status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        select: { lastError: true, createdAt: true },
      }),
      prisma.notificationDelivery.groupBy({
        by: ['status'],
        where: { workspaceId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);
    const count = (status: 'SENT' | 'FAILED' | 'SKIPPED') =>
      counters.find((row) => row.status === status)?._count._all ?? 0;
    const blockingReason = !tokenConfigured
      ? 'TELEGRAM_BOT_TOKEN is not set on the API.'
      : !chatId
        ? 'No chat id: set TELEGRAM_CHAT_ID on the API, or enter one in the settings below.'
        : !settings.enabled
          ? 'Notifications are switched off for this workspace.'
          : !bot.reachable
            ? `Telegram rejected the bot credentials: ${bot.error}`
            : null;
    return {
      tokenConfigured,
      chatIdConfigured: Boolean(chatId),
      chatIdMasked: maskChatId(chatId),
      enabled: settings.enabled,
      categories: settings.categories,
      dailySummaryHour: settings.dailySummaryHour,
      bot: { reachable: bot.reachable, username: bot.username, error: bot.error, checkedAt: bot.at ? new Date(bot.at).toISOString() : null },
      lastDeliveryAt: lastSent?.sentAt?.toISOString() ?? null,
      lastDeliveryCategory: (lastSent?.category as NotificationCategory | undefined) ?? null,
      lastError: lastFailed?.lastError ?? null,
      lastErrorAt: lastFailed?.createdAt?.toISOString() ?? null,
      last24h: { sent: count('SENT'), failed: count('FAILED'), skipped: count('SKIPPED') },
      canSend: blockingReason === null,
      blockingReason,
    };
  }

  private async probeBot(): Promise<BotProbeCache> {
    if (this.probeCache && Date.now() - this.probeCache.at < BOT_PROBE_TTL_MS) return this.probeCache;
    if (!this.client) {
      this.probeCache = { at: Date.now(), reachable: false, username: null, error: 'TELEGRAM_BOT_TOKEN is not set' };
      return this.probeCache;
    }
    const probe = await this.client.getMe({ retries: false });
    this.probeCache = probe.reachable
      ? { at: Date.now(), reachable: true, username: probe.identity.username, error: null }
      : { at: Date.now(), reachable: false, username: null, error: probe.error };
    return this.probeCache;
  }

  // ---------------------------------------------------------------------- test

  /**
   * Sends a real message right now and records it. Used by "Test connection" and "Send test
   * message"; the difference is only the wording, so both go through the same path and both
   * leave an audit row.
   */
  async test(
    workspaceId: string,
    options: { note?: string; actorEmail?: string | null; await?: boolean } = {},
  ): Promise<{ delivered: boolean; error: string | null; attempts: number; message: string; chatIdMasked: string | null }> {
    const chatId = await this.effectiveChatId(workspaceId);
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
    const message = renderNotification({
      category: 'CONNECTION_TEST',
      severity: 'info',
      workspaceName: workspace?.name ?? 'workspace',
      summary: options.note?.trim() ? options.note.trim() : 'Test message from the ClipForge dashboard.',
      details: [
        ['Requested by', options.actorEmail ?? 'dashboard'],
        ['Chat', maskChatId(chatId)],
      ],
    });
    if (!this.client || !chatId) {
      return {
        delivered: false,
        error: !this.client ? 'TELEGRAM_BOT_TOKEN is not set on the API' : 'No chat id configured',
        attempts: 0,
        message,
        chatIdMasked: maskChatId(chatId),
      };
    }
    // A test message is intentionally *not* deduped: pressing the button twice should send twice.
    const row = await prisma.notificationDelivery.create({
      data: {
        workspaceId,
        category: 'CONNECTION_TEST',
        dedupeKey: `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        message,
        chatIdSuffix: chatId.slice(-4),
      },
    });
    const result = await this.client.sendMessage(chatId, message);
    await this.record(workspaceId, row.id, result);
    return { delivered: result.delivered, error: result.error, attempts: result.attempts, message, chatIdMasked: maskChatId(chatId) };
  }

  // -------------------------------------------------------------------- notify

  /**
   * Emits a notification for a real backend event.
   *
   * Never throws. Returns what happened so a caller *may* log it, but no caller is required to.
   * Delivery happens off the caller's critical path unless `await: true` is passed.
   */
  async notify(input: NotifyInput): Promise<NotifyResult> {
    try {
      const settings = await this.settings(input.workspaceId);
      if (!settings.enabled || !settings.categories.includes(input.category)) {
        return { outcome: 'SKIPPED_DISABLED', deliveryId: null, detail: `${input.category} is not enabled for this workspace` };
      }
      const chatId = settings.chatId ?? (env.TELEGRAM_CHAT_ID?.trim() || null);
      if (!this.client || !chatId) {
        return {
          outcome: 'NOT_CONFIGURED',
          deliveryId: null,
          detail: !this.client ? 'TELEGRAM_BOT_TOKEN is not set' : 'No chat id configured',
        };
      }
      const workspace = await prisma.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { name: true, timezone: true },
      });
      const message = renderNotification({
        category: input.category,
        severity: NOTIFICATION_CATEGORY_META[input.category].severity,
        workspaceName: workspace?.name ?? 'workspace',
        summary: input.summary,
        details: input.details,
        executionId: input.jobId ?? input.clipId ?? null,
        timezone: workspace?.timezone ?? env.TIMEZONE,
      });

      let row: { id: string };
      try {
        row = await prisma.notificationDelivery.create({
          data: {
            workspaceId: input.workspaceId,
            category: input.category,
            dedupeKey: input.dedupeKey,
            message,
            jobId: input.jobId ?? null,
            clipId: input.clipId ?? null,
            chatIdSuffix: chatId.slice(-4),
            attempts: 0,
          },
          select: { id: true },
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          // The unique (workspaceId, dedupeKey) is the whole duplicate-prevention story.
          return { outcome: 'SKIPPED_DUPLICATE', deliveryId: null, detail: `dedupe key already used: ${input.dedupeKey}` };
        }
        throw error;
      }

      if (input.await) {
        const result = await this.deliver(row.id);
        return { outcome: result.delivered ? 'SENT' : 'FAILED', deliveryId: row.id, detail: result.error };
      }
      // Fire and forget: the caller is a pipeline stage that must not wait on Telegram.
      void this.deliver(row.id).catch((error: Error) => this.logger.warn(`delivery ${row.id} crashed: ${error.message}`));
      return { outcome: 'SENT', deliveryId: row.id, detail: null };
    } catch (error) {
      // A notification failure is logged and forgotten. It is never rethrown.
      this.logger.warn(`notification ${input.category} for ${input.workspaceId} failed: ${(error as Error).message}`);
      return { outcome: 'FAILED', deliveryId: null, detail: (error as Error).message };
    }
  }

  /** Sends one persisted delivery. Returns the outcome; never throws. */
  async deliver(deliveryId: string): Promise<{ delivered: boolean; error: string | null }> {
    if (this.inFlight.has(deliveryId)) return { delivered: false, error: 'already in flight' };
    this.inFlight.add(deliveryId);
    try {
      const row = await prisma.notificationDelivery.findUnique({
        where: { id: deliveryId },
        select: { id: true, workspaceId: true, message: true, status: true, attempts: true },
      });
      if (!row) return { delivered: false, error: 'delivery row disappeared' };
      if (row.status === 'SENT') return { delivered: true, error: null };
      if (!this.client) return { delivered: false, error: 'TELEGRAM_BOT_TOKEN is not set' };
      const chatId = await this.effectiveChatId(row.workspaceId);
      if (!chatId) return { delivered: false, error: 'no chat id configured' };

      const result = await this.client.sendMessage(chatId, row.message);
      await this.record(row.workspaceId, row.id, result, row.attempts);
      if (!result.delivered) {
        this.logger.warn(`delivery ${row.id} failed after ${result.attempts} attempt(s): ${result.error}`);
      }
      return { delivered: result.delivered, error: result.error };
    } catch (error) {
      this.logger.warn(`delivery ${deliveryId} threw: ${(error as Error).message}`);
      return { delivered: false, error: (error as Error).message };
    } finally {
      this.inFlight.delete(deliveryId);
    }
  }

  private async record(
    workspaceId: string,
    deliveryId: string,
    result: { delivered: boolean; attempts: number; error: string | null; permanent: boolean },
    previousAttempts = 0,
  ): Promise<void> {
    const attempts = previousAttempts + Math.max(1, result.attempts);
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: result.delivered
        ? { status: 'SENT', sentAt: new Date(), attempts, lastError: null, nextAttemptAt: null }
        : {
            // A permanent failure (bad chat id, bot blocked) is not retried later: it would fail
            // identically forever and fill the log with noise the operator already knows about.
            status: 'FAILED',
            attempts,
            lastError: result.error?.slice(0, 900) ?? 'unknown error',
            nextAttemptAt: result.permanent ? null : new Date(Date.now() + 60_000),
          },
    }).catch(() => undefined);
  }

  // ------------------------------------------------------------------- history

  async history(
    workspaceId: string,
    query: { page: number; pageSize: number; category?: NotificationCategory; status?: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED' },
  ): Promise<{ items: NotificationDeliveryView[]; page: number; pageSize: number; total: number }> {
    const where = {
      workspaceId,
      ...(query.category ? { category: query.category } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.notificationDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.notificationDelivery.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        category: row.category as NotificationCategory,
        status: row.status as NotificationDeliveryView['status'],
        message: row.message,
        jobId: row.jobId,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  // ------------------------------------------------------- restart / recovery

  /**
   * Called once on boot by the API and periodically by the scheduler worker.
   *
   * Rows left PENDING by a crash are retried once; anything older than the lease-like window is
   * marked FAILED with an explicit reason, because a three-day-old "Workflow started" message is
   * worse than no message at all.
   */
  async retryPending(limit = 20): Promise<{ retried: number; sent: number; failed: number }> {
    const pending = await prisma.notificationDelivery.findMany({
      where: { status: 'PENDING', createdAt: { gte: new Date(Date.now() - STALE_PENDING_MS) } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let sent = 0;
    let failed = 0;
    for (const row of pending) {
      const result = await this.deliver(row.id);
      if (result.delivered) sent += 1;
      else failed += 1;
    }
    const abandoned = await prisma.notificationDelivery.updateMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - STALE_PENDING_MS) } },
      data: { status: 'FAILED', lastError: 'abandoned: process stopped before delivery completed' },
    });
    if (pending.length || abandoned.count) {
      this.logger.log(`retryPending: retried=${pending.length} sent=${sent} failed=${failed} abandoned=${abandoned.count}`);
    }
    return { retried: pending.length, sent, failed };
  }

  /** The catalogue the dashboard renders: one source of truth shared with the API and the database. */
  categories(): Array<{ value: NotificationCategory; label: string; description: string; severity: string; defaultEnabled: boolean }> {
    return NOTIFICATION_CATEGORIES.map((value) => ({
      value,
      label: NOTIFICATION_CATEGORY_META[value].label,
      description: NOTIFICATION_CATEGORY_META[value].description,
      severity: NOTIFICATION_CATEGORY_META[value].severity,
      defaultEnabled: NOTIFICATION_CATEGORY_META[value].defaultEnabled,
    }));
  }

  /** Re-usable probe result for the diagnostics surface. */
  async botIdentity(): Promise<{ reachable: boolean; username: string | null; error: string | null }> {
    const probe = await this.probeBot();
    return { reachable: probe.reachable, username: probe.username, error: probe.error };
  }

  /** Short id helper re-exported for call sites that build summaries. */
  static short = shortId;
}

function defaultCategories(): NotificationCategory[] {
  return NOTIFICATION_CATEGORIES.filter((category) => NOTIFICATION_CATEGORY_META[category].defaultEnabled);
}

/**
 * Chat ids are not secrets in the way a token is, but they are private routing information:
 * the dashboard shows enough to recognise the target and nothing more.
 */
export function maskChatId(chatId: string | null): string | null {
  if (!chatId) return null;
  if (chatId.startsWith('@')) return chatId;
  const chars = chatId.replace('-', '');
  return `${chatId.startsWith('-') ? '-' : ''}••••${chars.slice(-4)}`;
}

export { TelegramApiError };
