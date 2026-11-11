/**
 * Unit tests for the Telegram client and message rendering.
 *
 * No network, no database, no timers: `fetch`, `sleep` and `random` are injected, so the retry
 * schedule is asserted rather than waited out. These are the tests that fail if someone "simplifies"
 * the backoff, drops the 429 handling, or lets a credential reach an error string.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramClient,
  TelegramApiError,
  redactToken,
  truncateMessage,
} from '../../apps/api/src/notifications/telegram.client';
import { escapeHtml, formatTime, renderNotification, shortId } from '../../apps/api/src/notifications/notification-format';
import { maskChatId } from '../../apps/api/src/notifications/notifications.service';
import { envSchema, loadEnv, resetEnvCache } from '../../apps/api/src/common/env';

const TOKEN = '8123456789:AAH8xQ3test-token-value-that-is-long-enough';
const CHAT = '-1001234567890';

interface Call {
  url: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeClient(handler: (call: Call, attempt: number) => Response | Promise<Response>, options: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const client = new TelegramClient({
    token: TOKEN,
    baseUrl: 'http://telegram.test',
    maxAttempts: 3,
    timeoutMs: 100,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      return handler(call, calls.length);
    }) as unknown as typeof fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...options,
  });
  return { client, calls, sleeps };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TelegramClient', () => {
  it('sends a message and returns the platform message id', async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { ok: true, result: { message_id: 4242 } }));
    const result = await client.sendMessage(CHAT, 'hello');
    expect(result).toMatchObject({ delivered: true, messageId: 4242, attempts: 1, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ chat_id: CHAT, text: 'hello', parse_mode: 'HTML' });
  });

  it('retries a 500 with exponential backoff and reports the attempt count', async () => {
    const { client, calls, sleeps } = makeClient((_call, attempt) =>
      attempt < 3 ? jsonResponse(500, { ok: false, description: 'Internal Server Error' }) : jsonResponse(200, { ok: true, result: { message_id: 1 } }),
    );
    const result = await client.sendMessage(CHAT, 'hello');
    expect(result.delivered).toBe(true);
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    // base 500 → 500 ms, then 1000 ms (jitter is 0 with the injected random)
    expect(sleeps).toEqual([500, 1000]);
  });

  it('honours the retry_after Telegram returns on 429', async () => {
    const { client, sleeps } = makeClient((_call, attempt) =>
      attempt === 1
        ? jsonResponse(429, { ok: false, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } })
        : jsonResponse(200, { ok: true, result: { message_id: 9 } }),
    );
    const result = await client.sendMessage(CHAT, 'hello');
    expect(result.delivered).toBe(true);
    expect(sleeps).toEqual([7000]);
  });

  it('does not retry a permanent 400 (bad chat id) and marks it permanent', async () => {
    const { client, calls } = makeClient(() => jsonResponse(400, { ok: false, description: 'Bad Request: chat not found' }));
    const result = await client.sendMessage(CHAT, 'hello');
    expect(result.delivered).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.errorKind).toBe('PERMANENT');
    expect(calls).toHaveLength(1);
    expect(result.error).toContain('chat not found');
  });

  it('treats a rejected token as a configuration error and stops immediately', async () => {
    const { client, calls } = makeClient(() => jsonResponse(401, { ok: false, description: 'Unauthorized' }));
    const result = await client.sendMessage(CHAT, 'hello');
    expect(result.errorKind).toBe('CONFIGURATION');
    expect(calls).toHaveLength(1);
  });

  it('retries a network failure, gives up after maxAttempts and never throws', async () => {
    const { client, calls } = makeClient(() => {
      throw new TypeError('fetch failed');
    });
    const result = await client.sendMessage(CHAT, 'hello');
    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(result.error).toContain('fetch failed');
  });

  it('reports getMe identity', async () => {
    const { client } = makeClient(() => jsonResponse(200, { ok: true, result: { id: 1, username: 'clipforge_bot', first_name: 'ClipForge' } }));
    const probe = await client.getMe();
    expect(probe).toMatchObject({ reachable: true, identity: { username: 'clipforge_bot' } });
  });

  it('refuses to construct without a token', () => {
    expect(() => new TelegramClient({ token: '   ' })).toThrow(TelegramApiError);
  });

  it('never leaks the token into an error string, including when the server echoes the URL', async () => {
    const { client } = makeClient(() =>
      new Response(`upstream proxy error for https://api.telegram.org/bot${TOKEN}/sendMessage`, { status: 502 }),
    );
    const result = await client.sendMessage(CHAT, 'hello');
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).toContain('redacted-token');
  });

  it('truncates at Telegram’s 4096 character limit', () => {
    const long = 'x'.repeat(5000);
    const truncated = truncateMessage(long);
    expect(truncated.length).toBeLessThanOrEqual(4000);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncateMessage('short')).toBe('short');
  });

  it('redacts anything token-shaped', () => {
    expect(redactToken(`token ${TOKEN} leaked`)).toBe('token <redacted-token> leaked');
  });
});

describe('message rendering', () => {
  it('escapes HTML so a filename cannot inject markup', () => {
    expect(escapeHtml('<b>a</b> & "b"')).toBe('&lt;b&gt;a&lt;/b&gt; &amp; "b"');
  });

  it('includes the execution id, the summary and the details', () => {
    const text = renderNotification({
      category: 'WORKFLOW_FAILED',
      severity: 'error',
      workspaceName: 'Demo <script>',
      summary: 'Workflow failed at RENDERING',
      details: [
        ['Code', 'FFMPEG_ERROR'],
        ['Reason', 'encoder <x265> unavailable'],
        ['Ignored', null],
      ],
      executionId: '9f2c1a7b-1111-2222-3333-444455556666',
      occurredAt: new Date('2026-11-10T17:41:00Z'),
      timezone: 'Asia/Kolkata',
    });
    expect(text).toContain('🚨');
    expect(text).toContain('Workflow failed at RENDERING');
    expect(text).toContain('<code>9f2c1a7b-1111-2222-3333-444455556666</code>');
    expect(text).toContain('Demo &lt;script&gt;');
    expect(text).toContain('encoder &lt;x265&gt; unavailable');
    expect(text).not.toContain('Ignored');
    // 17:41 UTC is 23:11 in Kolkata
    expect(text).toContain('23:11');
  });

  it('falls back to UTC instead of losing the message when the timezone is unknown', () => {
    expect(formatTime(new Date('2026-11-10T17:41:00Z'), 'Mars/Olympus')).toContain('17:41');
  });

  it('shortens ids for humans but leaves short ones alone', () => {
    expect(shortId('9f2c1a7b-1111-2222-3333-444455556666')).toBe('9f2c1a7b');
    expect(shortId('abc')).toBe('abc');
    expect(shortId(null)).toBe('—');
  });
});

describe('chat id masking', () => {
  it('keeps the last four digits and the sign, and nothing else', () => {
    expect(maskChatId('-1001234567890')).toBe('-••••7890');
    expect(maskChatId('123456')).toBe('••••3456');
    expect(maskChatId('@my_channel')).toBe('@my_channel');
    expect(maskChatId(null)).toBeNull();
  });
});

describe('environment validation', () => {
  const base = {
    NODE_ENV: 'test',
    APP_URL: 'http://127.0.0.1:3000',
    API_PORT: '4000',
    ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
    TIMEZONE: 'Asia/Kolkata',
    DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/x',
    REDIS_URL: 'redis://127.0.0.1:6379',
    REDIS_PREFIX: 'clipforge',
    CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(32),
    SESSION_SECRET: 'b'.repeat(40),
    ADMIN_BOOTSTRAP_TOKEN: 'c'.repeat(40),
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: '/tmp/x',
    STORAGE_LOCAL_PUBLIC_BASE_URL: 'http://127.0.0.1:4000/media',
    WORK_DIR: '/tmp/work',
    AI_ENGINE_URL: 'http://127.0.0.1:8100',
    AI_ENGINE_API_KEY: 'key-123456',
    VIDEO_PROCESSOR_URL: 'http://127.0.0.1:8200',
    VIDEO_PROCESSOR_API_KEY: 'key-123456',
  };

  const withEnv = (overrides: Record<string, string | undefined>) => {
    resetEnvCache();
    vi.stubEnv('TEST_TELEGRAM_SUITE', '1');
    for (const [key, value] of Object.entries({ ...base, ...overrides })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return () => {
      resetEnvCache();
      vi.unstubAllEnvs();
    };
  };

  it('leaves Telegram unconfigured without failing the rest of the boot', () => {
    const cleanup = withEnv({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined });
    try {
      const parsed = envSchema.parse(process.env);
      expect(parsed.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(parsed.TELEGRAM_API_BASE).toBe('https://api.telegram.org');
      expect(parsed.TELEGRAM_MAX_ATTEMPTS).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('treats an empty token as absent rather than as a malformed one', () => {
    const cleanup = withEnv({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
    try {
      expect(() => loadEnv()).not.toThrow();
      expect(loadEnv().TELEGRAM_BOT_TOKEN).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('rejects a malformed token at boot, naming the fix', () => {
    const cleanup = withEnv({ TELEGRAM_BOT_TOKEN: 'not-a-token' });
    try {
      expect(() => loadEnv()).toThrow(/TELEGRAM_BOT_TOKEN is malformed/);
    } finally {
      cleanup();
    }
  });

  it('rejects a malformed chat id at boot', () => {
    const cleanup = withEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: 'my group' });
    try {
      expect(() => loadEnv()).toThrow(/TELEGRAM_CHAT_ID is malformed/);
    } finally {
      cleanup();
    }
  });
});
