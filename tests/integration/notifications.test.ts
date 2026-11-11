/**
 * Integration tests for Telegram notifications against a real PostgreSQL database.
 *
 * The only fake is the Telegram endpoint itself: a local HTTP server, because reaching
 * api.telegram.org from a test would need a real bot token and would make the suite non-hermetic.
 * Everything else is real — real Prisma rows, the real unique constraint behind duplicate
 * prevention, the real retry/backoff code path, the real delivery log.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@clipforge/database';
import { NotificationsService } from '../../apps/api/src/notifications/notifications.service';
import { TelegramClient } from '../../apps/api/src/notifications/telegram.client';

const TOKEN = '8123456789:AAH8test-integration-token-value-long-enough';
const CHAT = '-1001234567890';

interface Captured {
  method: string;
  body: Record<string, unknown> | null;
}

/** A programmable stand-in for api.telegram.org/bot<token>/<method>. */
class FakeTelegram {
  private server: Server | null = null;
  readonly calls: Captured[] = [];
  /** Responses to return, in order. The last one repeats. */
  script: Array<{ status: number; body: unknown }> = [{ status: 200, body: { ok: true, result: { message_id: 1 } } }];
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        this.calls.push({
          method: request.url?.split('/').pop() ?? '',
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
        });
        // getMe has its own body: it is the identity probe, not a send. A fake that answered it
        // with a sendMessage body would make the status surface look broken when it is not.
        const method = this.calls[this.calls.length - 1].method;
        const body = method === 'getMe'
          ? { ok: true, result: { id: 8123456789, username: 'clipforge_test_bot', first_name: 'ClipForge' } }
          : this.script[Math.min(this.calls.length - 1, this.script.length - 1)].body;
        const status = method === 'getMe' ? 200 : this.script[Math.min(this.calls.length - 1, this.script.length - 1)].status;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server!.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  reset(script?: FakeTelegram['script']): void {
    this.calls.length = 0;
    this.script = script ?? [{ status: 200, body: { ok: true, result: { message_id: 1 } } }];
  }

  get messages(): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.method === 'sendMessage').map((call) => call.body ?? {});
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

const telegram = new FakeTelegram();
let service: NotificationsService;
let workspaceId: string;
let userId: string;

function clientFor(port: number, maxAttempts = 3): TelegramClient {
  return new TelegramClient({
    token: TOKEN,
    baseUrl: `http://127.0.0.1:${port}`,
    maxAttempts,
    timeoutMs: 2000,
    sleep: async () => undefined, // do not wait out the real backoff in a test
    random: () => 0,
  });
}

beforeAll(async () => {
  await telegram.start();
  await prisma.$connect();
  const slug = `notif-test-${randomUUID().slice(0, 8)}`;
  const workspace = await prisma.workspace.create({ data: { name: 'Notification Suite', slug, timezone: 'Asia/Kolkata' } });
  workspaceId = workspace.id;
  const user = await prisma.user.create({
    data: { email: `notif-${randomUUID().slice(0, 8)}@clipforge.test`, displayName: 'Notifier', passwordHash: 'x', role: 'ADMIN', status: 'ACTIVE' },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.notificationDelivery.deleteMany({ where: { workspaceId } });
  await prisma.applicationConfiguration.deleteMany({ where: { workspaceId } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await telegram.stop();
  await prisma.$disconnect();
});

beforeEach(async () => {
  telegram.reset();
  await prisma.notificationDelivery.deleteMany({ where: { workspaceId } });
  await prisma.applicationConfiguration.deleteMany({ where: { workspaceId } });
  service = new NotificationsService({ client: clientFor(telegram.port) });
  await service.updateSettings(
    workspaceId,
    { enabled: true, chatId: CHAT, categories: ['WORKFLOW_STARTED', 'WORKFLOW_FAILED', 'AUTH_EXPIRED', 'QUOTA_ERROR', 'CONNECTION_TEST'], dailySummaryHour: 9 },
    userId,
  );
});

afterEach(() => {
  telegram.reset();
});

describe('delivery', () => {
  it('sends an enabled category and records a SENT row', async () => {
    const result = await service.notify({
      workspaceId,
      category: 'WORKFLOW_STARTED',
      dedupeKey: 'job:abc:started',
      summary: 'Workflow queued for demo.mp4',
      jobId: randomUUID(),
      await: true,
    });
    expect(result.outcome).toBe('SENT');
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]).toMatchObject({ chat_id: CHAT, parse_mode: 'HTML' });
    expect(String(telegram.messages[0].text)).toContain('Workflow queued for demo.mp4');

    const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { workspaceId } });
    expect(row.status).toBe('SENT');
    expect(row.sentAt).toBeTruthy();
    expect(row.attempts).toBe(1);
  });

  it('does not send a disabled category and records nothing', async () => {
    const result = await service.notify({
      workspaceId,
      category: 'SOURCE_DOWNLOADED', // not in the enabled list above
      dedupeKey: 'job:abc:downloaded',
      summary: 'Source downloaded',
      await: true,
    });
    expect(result.outcome).toBe('SKIPPED_DISABLED');
    expect(telegram.messages).toHaveLength(0);
    expect(await prisma.notificationDelivery.count({ where: { workspaceId } })).toBe(0);
  });

  it('sends nothing when the workspace has notifications switched off', async () => {
    await service.updateSettings(workspaceId, { enabled: false }, userId);
    const result = await service.notify({
      workspaceId,
      category: 'WORKFLOW_STARTED',
      dedupeKey: 'job:off:started',
      summary: 'should not send',
      await: true,
    });
    expect(result.outcome).toBe('SKIPPED_DISABLED');
    expect(telegram.messages).toHaveLength(0);
  });
});

