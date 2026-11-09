import { Injectable } from '@nestjs/common';
import { CONFIG_KEYS, type ConfigKey } from '@clipforge/shared-types';
import { ConfigurationRequiredError, ConfigurationService, prisma } from '@clipforge/database';

export interface ProcessingConfiguration {
  aiTextModel: string;
  aiVisionModel: string;
  maxOutputClips: number;
  minQualityScore: number;
  maxCandidatesPerCall: number;
  maxDurationSeconds: number;
  maxFileSizeBytes: number;
  renderWidth: number;
  renderHeight: number;
  renderFps: number;
  renderBitrateKbps: number;
  framingMode: 'face_track' | 'center_crop' | 'manual' | 'background_blur';
  framingFallback: 'center_crop' | 'background_blur' | 'fail';
  subtitlePresetId: string;
  subtitleLanguage: string;
  storageProvider: string;
  timezone: string;
  duplicateThreshold: number;
  loudnessTargetLufs: number;
  contentLanguages: string[];
  retentionSourceDays: number | null;
  retentionAssetDays: number | null;
}

@Injectable()
export class AppConfigService {
  /** Reads configuration and fails closed with the exact missing keys. */
  async resolveForProcessing(workspaceId: string): Promise<ProcessingConfiguration> {
    const resolved = await new ConfigurationService(workspaceId).requireForProcessing();
    const get = <T>(key: ConfigKey): T => resolved.values.get(key) as T;
    const presetId = get<string>(CONFIG_KEYS.SUBTITLE_PRESET_ID);
    const preset = await prisma.subtitlePreset.findUnique({ where: { id: presetId } });
    if (!preset) {
      throw new ConfigurationRequiredError([`${CONFIG_KEYS.SUBTITLE_PRESET_ID} (preset not found or deleted)`], 'processing');
    }
    return {
      aiTextModel: get(CONFIG_KEYS.AI_TEXT_MODEL),
      aiVisionModel: get(CONFIG_KEYS.AI_VISION_MODEL),
      maxOutputClips: Number(get(CONFIG_KEYS.AI_MAX_OUTPUT_CLIPS)),
      minQualityScore: Number(get(CONFIG_KEYS.AI_MIN_QUALITY_SCORE)),
      maxCandidatesPerCall: Number(get(CONFIG_KEYS.AI_MAX_CANDIDATES_PER_CALL) ?? 12),
      maxDurationSeconds: Number(get(CONFIG_KEYS.PROCESSING_MAX_DURATION_SECONDS)),
      maxFileSizeBytes: Number(get(CONFIG_KEYS.PROCESSING_MAX_FILE_SIZE_BYTES)),
      renderWidth: Number(get(CONFIG_KEYS.RENDER_OUTPUT_WIDTH)),
      renderHeight: Number(get(CONFIG_KEYS.RENDER_OUTPUT_HEIGHT)),
      renderFps: Number(get(CONFIG_KEYS.RENDER_FPS)),
      renderBitrateKbps: Number(get(CONFIG_KEYS.RENDER_BITRATE_KBPS)),
      framingMode: get(CONFIG_KEYS.RENDER_FRAMING_MODE),
      framingFallback: (resolved.values.get(CONFIG_KEYS.RENDER_FRAMING_FALLBACK) as ProcessingConfiguration['framingFallback']) ?? 'fail',
      subtitlePresetId: presetId,
      subtitleLanguage: get(CONFIG_KEYS.SUBTITLE_LANGUAGE),
      storageProvider: get(CONFIG_KEYS.STORAGE_PROVIDER),
      timezone: get(CONFIG_KEYS.TIMEZONE),
      duplicateThreshold: Number(get(CONFIG_KEYS.DUPLICATE_SIMILARITY_THRESHOLD)),
      loudnessTargetLufs: Number(get(CONFIG_KEYS.AUDIO_LOUDNESS_TARGET_LUFS)),
      contentLanguages: (resolved.values.get(CONFIG_KEYS.CONTENT_LANGUAGES) as string[]) ?? [],
      retentionSourceDays: (resolved.values.get(CONFIG_KEYS.RETENTION_SOURCE_DAYS) as number) ?? null,
      retentionAssetDays: (resolved.values.get(CONFIG_KEYS.RETENTION_ASSET_DAYS) as number) ?? null,
    };
  }

  async allValues(workspaceId: string) {
    const resolved = await new ConfigurationService(workspaceId).load();
    return Object.fromEntries(resolved.values.entries());
  }

  async set(workspaceId: string, entries: Array<{ key: string; value: unknown }>, userId: string) {
    for (const entry of entries) {
      await ConfigurationService.set(workspaceId, entry.key, entry.value, userId);
    }
  }
}
