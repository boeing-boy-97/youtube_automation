import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { appendAuditLog, ConfigurationService, prisma } from '@clipforge/database';
import { CONFIG_KEYS, REQUIRED_FOR_PROCESSING, REQUIRED_FOR_PUBLISHING } from '@clipforge/shared-types';
import type { BrandProfileInput, SubtitlePresetInput } from '@clipforge/validation';
import type { RequestContext } from '../common/guards/session-auth.guard';

@Injectable()
export class WorkspaceService {
  async configuration(ctx: RequestContext) {
    const resolved = await new ConfigurationService(ctx.workspaceId).load();
    const presets = await prisma.subtitlePreset.findMany({
      where: { OR: [{ workspaceId: ctx.workspaceId }, { workspaceId: null }] },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return {
      values: Object.fromEntries(resolved.values.entries()),
      requiredForProcessing: REQUIRED_FOR_PROCESSING,
      requiredForPublishing: REQUIRED_FOR_PUBLISHING,
      missingForProcessing: REQUIRED_FOR_PROCESSING.filter((k) => !resolved.values.has(k)),
      missingForPublishing: REQUIRED_FOR_PUBLISHING.filter((k) => !resolved.values.has(k)),
      allKeys: Object.values(CONFIG_KEYS),
      subtitlePresets: presets.map((p) => ({ id: p.id, name: p.name, isSystem: p.isSystem, style: p.style })),
      brandProfiles: await prisma.brandProfile.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'asc' } }),
    };
  }

  async writeConfiguration(entries: Array<{ key: string; value: unknown }>, ctx: RequestContext) {
    const editable = new Set<string>(Object.values(CONFIG_KEYS));
    const invalid = entries.filter((e) => !editable.has(e.key)).map((e) => e.key);
    if (invalid.length) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Unknown configuration key(s): ${invalid.join(', ')}` });
    }
    await this.validateValues(entries, ctx.workspaceId);
    for (const entry of entries) {
      await ConfigurationService.set(ctx.workspaceId, entry.key, entry.value, ctx.userId);
    }
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'CONFIG_CHANGED',
      summary: `Configuration updated: ${entries.map((e) => e.key).join(', ')}`,
      metadata: { entries: entries as unknown as Record<string, unknown> },
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.configuration(ctx);
  }

  private async validateValues(entries: Array<{ key: string; value: unknown }>, workspaceId: string) {
    for (const { key, value } of entries) {
      if (key === CONFIG_KEYS.SUBTITLE_PRESET_ID) {
        const preset = await prisma.subtitlePreset.findFirst({
          where: { id: String(value), OR: [{ workspaceId }, { workspaceId: null }] },
        });
        if (!preset) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'subtitle preset id does not exist' });
      }
      if (key === CONFIG_KEYS.PUBLISHING_YOUTUBE_VISIBILITY && !['PUBLIC', 'UNLISTED', 'PRIVATE'].includes(String(value))) {
        throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'YouTube visibility must be PUBLIC, UNLISTED or PRIVATE' });
      }
      if (key === CONFIG_KEYS.TIMEZONE) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: String(value) });
        } catch {
          throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Unknown IANA time zone: ${value}` });
        }
      }
      if (key === CONFIG_KEYS.STORAGE_PROVIDER && !['s3', 'local'].includes(String(value))) {
        throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'storage.provider must be "s3" or "local"' });
      }
      if (key === CONFIG_KEYS.AI_MAX_OUTPUT_CLIPS && (Number(value) < 1 || Number(value) > 50)) {
        throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'ai.max_output_clips must be between 1 and 50' });
      }
    }
  }

  async createBrandProfile(input: BrandProfileInput, ctx: RequestContext) {
    if (input.isDefault) {
      await prisma.brandProfile.updateMany({ where: { workspaceId: ctx.workspaceId }, data: { isDefault: false } });
    }
    const profile = await prisma.brandProfile.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: input.name,
        isDefault: input.isDefault ?? false,
        primaryColor: input.primaryColor,
        secondaryColor: input.secondaryColor,
        textColor: input.textColor,
        fontFamily: input.fontFamily,
        brandVoice: input.brandVoice,
        customVoiceInstructions: input.customVoiceInstructions,
        audienceDescription: input.audienceDescription,
        watermarkPosition: input.watermarkPosition,
        logoStorageKey: input.logoStorageKey ?? null,
        introEnabled: input.introEnabled ?? false,
        outroEnabled: input.outroEnabled ?? false,
        introAssetKey: input.introAssetKey ?? null,
        outroAssetKey: input.outroAssetKey ?? null,
      },
    });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'CONFIG_CHANGED',
      targetType: 'BrandProfile',
      targetId: profile.id,
      summary: `Brand profile "${profile.name}" created`,
      ipAddress: ctx.ip,
    });
    return profile;
  }

  async createSubtitlePreset(input: SubtitlePresetInput, ctx: RequestContext) {
    return prisma.subtitlePreset.create({
      data: { workspaceId: ctx.workspaceId, name: input.name, style: input.style, isSystem: false },
    });
  }

  async activity(ctx: RequestContext, limit: number) {
    const logs = await prisma.auditLog.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
    return {
      items: logs.map((log) => ({
        id: log.id,
        action: log.action,
        summary: log.summary,
        targetType: log.targetType,
        targetId: log.targetId,
        metadata: log.metadata,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  }

  async getBrandProfile(id: string, ctx: RequestContext) {
    const profile = await prisma.brandProfile.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!profile) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Brand profile not found' });
    return profile;
  }
}
