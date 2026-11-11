/**
 * Telegram Bot API client.
 *
 * Deliberately a plain class, not a Nest provider: the workers construct their own instance
 * (`new TelegramClient()`) the same way they construct `StorageService`, because workers run as
 * separate processes without a Nest container.
 *
 * What this file guarantees, and why each guarantee exists:
 *
 *  - **Bounded time.** Every request has an AbortSignal timeout. A hung connection to
 *    api.telegram.org must not hold a pipeline stage open.
 *  - **Classified failures.** `PERMANENT` (bad chat id, bot blocked, invalid token) is retried
 *    zero times; `RETRYABLE` (network, 5xx, timeout) and `RATE_LIMIT` (429) are retried with
 *    exponential backoff, honouring Telegram's own `retry_after` when it sends one.
 *  - **Nothing throws out of `send()`.** It returns a result object. A notification is never
 *    allowed to fail the work it is reporting on.
 *  - **No credential in any log line or error string.** The token appears only in the request URL,
 *    which is never included in an error message or a log entry.
 */

export type TelegramErrorKind = 'PERMANENT' | 'RATE_LIMIT' | 'RETRYABLE' | 'CONFIGURATION';

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly kind: TelegramErrorKind,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    readonly description?: string,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }

  get retryable(): boolean {
    return this.kind === 'RETRYABLE' || this.kind === 'RATE_LIMIT';
  }
}

export interface TelegramClientOptions {
  /** Bot token. Read from the environment by the caller; never persisted. */
  token: string;
  /** Overridable so tests can point at a local HTTP server instead of the internet. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Total attempts per message, including the first. */
  maxAttempts?: number;
  /** Base for the exponential backoff: 500 ms → 500, 1000, 2000 … */
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so a backoff does not have to wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests to keep jitter deterministic. */
  random?: () => number;
}

export interface TelegramIdentity {
  id: number;
  username: string | null;
  firstName: string | null;
}

export interface TelegramSendResult {
  delivered: boolean;
  attempts: number;
  messageId: number | null;
  error: string | null;
  errorKind: TelegramErrorKind | null;
  /** True when retrying cannot help — the operator must fix configuration. */
  permanent: boolean;
}

/** Telegram's hard limit is 4096 characters after entity parsing. Leave room for the footer. */
const MAX_MESSAGE_CHARS = 4000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

/**
 * Redacts anything that looks like a bot token from a string bound for a log or a database column.
 * Defence in depth: no code path puts the token in an error message, but an upstream error body or
 * a proxy page might echo the URL it was called with.
 */
export function redactToken(text: string): string {
  // No word-boundary anchor: the token is always preceded by "bot" in a Telegram URL
  // (…/bot8123456789:AA…), which is a word character, so \b would never match there.
  return text.replace(/\d{5,}:[A-Za-z0-9_-]{30,}/g, '<redacted-token>');
}

export class TelegramClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: TelegramClientOptions) {
    if (!options.token || !options.token.trim()) {
      throw new TelegramApiError('TELEGRAM_BOT_TOKEN is not set', 'CONFIGURATION');
    }
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 8000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** Kept out of every message: only the last four characters ever leave this method. */
  get tokenSuffix(): string {
    return this.options.token.slice(-4);
  }

  /** `https://api.telegram.org/bot<token>/<method>` — never logged. */
  private url(method: string): string {
    return `${this.baseUrl}/bot${this.options.token}/${method}`;
  }

