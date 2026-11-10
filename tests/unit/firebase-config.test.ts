/**
 * Firebase Auth must degrade honestly: absent configuration hides Google sign-in instead of
 * throwing at boot, and a *half*-configured deployment fails loudly instead of silently rejecting
 * every Google login at 3am.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

/** A real PEM, so the failure being tested is the missing web config — not a parse error. */
const TEST_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const ENV_KEYS = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'FIREBASE_WEB_API_KEY',
  'FIREBASE_WEB_AUTH_DOMAIN',
  'FIREBASE_WEB_APP_ID',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'http://127.0.0.1:3000';
  process.env.API_PORT = '4000';
  process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:3000';
  process.env.TIMEZONE = 'Asia/Kolkata';
  process.env.DATABASE_URL = 'postgresql://x/y';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.REDIS_PREFIX = 'test';
  process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(32);
  process.env.SESSION_SECRET = 'b'.repeat(48);
  process.env.ADMIN_BOOTSTRAP_TOKEN = 'c'.repeat(48);
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_ROOT = '/tmp/x';
  process.env.STORAGE_LOCAL_PUBLIC_BASE_URL = 'http://127.0.0.1:4000';
  process.env.WORK_DIR = '/tmp/w';
  process.env.AI_ENGINE_URL = 'http://127.0.0.1:8100';
  process.env.AI_ENGINE_API_KEY = 'key-ai-engine';
  process.env.VIDEO_PROCESSOR_URL = 'http://127.0.0.1:8200';
  process.env.VIDEO_PROCESSOR_API_KEY = 'key-video-proc';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function loadModules() {
  const envModule = await import('../../apps/api/src/common/env');
  envModule.resetEnvCache();
  return envModule;
}

describe('Firebase configuration', () => {
  it('is disabled, not broken, when nothing is configured', async () => {
    const { env } = await loadModules();
    expect(env.FIREBASE_ALLOW_NEW_USERS).toBe(false);
    expect(env.FIREBASE_REQUIRE_VERIFIED_EMAIL).toBe(true);
    await loadModules();
    const { FirebaseService } = await import('../../apps/api/src/auth/firebase.service');
    const service = new FirebaseService();
    expect(service.configured).toBe(false);
    expect(service.webConfig()).toBeNull();
    expect(service.configurationError).toBeNull();
  });

  it('refuses to boot when the credential pair is split', async () => {
    process.env.FIREBASE_PROJECT_ID = 'demo-project';
    process.env.FIREBASE_CLIENT_EMAIL = 'svc@demo-project.iam.gserviceaccount.com';
    const { env } = await loadModules();
    expect(() => env.FIREBASE_PROJECT_ID).toThrow(/half-configured/i);
    expect(() => env.FIREBASE_PROJECT_ID).toThrow(/FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set together/);
  });

  it('accepts a project id on its own: that is the public web config without a verifier', async () => {
    process.env.FIREBASE_PROJECT_ID = 'demo-project';
    process.env.FIREBASE_WEB_API_KEY = 'web-api-key';
    const { env } = await loadModules();
    expect(env.FIREBASE_PROJECT_ID).toBe('demo-project');
    expect(env.FIREBASE_CLIENT_EMAIL).toBeUndefined();
    await loadModules();
    const { FirebaseService } = await import('../../apps/api/src/auth/firebase.service');
    const service = new FirebaseService();
    expect(service.webConfigured).toBe(true);
    expect(service.configured).toBe(false);
    expect(service.fullyConfigured).toBe(false);
    // And it says which half is missing instead of a generic "not configured".
    expect(service.missing).toMatch(/no service account/i);
  });

  it('says the browser config is missing when only the verifier exists', async () => {
    process.env.FIREBASE_PROJECT_ID = 'demo-project';
    process.env.FIREBASE_CLIENT_EMAIL = 'svc@demo-project.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = TEST_PRIVATE_KEY;
    delete process.env.FIREBASE_WEB_API_KEY;
    const { env } = await loadModules(); // drop the previous test's cached config
    expect(env.FIREBASE_WEB_API_KEY).toBeUndefined();
    await loadModules();
    const { FirebaseService } = await import('../../apps/api/src/auth/firebase.service');
    const service = new FirebaseService();
    expect(service.webConfigured).toBe(false);
    expect(service.missing).toMatch(/browser has no web config/i);
  });

  it('serves the public web config from the API, without the private key', async () => {
    process.env.FIREBASE_PROJECT_ID = 'demo-project';
    process.env.FIREBASE_CLIENT_EMAIL = 'svc@demo-project.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----\\n';
    process.env.FIREBASE_WEB_API_KEY = 'web-api-key';
    process.env.FIREBASE_WEB_APP_ID = '1:2:web:3';
    await loadModules();
    await loadModules();
    const { FirebaseService } = await import('../../apps/api/src/auth/firebase.service');
    const service = new FirebaseService();
    const config = service.webConfig();
    expect(config).toMatchObject({ apiKey: 'web-api-key', projectId: 'demo-project', authDomain: 'demo-project.firebaseapp.com' });
    expect(JSON.stringify(config)).not.toContain('PRIVATE KEY');
  });

  it('reports a verification attempt as unconfigured instead of throwing a 500', async () => {
    await loadModules();
    await loadModules();
    const { FirebaseService } = await import('../../apps/api/src/auth/firebase.service');
    const service = new FirebaseService();
    await expect(service.verifyIdToken('x'.repeat(80))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FIREBASE_NOT_CONFIGURED' }),
    });
  });
});