describe('duplicate prevention', () => {
  it('sends once for a repeated dedupe key, even when the call is retried', async () => {
    const key = 'job:dup:started';
    const first = await service.notify({ workspaceId, category: 'WORKFLOW_STARTED', dedupeKey: key, summary: 'one', await: true });
    const second = await service.notify({ workspaceId, category: 'WORKFLOW_STARTED', dedupeKey: key, summary: 'two', await: true });
    const third = await service.notify({ workspaceId, category: 'WORKFLOW_STARTED', dedupeKey: key, summary: 'three', await: true });

    expect(first.outcome).toBe('SENT');
    expect(second.outcome).toBe('SKIPPED_DUPLICATE');
    expect(third.outcome).toBe('SKIPPED_DUPLICATE');
    expect(telegram.messages).toHaveLength(1);
    expect(await prisma.notificationDelivery.count({ where: { workspaceId } })).toBe(1);
  });

  it('allows the same event in two workspaces', async () => {
    const other = await prisma.workspace.create({ data: { name: 'Other', slug: `notif-other-${randomUUID().slice(0, 8)}` } });
    try {
      await service.updateSettings(other.id, { enabled: true, chatId: CHAT, categories: ['WORKFLOW_STARTED'] }, userId);
      await service.notify({ workspaceId, category: 'WORKFLOW_STARTED', dedupeKey: 'job:shared:started', summary: 'a', await: true });
      await service.notify({ workspaceId: other.id, category: 'WORKFLOW_STARTED', dedupeKey: 'job:shared:started', summary: 'b', await: true });
      expect(telegram.messages).toHaveLength(2);
    } finally {
      await prisma.notificationDelivery.deleteMany({ where: { workspaceId: other.id } });
      await prisma.applicationConfiguration.deleteMany({ where: { workspaceId: other.id } });
      await prisma.workspace.delete({ where: { id: other.id } });
    }
  });
});

describe('retry and failure handling', () => {
  it('retries a temporary failure and reports the attempt count', async () => {
    telegram.reset([
      { status: 500, body: { ok: false, description: 'Internal Server Error' } },
      { status: 502, body: { ok: false, description: 'Bad Gateway' } },
      { status: 200, body: { ok: true, result: { message_id: 77 } } },
    ]);
    const result = await service.notify({ workspaceId, category: 'WORKFLOW_FAILED', dedupeKey: 'job:retry:failed', summary: 'boom', await: true });
    expect(result.outcome).toBe('SENT');
    expect(telegram.messages).toHaveLength(3);
    const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { workspaceId } });
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(3);
  });

  it('records a permanent failure, keeps the error, and never throws', async () => {
    telegram.reset([{ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }]);
    await expect(
      service.notify({ workspaceId, category: 'WORKFLOW_FAILED', dedupeKey: 'job:perm:failed', summary: 'boom', await: true }),
    ).resolves.toMatchObject({ outcome: 'FAILED' });
    const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { workspaceId } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toContain('chat not found');
    expect(row.nextAttemptAt).toBeNull(); // a permanent failure is not queued for later
  });

  it('survives the Telegram endpoint being unreachable', async () => {
    const dead = new NotificationsService({ client: clientFor(1, 2) }); // port 1: nothing listening
    const result = await dead.notify({ workspaceId, category: 'WORKFLOW_STARTED', dedupeKey: 'job:dead:started', summary: 'x', await: true });
    expect(result.outcome).toBe('FAILED');
    const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { workspaceId } });
    expect(row.status).toBe('FAILED');
    expect(row.nextAttemptAt).not.toBeNull(); // transient: eligible for the retry pass
  });

  it('reports NOT_CONFIGURED instead of failing when no token exists', async () => {
    const bare = new NotificationsService({ client: null });
    const result = await bare.notify({ workspaceId, category: 'WORKFLOW_STARTED', dedupeKey: 'job:notoken:started', summary: 'x', await: true });
    expect(result.outcome).toBe('NOT_CONFIGURED');
    expect(await prisma.notificationDelivery.count({ where: { workspaceId } })).toBe(0);
  });

  it('never stores the bot token in a delivery row', async () => {
    telegram.reset([{ status: 502, body: { ok: false, description: `proxy said https://api.telegram.org/bot${TOKEN}/sendMessage` } }]);
    await service.notify({ workspaceId, category: 'WORKFLOW_FAILED', dedupeKey: 'job:leak:failed', summary: 'x', await: true });
    const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { workspaceId } });
    expect(row.lastError).not.toContain(TOKEN);
    expect(row.message).not.toContain(TOKEN);
  });
});

