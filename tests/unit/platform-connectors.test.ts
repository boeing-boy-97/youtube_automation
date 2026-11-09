import { describe, expect, it } from 'vitest';
import {
  InstagramConnector,
  PlatformError,
  SUPPORTED_GRAPH_VERSIONS,
  YouTubeConnector,
  backoffWithJitter,
  classifyHttpError,
} from '@clipforge/platform-connectors';

function headers(map: Record<string, string>): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(map)) h.set(key, value);
  return h;
}

describe('platform error classification', () => {
  it('marks 429 as a retryable rate limit and keeps retry-after', () => {
    const error = classifyHttpError('YOUTUBE', 429, { error: { message: 'quota' } }, headers({ 'retry-after': '42' }));
    expect(error.classification).toBe('RATE_LIMIT');
    expect(error.retryable).toBe(true);
    expect(error.details.retryAfterSeconds).toBe(42);
  });

  it('marks 5xx as retryable', () => {
    const error = classifyHttpError('INSTAGRAM', 503, { error: { message: 'unavailable' } });
    expect(error.retryable).toBe(true);
  });

  it('marks 401/403 as an auth failure that is not auto-retried', () => {
    for (const status of [401, 403]) {
      const error = classifyHttpError('YOUTUBE', status, { error: { message: 'invalid credentials' } });
      expect(error.classification).toBe('AUTH');
      expect(error.retryable).toBe(false);
    }
  });

  it('marks 400/404 as permanent so a broken request is never retried forever', () => {
    for (const status of [400, 404, 422]) {
      const error = classifyHttpError('INSTAGRAM', status, { error: { message: 'bad request' } });
      expect(error.classification).toBe('PERMANENT');
      expect(error.retryable).toBe(false);
    }
  });

  it('surfaces the platform error code and subcode for the audit trail', () => {
    const error = classifyHttpError('INSTAGRAM', 400, { error: { code: 36003, error_subcode: 2207026, message: 'aspect ratio' } });
    expect(error.details.platformCode).toBe(36003);
    expect(String(error.details.platformReason)).toContain('2207026');
  });
});

describe('exponential backoff with jitter', () => {
  it('grows with attempts and never exceeds the cap', () => {
    const fixed = () => 0.5;
    const first = backoffWithJitter(1, 1000, 60_000, fixed);
    const third = backoffWithJitter(3, 1000, 60_000, fixed);
    const tenth = backoffWithJitter(10, 1000, 60_000, fixed);
    expect(first).toBeLessThan(third);
    expect(third).toBeLessThanOrEqual(tenth);
    expect(tenth).toBeLessThanOrEqual(60_000);
  });

  it('stays within the jitter window for the same attempt', () => {
    const low = backoffWithJitter(4, 1000, 600_000, () => 0);
    const high = backoffWithJitter(4, 1000, 600_000, () => 1);
    expect(low).toBe(4000);
    expect(high).toBe(8000);
  });
});

describe('connector configuration guards', () => {
  it('refuses to construct a YouTube connector without OAuth credentials', () => {
    expect(() => new YouTubeConnector({ clientId: '', clientSecret: '', redirectUri: '' })).toThrow(PlatformError);
  });

  it('builds a consent URL with offline access and a state parameter', () => {
    const connector = new YouTubeConnector({
      clientId: 'client-id',
      clientSecret: 'secret',
      redirectUri: 'https://app.example.com/api/accounts/youtube/callback',
    });
    const url = new URL(connector.buildAuthorizationUrl('signed-state'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
  });

  it('rejects an unsupported Graph API version instead of silently using a default', () => {
    expect(() =>
      new InstagramConnector({ appId: 'a', appSecret: 's', redirectUri: 'https://app.example.com/cb', graphVersion: 'v19.0' }),
    ).toThrow(/graph/i);
  });

  it('accepts every version on the supported list', () => {
    for (const version of SUPPORTED_GRAPH_VERSIONS) {
      const connector = new InstagramConnector({ appId: 'a', appSecret: 's', redirectUri: 'https://app.example.com/cb', graphVersion: version });
      expect(connector.apiVersion).toBe(version);
    }
  });
});
