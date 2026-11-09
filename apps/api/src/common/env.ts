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
  AI_ENGINE_URL: z.string().url(),
  AI_ENGINE_API_KEY: z.string().min(8),
  VIDEO_PROCESSOR_URL: z.string().url(),
  VIDEO_PROCESSOR_API_KEY: z.string().min(8),

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
  if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.S3_REGION)) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
  }
  cached = env;
  return env;
}

export const env = new Proxy({} as AppEnv, {
  get: (_t, prop: string) => (loadEnv() as Record<string, unknown>)[prop],
});