  /**
   * Backoff for attempt N (1-based): base * 2^(N-1), capped, plus up to 25% jitter so a fleet of
   * workers recovering from the same outage does not retry in lockstep.
   */
  backoffFor(attempt: number): number {
    const exponential = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.maxBackoffMs);
    const jitter = Math.floor(exponential * 0.25 * this.random());
    return exponential + jitter;
  }

  private classify(status: number, body: unknown): { kind: TelegramErrorKind; description: string; retryAfter?: number } {
    const description =
      (body as { description?: string } | null)?.description ??
      (body as { message?: string } | null)?.message ??
      `Telegram responded ${status}`;
    if (status === 429) {
      const retryAfter = Number((body as { parameters?: { retry_after?: number } } | null)?.parameters?.retry_after ?? 0);
      return { kind: 'RATE_LIMIT', description, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined };
    }
    if (status === 401 || status === 404) return { kind: 'CONFIGURATION', description };
    // 400/403 are the "your chat id is wrong" and "the bot was blocked / not a member" cases.
    if (status >= 400 && status < 500) return { kind: 'PERMANENT', description };
    return { kind: 'RETRYABLE', description };
  }

  private async call(
    method: string,
    payload?: Record<string, unknown>,
  ): Promise<{ ok: true; body: unknown; attempts: number } | { ok: false; error: TelegramApiError; attempts: number }> {
    let lastError: TelegramApiError | null = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      attempts = attempt;
      try {
        const response = await this.fetchImpl(this.url(method), {
          method: payload ? 'POST' : 'GET',
          headers: payload ? { 'content-type': 'application/json' } : undefined,
          body: payload ? JSON.stringify(payload) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await response.text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = { description: redactToken(text.slice(0, 300)) };
        }
        if (response.ok && (body as { ok?: boolean } | null)?.ok !== false) return { ok: true, body, attempts };
        const { kind, description, retryAfter } = this.classify(response.status, body);
        lastError = new TelegramApiError(
          redactToken(`${method} failed (${response.status}): ${description}`),
          kind,
          response.status,
          retryAfter,
          description,
        );
        if (kind === 'PERMANENT' || kind === 'CONFIGURATION') return { ok: false, error: lastError, attempts };
      } catch (cause) {
        const name = (cause as Error)?.name;
        const message = name === 'TimeoutError' ? `Request timed out after ${this.timeoutMs} ms` : (cause as Error)?.message ?? 'Network error';
        lastError = new TelegramApiError(redactToken(`${method} failed: ${message}`), 'RETRYABLE');
      }
      if (attempt < this.maxAttempts) {
        const delay = lastError?.kind === 'RATE_LIMIT' && lastError.retryAfterSeconds
          ? Math.min(lastError.retryAfterSeconds * 1000, this.maxBackoffMs)
          : this.backoffFor(attempt);
        await this.sleep(delay);
      }
    }
    return { ok: false, error: lastError ?? new TelegramApiError(`${method} failed`, 'RETRYABLE'), attempts };
  }

  /** Cheap identity probe. Never throws: the caller renders the result. */
  async getMe(options: { retries?: boolean } = {}): Promise<{ reachable: true; identity: TelegramIdentity } | { reachable: false; error: string; errorKind: TelegramErrorKind }> {
    const client = options.retries === false ? new TelegramClient({ ...this.options, maxAttempts: 1 }) : this;
    const result = await client.call('getMe');
    if (!result.ok) return { reachable: false, error: result.error.message, errorKind: result.error.kind };
    const body = result.body as { result?: { id?: number; username?: string; first_name?: string } };
    return {
      reachable: true,
      identity: {
        id: Number(body?.result?.id ?? 0),
        username: body?.result?.username ?? null,
        firstName: body?.result?.first_name ?? null,
      },
    };
  }

  /**
   * Sends one message. Returns a result; it does not throw, ever — the queue worker, the pipeline
   * worker and an HTTP request handler all call this and none of them may die because Telegram is
   * unreachable.
   */
  async sendMessage(chatId: string, text: string): Promise<TelegramSendResult> {
    const result = await this.call('sendMessage', {
      chat_id: chatId,
      text: truncateMessage(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (!result.ok) {
      return {
        delivered: false,
        attempts: result.attempts,
        messageId: null,
        error: result.error.message,
        errorKind: result.error.kind,
        permanent: !result.error.retryable,
      };
    }
    const body = result.body as { result?: { message_id?: number } };
    return {
      delivered: true,
      attempts: result.attempts,
      messageId: Number(body?.result?.message_id ?? 0) || null,
      error: null,
      errorKind: null,
      permanent: false,
    };
  }
}
