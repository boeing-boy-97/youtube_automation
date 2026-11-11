import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { notificationHistoryQuerySchema, notificationSettingsSchema, notificationTestSchema } from '@clipforge/validation';
import { appendAuditLog } from '@clipforge/database';
import type { NotificationCategory } from '@clipforge/shared-types';
import { CurrentContext, Roles } from '../common/decorators/auth.decorators';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { NotificationsService } from './notifications.service';

/**
 * Operator surface for the Telegram channel.
 *
 * Everything here is OWNER/ADMIN only and scoped to the caller's workspace: chat ids and delivery
 * history are operational data, not member-facing. The bot token is not part of any request or
 * response body — the API reads it from the environment and reports only whether it is present.
 */
@ApiTags('notifications')
@Roles('OWNER', 'ADMIN')
@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('status')
  @ApiOperation({ summary: 'Connection status, last delivery, 24h counters and what blocks sending' })
  status(@CurrentContext() ctx: RequestContext) {
    return this.notifications.status(ctx.workspaceId);
  }

  @Put('settings')
  @ApiOperation({ summary: 'Enable/disable, set the chat id, choose categories and the daily summary hour' })
  @RateLimit({ limit: 30, windowSeconds: 60, scope: 'notification-settings' })
  async update(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    const parsed = notificationSettingsSchema.parse(body);
    const before = await this.notifications.settings(ctx.workspaceId);
    const after = await this.notifications.updateSettings(
      ctx.workspaceId,
      {
        enabled: parsed.enabled,
        chatId: parsed.chatId === undefined ? undefined : parsed.chatId,
        categories: parsed.categories as NotificationCategory[] | undefined,
        dailySummaryHour: parsed.dailySummaryHour,
      },
      ctx.userId,
    );
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'NOTIFICATION_SETTINGS_CHANGED',
      targetType: 'NotificationSettings',
      targetId: ctx.workspaceId,
      summary: `Telegram notifications ${after.enabled ? 'enabled' : 'disabled'} (${after.categories.length} categories)`,
      metadata: {
        enabled: { from: before.enabled, to: after.enabled },
        // The chat id itself is never written to the audit log; the suffix is enough to tell
        // whether the target changed.
        chatIdSuffix: after.chatId ? after.chatId.slice(-4) : null,
        categoriesChanged: JSON.stringify(before.categories) !== JSON.stringify(after.categories),
        dailySummaryHour: after.dailySummaryHour,
      },
    }).catch(() => undefined);
    return after;
  }

  /**
   * "Test connection" and "Send test message" are the same operation with different wording, which
   * is deliberate: the thing worth testing is a real delivery through the real code path, not a
   * synthetic reachability check that can pass while sending is broken.
   */
  @Post('test')
  @ApiOperation({ summary: 'Send a real message through the configured bot and record the delivery' })
  @RateLimit({ limit: 10, windowSeconds: 60, scope: 'notification-test' })
  async test(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    const parsed = notificationTestSchema.parse(body ?? {});
    const result = await this.notifications.test(ctx.workspaceId, { note: parsed.note, actorEmail: ctx.email });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: result.delivered ? 'NOTIFICATION_SENT' : 'NOTIFICATION_FAILED',
      targetType: 'TelegramTest',
      targetId: ctx.workspaceId,
      summary: result.delivered ? 'Test notification delivered' : `Test notification failed: ${result.error ?? 'unknown'}`,
      metadata: { attempts: result.attempts, chatIdSuffix: result.chatIdMasked },
    }).catch(() => undefined);
    return result;
  }

  @Get('history')
  @ApiOperation({ summary: 'Delivery log, newest first, filterable by category and status' })
  history(@Query() query: unknown, @CurrentContext() ctx: RequestContext) {
    return this.notifications.history(
      ctx.workspaceId,
      notificationHistoryQuerySchema.parse(query ?? {}) as {
        page: number;
        pageSize: number;
        category?: NotificationCategory;
        status?: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
      },
    );
  }

  @Get('categories')
  @ApiOperation({ summary: 'The closed set of notifiable events, with labels and defaults' })
  categories() {
    return { categories: this.notifications.categories() };
  }
}