describe('restart recovery', () => {
  it('delivers a row a crash left PENDING', async () => {
    const orphan = await prisma.notificationDelivery.create({
      data: {
        workspaceId,
        category: 'WORKFLOW_STARTED',
        dedupeKey: 'job:orphan:started',
        message: '<b>queued before the crash</b>',
        chatIdSuffix: CHAT.slice(-4),
      },
    });
    const result = await service.retryPending();
    expect(result.retried).toBe(1);
    expect(result.sent).toBe(1);
    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(row.status).toBe('SENT');
    expect(telegram.messages).toHaveLength(1);
  });

  it('abandons a row that is far too old to be useful, with an explicit reason', async () => {
    const stale = await prisma.notificationDelivery.create({
      data: {
        workspaceId,
        category: 'WORKFLOW_STARTED',
        dedupeKey: 'job:stale:started',
        message: 'ancient',
        createdAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    await service.retryPending();
    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toContain('abandoned');
    expect(telegram.messages).toHaveLength(0);
  });
});

describe('status and history', () => {
  it('reports configuration, last delivery, counters and a blocking reason', async () => {
    await service.notify({ workspaceId, category: 'WORKFLOW_STARTED', dedupeKey: 'job:s1:started', summary: 'one', await: true });
    const status = await service.status(workspaceId);
    expect(status.enabled).toBe(true);
    expect(status.chatIdConfigured).toBe(true);
    expect(status.chatIdMasked).toBe('-••••7890');
    expect(status.lastDeliveryAt).not.toBeNull();
    expect(status.lastDeliveryCategory).toBe('WORKFLOW_STARTED');
    expect(status.last24h.sent).toBe(1);
    expect(status.bot.reachable).toBe(true);
    expect(status.bot.username).toBe('clipforge_test_bot');
    expect(status.canSend).toBe(true);
    expect(status.blockingReason).toBeNull();
  });

  it('explains what blocks sending when notifications are off', async () => {
    await service.updateSettings(workspaceId, { enabled: false }, userId);
    const status = await service.status(workspaceId);
    expect(status.canSend).toBe(false);
    expect(status.blockingReason).toMatch(/switched off/i);
  });

  it('pages the delivery history newest first and filters by category', async () => {
    await service.notify({ workspaceId, category: 'WORKFLOW_STARTED', dedupeKey: 'h:1', summary: 'one', await: true });
    await service.notify({ workspaceId, category: 'WORKFLOW_FAILED', dedupeKey: 'h:2', summary: 'two', await: true });
    const all = await service.history(workspaceId, { page: 1, pageSize: 10 });
    expect(all.total).toBe(2);
    expect(all.items[0].category).toBe('WORKFLOW_FAILED');
    const failures = await service.history(workspaceId, { page: 1, pageSize: 10, category: 'WORKFLOW_FAILED' });
    expect(failures.total).toBe(1);
    expect(await service.history(workspaceId, { page: 1, pageSize: 10, status: 'SENT' })).toMatchObject({ total: 2 });
  });
});

describe('connection test', () => {
  it('sends a real message, records it, and is not deduped', async () => {
    const first = await service.test(workspaceId, { actorEmail: 'admin@clipforge.test' });
    const second = await service.test(workspaceId, { actorEmail: 'admin@clipforge.test' });
    expect(first.delivered).toBe(true);
    expect(second.delivered).toBe(true);
    expect(telegram.messages).toHaveLength(2);
    expect(String(telegram.messages[0].text)).toContain('admin@clipforge.test');
    const rows = await prisma.notificationDelivery.findMany({ where: { workspaceId, category: 'CONNECTION_TEST' } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'SENT')).toBe(true);
  });

  it('reports the Telegram error instead of throwing when the chat is wrong', async () => {
    telegram.reset([{ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }]);
    const result = await service.test(workspaceId, {});
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('chat not found');
  });
});

describe('settings', () => {
  it('round-trips enabled, chat id, categories and the summary hour', async () => {
    const saved = await service.updateSettings(
      workspaceId,
      { enabled: false, chatId: '@my_channel', categories: ['DAILY_SUMMARY', 'QUOTA_ERROR'], dailySummaryHour: 21 },
      userId,
    );
    expect(saved).toEqual({ enabled: false, chatId: '@my_channel', categories: ['DAILY_SUMMARY', 'QUOTA_ERROR'], dailySummaryHour: 21 });
    expect(await service.settings(workspaceId)).toEqual(saved);
  });

  it('defaults to the sensible category set for a workspace that never configured it', async () => {
    const fresh = await prisma.workspace.create({ data: { name: 'Fresh', slug: `notif-fresh-${randomUUID().slice(0, 8)}` } });
    try {
      const settings = await service.settings(fresh.id);
      expect(settings.enabled).toBe(false); // opt-in, never on by surprise
      expect(settings.categories).toContain('WORKFLOW_FAILED');
      expect(settings.categories).not.toContain('SOURCE_DOWNLOADED');
      expect(settings.dailySummaryHour).toBe(9);
    } finally {
      await prisma.workspace.delete({ where: { id: fresh.id } });
    }
  });
});
