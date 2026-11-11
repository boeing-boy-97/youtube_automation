/**
 * Environment parsing with zod. Every value a feature needs is required
 * explicitly; there are no silent fallbacks. Failures are collected so the
 * operator sees the complete list instead of one-at-a-time errors.
 */
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  APP_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive(),
  ALLOWED_ORIGINS: z.string().min(1),
  TIMEZONE: z.string().min(3),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_PREFIX: z.string().min(1),

  CREDENTIAL_ENCRYPTION_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ADMIN_BOOTSTRAP_TOKEN: z.string().min(32),
  // Self-service signup is opt-in. A platform that hosts a single organisation must not expose
  // an endpoint that lets anyone on the internet mint a workspace, so the default is 'false'.
  ALLOW_SELF_REGISTRATION: bool.default('false'),

  STORAGE_DRIVER: z.enum(['local', 's3']),
  STORAGE_LOCAL_ROOT: z.string().optional(),
  STORAGE_LOCAL_PUBLIC_BASE_URL: z.string().url().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),

  WORK_DIR: z.string().min(1),
  // Chunk size the browser is told to use. Must be small enough to fit through whatever proxy sits
  // in front of the API (Vercel proxies function payloads at 4.5 MB; S3/R2 multipart parts must be
  // at least 5 MiB, so a proxied S3 deployment needs one of the two limits relaxed).
  UPLOAD_PART_SIZE_MIB: z.coerce.number().int().min(1).max(64).default(16),
  AI_ENGINE_URL: z.string().url(),
  AI_ENGINE_API_KEY: z.string().min(8),
  VIDEO_PROCESSOR_URL: z.string().url(),
  VIDEO_PROCESSOR_API_KEY: z.string().min(8),

  // ---------------------------- Firebase Auth ----------------------------
  // Optional: when absent, email+password keeps working and the dashboard hides Google sign-in.
  // Server-side verification needs a service account; the web config below is public by design.
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FIREBASE_WEB_API_KEY: z.string().optional(),
  FIREBASE_WEB_AUTH_DOMAIN: z.string().optional(),
  FIREBASE_WEB_APP_ID: z.string().optional(),
  // An identity provider proves *who* you are; it does not prove you may use this deployment.
  // Default closed: a Google account must already exist in ClipForge unless an operator opts in.
  FIREBASE_ALLOW_NEW_USERS: bool.default('false'),
  FIREBASE_REQUIRE_VERIFIED_EMAIL: bool.default('true'),

  // ------------------------- Telegram notifications -------------------------
  // Optional: absent values disable notifications without touching any other feature. The token is
  // environment-only by design — it is never written to the database and never returned to a
  // browser, so an admin cannot leak it by taking a screenshot of the settings page.
  TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  TELEGRAM_CHAT_ID: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  TELEGRAM_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  TELEGRAM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),

  /**
   * SMTP for one-time codes and password-reset mail. All optional: with no SMTP_HOST the email
   * channel reports itself as unavailable instead of pretending to send, and `POST
   * /api/auth/security/overview` says so. StartTLS on 587 is the default because that is what every
   * free-tier relay (Brevo, Mailtrap, Gmail app passwords) supports.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  /** One-time-code policy. TTL in seconds, resend cooldown, and wrong-attempt budget. */
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(300),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  /** Optional dedicated secret for code hashing; falls back to SESSION_SECRET. */
  OTP_SECRET: z.string().optional(),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_TEXT_MODEL: z.string().optional(),
  GEMINI_VISION_MODEL: z.string().optional(),

  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REDIRECT_URI: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().optional(),
  META_REDIRECT_URI: z.string().optional(),

  // Unit economics. Defaults reflect published list prices for the hosted model and free
  // self-hosted compute (faster-whisper, ffmpeg). Override per deployment; changing them does not
  // rewrite history, because each UsageRecord stores the cost computed when it was written.
  PRICE_GEMINI_INPUT_PER_1K_TOKENS: z.coerce.number().min(0).default(0.0001),
  PRICE_GEMINI_OUTPUT_PER_1K_TOKENS: z.coerce.number().min(0).default(0.0004),
  PRICE_VISION_INPUT_PER_1K_TOKENS: z.coerce.number().min(0).default(0.0001),
  PRICE_VISION_OUTPUT_PER_1K_TOKENS: z.coerce.number().min(0).default(0.0004),
  PRICE_TRANSCRIPTION_PER_SECOND: z.coerce.number().min(0).default(0),
  PRICE_RENDER_PER_SECOND: z.coerce.number().min(0).default(0),
  PRICE_STORAGE_PER_GB_MONTH: z.coerce.number().min(0).default(0.023),
  PRICE_PUBLISH_CALL: z.coerce.number().min(0).default(0),

  WORKER_CONCURRENCY_AI: z.coerce.number().int().positive().default(1),
  WORKER_CONCURRENCY_RENDER: z.coerce.number().int().positive().default(1),
  WORKER_CONCURRENCY_PUBLISH: z.coerce.number().int().positive().default(1),
  JOB_LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  JOB_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(20),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment — fix .env before starting:\n  ${issues}`);
  }
  // Storage driver specific requirements, checked here rather than defaulted.
  const env = parsed.data;
  if (env.STORAGE_DRIVER === 'local' && (!env.STORAGE_LOCAL_ROOT || !env.STORAGE_LOCAL_PUBLIC_BASE_URL)) {
    throw new Error('STORAGE_DRIVER=local requires STORAGE_LOCAL_ROOT and STORAGE_LOCAL_PUBLIC_BASE_URL');
  }
  // The public web config needs only FIREBASE_PROJECT_ID, so a project id on its own is a legitimate
  // (browser-configured, verifier-missing) deployment. The credential pair must not be split.
  const hasClientEmail = Boolean(env.FIREBASE_CLIENT_EMAIL);
  const hasPrivateKey = Boolean(env.FIREBASE_PRIVATE_KEY);
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON && hasClientEmail !== hasPrivateKey) {
    throw new Error(
      'Firebase Auth is half-configured: FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set together ' +
        '(or provide the whole thing as FIREBASE_SERVICE_ACCOUNT_JSON, or neither for password-only login).',
    );
  }
  if (hasClientEmail && hasPrivateKey && !env.FIREBASE_PROJECT_ID) {
    throw new Error('Firebase Auth has credentials but no FIREBASE_PROJECT_ID — add the project id (Firebase console → Project settings).');
  }
  // Validate the Telegram configuration at boot rather than at the first failed notification:
  // a malformed token is a deploy-time mistake, and the operator should see it in the boot log.
  if (env.TELEGRAM_BOT_TOKEN && !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN)) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is malformed: it must look like "<bot id>:<35+ character secret>" — copy it from BotFather (@BotFather → /mybots → API Token).',
    );
  }
  if (env.TELEGRAM_CHAT_ID && !/^-?\d{4,20}$/.test(env.TELEGRAM_CHAT_ID) && !/^@[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_CHAT_ID)) {
    throw new Error('TELEGRAM_CHAT_ID is malformed: use a numeric chat id (e.g. -1001234567890) or @channelusername.');
  }
  if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.S3_REGION)) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
  }
  cached = env;
  return env;
}

/** Test-only: drop the cached value so a test can exercise a different configuration. */
export function resetEnvCache(): void {
  cached = null;
}

export const env = new Proxy({} as AppEnv, {
  get: (_t, prop: string) => (loadEnv() as Record<string, unknown>)[prop],
});
