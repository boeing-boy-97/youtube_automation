/**
 * Unit economics for everything the pipeline spends money on.
 *
 * Every `UsageRecord` written to the database carries a `quantity` in a natural unit (seconds,
 * tokens, bytes, calls). This module turns that quantity into dollars so an operator can answer
 * "what did this workspace cost us last month?" without re-deriving prices from metadata years
 * later. Prices are configuration, not constants: self-hosted work (whisper, ffmpeg) is free by
 * default, hosted model calls are priced per thousand tokens, and every value can be overridden
 * per deployment through the environment (see docs/CONFIGURATION.md).
 *
 * The invoice is an estimate, never a billing document: it is computed from what the platform
 * measured at the moment of the call, with the price list as it exists when the record is
 * written. Historical records keep the price that was in force at the time.
 */
import { env } from '../env';

export type UsageKind =
  | 'transcription_seconds'
  | 'gemini_tokens'
  | 'gemini_vision_tokens'
  | 'render_seconds'
  | 'storage_bytes'
  | 'publish_calls';

export interface PriceList {
  geminiInputPer1kTokens: number;
  geminiOutputPer1kTokens: number;
  visionInputPer1kTokens: number;
  visionOutputPer1kTokens: number;
  transcriptionPerSecond: number;
  renderPerSecond: number;
  storagePerGbMonth: number;
  publishPerCall: number;
}

/** Prices in force for this process. Read once: a restart is required to change them. */
export function priceList(): PriceList {
  return {
    geminiInputPer1kTokens: env.PRICE_GEMINI_INPUT_PER_1K_TOKENS,
    geminiOutputPer1kTokens: env.PRICE_GEMINI_OUTPUT_PER_1K_TOKENS,
    visionInputPer1kTokens: env.PRICE_VISION_INPUT_PER_1K_TOKENS,
    visionOutputPer1kTokens: env.PRICE_VISION_OUTPUT_PER_1K_TOKENS,
    transcriptionPerSecond: env.PRICE_TRANSCRIPTION_PER_SECOND,
    renderPerSecond: env.PRICE_RENDER_PER_SECOND,
    storagePerGbMonth: env.PRICE_STORAGE_PER_GB_MONTH,
    publishPerCall: env.PRICE_PUBLISH_CALL,
  };
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Cost in USD of one usage record.
 *
 * Returns `null` when a quantity cannot be priced (unknown kind, or a token record whose
 * prompt/completion split was never captured). `null` is honest: it says "not priced", and the
 * summary reports how many records were left unpriced instead of pretending they cost nothing.
 */
export function estimateCostUsd(
  kind: string,
  quantity: number,
  metadata: Record<string, unknown> | null | undefined,
  prices: PriceList = priceList(),
): number | null {
  const qty = num(quantity);
  const meta = metadata ?? {};
  switch (kind) {
    case 'transcription_seconds':
      return round(qty * prices.transcriptionPerSecond);
    case 'render_seconds':
      return round(qty * prices.renderPerSecond);
    case 'publish_calls':
      return round(qty * prices.publishPerCall);
    case 'storage_bytes':
      // Storage is billed monthly per GB stored; a single upload is not a chargeable event.
      // The monthly figure is derived in the usage summary, not per record.
      return null;
    case 'gemini_tokens': {
      const prompt = metadataNumber(meta, 'promptTokens');
      const candidates = metadataNumber(meta, 'candidateTokens');
      if (prompt === null && candidates === null) return null;
      return round(
        ((prompt ?? 0) / 1000) * prices.geminiInputPer1kTokens +
          ((candidates ?? 0) / 1000) * prices.geminiOutputPer1kTokens,
      );
    }
    case 'gemini_vision_tokens': {
      const prompt = metadataNumber(meta, 'promptTokens');
      const candidates = metadataNumber(meta, 'candidateTokens');
      if (prompt === null && candidates === null) return null;
      return round(
        ((prompt ?? 0) / 1000) * prices.visionInputPer1kTokens +
          ((candidates ?? 0) / 1000) * prices.visionOutputPer1kTokens,
      );
    }
    default:
      return null;
  }
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Six decimal places: sub-cent costs are common and rounding to cents would erase them. */
export function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
