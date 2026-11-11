import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The dashboard serves HTML, so its policy is the one that can break the product if it is written
 * wrong, and the one that silently disappears if it is deleted. These tests read the real
 * `next.config.ts` and assert both properties: everything a browser needs is allowed, everything it
 * does not need is denied.
 *
 * The config decides dev vs production behaviour at module load, so each case re-imports it with the
 * environment it wants (a single import would freeze whichever NODE_ENV ran first).
 */

const ORIGINAL_ENV = process.env.NODE_ENV;

async function load(nodeEnv: string) {
  vi.resetModules();
  // The config also reads hosting variables; clear them so a machine that has them set cannot make
  // this test behave differently from CI.
  delete process.env.VERCEL;
  delete process.env.NETLIFY;
  delete process.env.CI_HOSTED_BUILD;
  process.env.NODE_ENV = nodeEnv;
  const module = await import('../../apps/web/next.config');
  return module.default;
}

async function headersFor(nodeEnv: string) {
  const config = await load(nodeEnv);
  const rules = await config.headers!();
  const rule = rules.find((entry) => entry.source === '/(.*)');
  expect(rule, 'no catch-all header rule').toBeTruthy();
  return Object.fromEntries(rule!.headers.map((header) => [header.key, header.value]));
}

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV;
});

describe('dashboard security headers', () => {
  it('sets a Content-Security-Policy on every response', async () => {
    const headers = await headersFor('production');
    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Content-Security-Policy']).toContain("base-uri 'self'");
    expect(headers['Content-Security-Policy']).toContain("form-action 'self'");
  });

  it('lets the browser reach only its own origin plus Firebase sign-in', async () => {
    const csp = (await headersFor('production'))['Content-Security-Policy'];
    const connect = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src'))!;
    // The browser never calls the API directly: /api and /media are rewrites on this same origin.
    // So a second origin here would be a mistake, and '*' would be a hole.
    expect(connect).toContain("'self'");
    expect(connect).not.toContain('*');
    expect(connect).toContain('https://identitytoolkit.googleapis.com');
    expect(connect.split(/\s+/).filter((token) => token.includes('://'))).toEqual([
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
      'https://www.googleapis.com',
    ]);
  });

  it('drops eval from scripts and upgrades insecure requests in production only', async () => {
    const production = (await headersFor('production'))['Content-Security-Policy'];
    expect(production).not.toContain('unsafe-eval');
    expect(production).toContain('upgrade-insecure-requests');

    const dev = (await headersFor('development'))['Content-Security-Policy'];
    // React Fast Refresh needs eval; without it `next dev` does not work at all.
    expect(dev).toContain('unsafe-eval');
    expect(dev).not.toContain('upgrade-insecure-requests');
  });

  it('sends the non-CSP hardening headers', async () => {
    const headers = await headersFor('production');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Permissions-Policy']).toContain('microphone=()');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Strict-Transport-Security']).toContain('max-age=');
  });

  it('keeps lint inside the build and does not advertise the framework', async () => {
    const config = await load('production');
    // A rule that catches a real bug must be able to fail a deploy; this was previously skipped.
    expect(config.eslint?.ignoreDuringBuilds ?? false).toBe(false);
    expect(config.poweredByHeader).toBe(false);
  });
});
