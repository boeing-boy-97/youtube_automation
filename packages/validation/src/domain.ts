/**
 * Domain rules that both the API and workers depend on.
 * Pure functions only — unit-tested in tests/unit.
 */
import type { HighlightCandidate } from '@clipforge/shared-types';

export interface TimestampIssue {
  code: string;
  message: string;
}

/** A candidate's timestamps must be finite, ordered and inside the source. */
export function validateCandidateTimestamps(
  candidate: Pick<HighlightCandidate, 'start_time' | 'end_time' | 'target_duration'>,
  sourceDuration: number,
): TimestampIssue[] {
  const issues: TimestampIssue[] = [];
  const { start_time, end_time, target_duration } = candidate;
  if (!Number.isFinite(start_time) || !Number.isFinite(end_time)) {
    issues.push({ code: 'NON_FINITE', message: 'Start/end must be finite numbers' });
    return issues;
  }
  if (start_time < 0) issues.push({ code: 'NEGATIVE_START', message: 'Start time is negative' });
  if (end_time <= start_time) issues.push({ code: 'INVERTED_RANGE', message: 'End must be after start' });
  if (end_time > sourceDuration + 0.5) {
    issues.push({ code: 'OUT_OF_BOUNDS', message: `End ${end_time} exceeds source duration ${sourceDuration}` });
  }
  if (![15, 30].includes(target_duration)) {
    issues.push({ code: 'BAD_TARGET', message: 'target_duration must be 15 or 30' });
  }
  return issues;
}

/** Duration must land inside a tolerance band around the requested kind. */
export function validateCandidateDuration(actual: number, target: 15 | 30, toleranceSeconds = 3): boolean {
  return actual >= target - toleranceSeconds && actual <= target + toleranceSeconds;
}

/**
 * Soft-overlap check: two candidates that share more than `maxOverlapRatio` of
 * the shorter span are considered duplicates of the same moment.
 */
export function overlapRatio(
  a: { start: number; end: number },
  b: { start: number; end: number },
): number {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  if (shorter <= 0) return 0;
  return overlap / shorter;
}

export function isDuplicate(
  a: { start: number; end: number },
  b: { start: number; end: number },
  threshold = 0.35,
): boolean {
  return overlapRatio(a, b) >= threshold;
}

/** Normalised token overlap (Jaccard) used together with time overlap. */
export function textSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const A = norm(a);
  const B = norm(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * Greedy selection of a diverse, non-duplicate set.
 * The count is emergent: it equals however many candidates clear every gate.
 * Never pads to reach a target count.
 */
export function selectNonDuplicate(
  candidates: HighlightCandidate[],
  opts: { minQualityScore: number; maxClips: number; duplicateThreshold: number },
): { accepted: HighlightCandidate[]; rejected: Array<{ candidate: HighlightCandidate; reason: string }> } {
  const sorted = [...candidates].sort((x, y) => y.quality_score - x.quality_score);
  const accepted: HighlightCandidate[] = [];
  const rejected: Array<{ candidate: HighlightCandidate; reason: string }> = [];

  for (const candidate of sorted) {
    if (accepted.length >= opts.maxClips) {
      rejected.push({ candidate, reason: 'MAX_CLIPS_REACHED' });
      continue;
    }
    if (candidate.quality_score < opts.minQualityScore) {
      rejected.push({ candidate, reason: 'BELOW_MIN_QUALITY' });
      continue;
    }
    const clash = accepted.find(
      (a) =>
        isDuplicate({ start: a.start_time, end: a.end_time }, { start: candidate.start_time, end: candidate.end_time }, opts.duplicateThreshold) ||
        textSimilarity(a.transcript, candidate.transcript) >= 0.6,
    );
    if (clash) {
      rejected.push({ candidate, reason: 'DUPLICATE_OF_ACCEPTED' });
      continue;
    }
    accepted.push(candidate);
  }
  return { accepted, rejected };
}

/** 0..100 weighted score from the documented rubric (sum of weights = 1). */
export const RUBRIC_WEIGHTS = {
  hookQuality: 0.16,
  standaloneMeaning: 0.12,
  completeness: 0.12,
  informationalValue: 0.12,
  emotionalEngagement: 0.1,
  storytelling: 0.09,
  audioClarity: 0.07,
  visualSuitability: 0.07,
  viewerInterest: 0.1,
  contextPreservation: 0.05,
} as const;

export function computeQualityScore(scores: Record<string, number>): number {
  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(RUBRIC_WEIGHTS)) {
    const v = Number(scores[key]);
    if (!Number.isFinite(v)) continue;
    total += Math.max(0, Math.min(10, v)) * weight;
    weightSum += weight;
  }
  if (weightSum === 0) return 0;
  return Math.round((total / weightSum) * 10);
}

export function isYouTubeUrl(url: string): boolean {
  return /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(url);
}

/** Extracts a YouTube video id without downloading anything. */
export function parseYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1) || null;
    const v = parsed.searchParams.get('v');
    if (v) return v;
    const shorts = parsed.pathname.match(/\/shorts\/([\w-]{6,})/);
    if (shorts) return shorts[1] ?? null;
    return null;
  } catch {
    return null;
  }
}
