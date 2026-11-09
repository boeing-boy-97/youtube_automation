/**
 * Shared HTTP + error classification used by every platform connector.
 * No simulated responses: these functions only ever return what the platform returned.
 */

export type ErrorClass = 'RETRYABLE' | 'PERMANENT' | 'AUTH' | 'RATE_LIMIT';

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly platform: 'YOUTUBE' | 'INSTAGRAM' | 'GEMINI' | 'STORAGE',
    readonly classification: ErrorClass,
    readonly details: {
      httpStatus?: number;
      platformCode?: string | number;
      platformReason?: string;
      retryAfterSeconds?: number;
      raw?: unknown;
    } = {},
  ) {
    super(message);
    this.name = `${platform}Error`;
  }

  get retryable(): boolean {
    return this.classification === 'RETRYABLE' || this.classification === 'RATE_LIMIT';
  }
}

export async function fetchJson<T>(
  platform: 'YOUTUBE' | 'INSTAGRAM' | 'GEMINI',
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 30_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...rest, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    const aborted = (error as Error).name === 'AbortError';
    throw new PlatformError(
      aborted ? `Request to ${platform} timed out after ${timeoutMs}ms` : `Network error calling ${platform}: ${(error as Error).message}`,
      platform,
      'RETRYABLE',
      { raw: String(error) },
    );
  }
  clearTimeout(timer);

  const text = await response.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw classifyHttpError(platform, response.status, parsed, response.headers);
  }
  return parsed as T;
}

export function classifyHttpError(
  platform: 'YOUTUBE' | 'INSTAGRAM' | 'GEMINI',
  status: number,
  body: any,
  headers?: Headers,
): PlatformError {
  const platformCode = body?.error?.code ?? body?.error?.status ?? status;
  const platformReason =
    body?.error?.error_subcode ?? body?.error?.errors?.[0]?.reason ?? body?.error?.message ?? '';
  const retryAfter = headers?.get('retry-after');

  if (status === 429) {
    return new PlatformError(`${platform} rate limit reached`, platform, 'RATE_LIMIT', {
      httpStatus: status,
      platformCode,
      platformReason,
      retryAfterSeconds: retryAfter ? Number(retryAfter) : 900,
      raw: body,
    });
  }
  if (status === 401 || status === 403) {
    const isQuota = String(platformReason).toLowerCase().includes('quota');
    return new PlatformError(
      `${platform} authorization failed (${status}): ${body?.error?.message ?? 'insufficient permission or expired token'}`,
      platform,
      isQuota ? 'RATE_LIMIT' : 'AUTH',
      { httpStatus: status, platformCode, platformReason, raw: body },
    );
  }
  if (status >= 500) {
    return new PlatformError(`${platform} server error (${status})`, platform, 'RETRYABLE', {
      httpStatus: status,
      platformCode,
      platformReason,
      raw: body,
    });
  }
  return new PlatformError(`${platform} rejected the request (${status}): ${body?.error?.message ?? 'unknown'}`, platform, 'PERMANENT', {
    httpStatus: status,
    platformCode,
    platformReason,
    raw: body,
  });
}

/** Exponential backoff with full jitter; pure so it can be unit-tested. */
export function backoffWithJitter(attempt: number, baseMs = 2_000, capMs = 15 * 60_000, random = Math.random): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
