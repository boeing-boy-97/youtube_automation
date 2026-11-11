import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildHelmetOptions } from '../../apps/api/src/common/security-headers';

/**
 * The security headers are the one class of feature that can be silently lost: nothing in the app
 * breaks when a header stops being sent, so only a test keeps it honest. These assertions run the
 * real helmet middleware over a real express app, so they prove what a client actually receives
 * rather than what a config object says it should.
 */

function probe(options: ReturnType<typeof buildHelmetOptions>) {
  const app = express();
  app.use(helmet(options));
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  return request(app).get('/ping');
}

describe('API security headers', () => {
  const production = () => probe(buildHelmetOptions(true));

  it('sends the strictest possible CSP in production', async () => {
    const response = await production();
    const csp = response.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // No allow-list of script/style origins: an API never renders HTML, so nothing can load.
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('refuses framing, sniffing and referrer leakage', async () => {
    const response = await production();
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sends HSTS only in production', async () => {
    expect((await production()).headers['strict-transport-security']).toContain('max-age=15552000');
    const dev = await probe(buildHelmetOptions(false));
    expect(dev.headers['strict-transport-security']).toBeUndefined();
  });

  it('relaxes CSP outside production so Swagger UI can render, and nothing else', async () => {
    const dev = await probe(buildHelmetOptions(false));
    // A dev-only documentation page must not be the reason production ships a loose policy, and
    // equally the dev server must not be broken by a policy written for JSON-only responses.
    expect(dev.headers['content-security-policy']).toBeUndefined();
    expect(dev.headers['x-frame-options']).toBe('DENY');
    expect(dev.headers['x-content-type-options']).toBe('nosniff');
  });
});
