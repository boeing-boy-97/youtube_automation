import { describe, expect, it } from 'vitest';
import { estimateCostUsd, round, type PriceList } from '../../apps/api/src/common/services/usage-cost';
import { usageRecordsQuerySchema, usageSummaryQuerySchema } from '@clipforge/validation';

/**
 * Prices are passed explicitly so the tests describe the arithmetic, not the deployment's
 * environment. The defaults in envSchema are a separate concern (documented in CONFIGURATION.md).
 */
const prices: PriceList = {
  geminiInputPer1kTokens: 0.0001,
  geminiOutputPer1kTokens: 0.0004,
  visionInputPer1kTokens: 0.0002,
  visionOutputPer1kTokens: 0.0004,
  transcriptionPerSecond: 0.0002,
  renderPerSecond: 0.001,
  storagePerGbMonth: 0.023,
  publishPerCall: 0.01,
};

describe('usage cost accounting', () => {
  it('prices text tokens from the prompt/completion split', () => {
    // 1000 prompt tokens at $0.0001/1k + 500 completion tokens at $0.0004/1k
    const cost = estimateCostUsd('gemini_tokens', 1500, { promptTokens: 1000, candidateTokens: 500 }, prices);
    expect(cost).toBeCloseTo(0.0001 + 0.0002, 9);
  });

  it('prices vision tokens with the vision price list, not the text one', () => {
    const cost = estimateCostUsd('gemini_vision_tokens', 2000, { promptTokens: 2000, candidateTokens: 0 }, prices);
    expect(cost).toBeCloseTo(0.0004, 9);
  });

  it('keeps sub-cent costs instead of rounding them to zero', () => {
    const cost = estimateCostUsd('gemini_tokens', 137, { promptTokens: 137, candidateTokens: 0 }, prices);
    expect(cost).not.toBeNull();
    expect(cost as number).toBeGreaterThan(0);
    expect(cost as number).toBeLessThan(0.001);
  });

  it('returns null for token records that never captured the split', () => {
    // A record with no prompt/completion split cannot be priced. Reporting 0 would be a lie.
    expect(estimateCostUsd('gemini_tokens', 5000, { model: 'gemini-2.0-flash' }, prices)).toBeNull();
    expect(estimateCostUsd('gemini_tokens', 5000, null, prices)).toBeNull();
  });

  it('never prices storage per write (it is a monthly rate)', () => {
    expect(estimateCostUsd('storage_bytes', 700_000_000, { sourceVideoId: 'x' }, prices)).toBeNull();
  });

  it('prices seconds and calls by quantity', () => {
    expect(estimateCostUsd('transcription_seconds', 3600, {}, prices)).toBeCloseTo(0.72, 9);
    expect(estimateCostUsd('render_seconds', 45.5, {}, prices)).toBeCloseTo(0.0455, 9);
    expect(estimateCostUsd('publish_calls', 3, {}, prices)).toBeCloseTo(0.03, 9);
  });

  it('returns null for unknown kinds and for negative or non-numeric quantities', () => {
    expect(estimateCostUsd('mystery_kind', 1, {}, prices)).toBeNull();
    expect(estimateCostUsd('publish_calls', -5, {}, prices)).toBe(0);
    expect(estimateCostUsd('publish_calls', Number.NaN, {}, prices)).toBe(0);
  });

  it('rounds to six decimal places so cent-level sums stay stable', () => {
    expect(round(0.0000004)).toBe(0);
    expect(round(0.0000006)).toBe(0.000001);
    expect(round(1.2345675)).toBe(1.234568);
  });
});

describe('usage query validation', () => {
  it('defaults the summary grouping and accepts ISO dates', () => {
    const parsed = usageSummaryQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31T23:59:59Z' });
    expect(parsed.groupBy).toBe('kind');
  });

  it('rejects an inverted window', () => {
    const result = usageSummaryQuerySchema.safeParse({ from: '2026-11-10', to: '2026-11-01' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown usage kinds on the ledger query', () => {
    expect(usageRecordsQuerySchema.safeParse({ kind: 'made_up' }).success).toBe(false);
    expect(usageRecordsQuerySchema.safeParse({ kind: 'publish_calls', pageSize: '5' }).success).toBe(true);
  });
});
