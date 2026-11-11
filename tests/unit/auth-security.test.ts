/**
 * Unit tests for the pieces of the security feature that are pure logic: code generation, the
 * hashing scheme, masking, device labels, and the SMTP configuration parsing.
 *
 * Anything that needs a database, an SMTP server or a session lives in the integration and E2E
 * suites — mocking those here would only test the mock.
 */
import { describe, expect, it } from 'vitest';
import { OtpService } from '../../apps/api/src/auth/otp.service';
import { EmailService, maskAddress } from '../../apps/api/src/common/services/email.service';
import { describeDevice } from '../../apps/api/src/auth/security.service';
import { PASSWORD_HASH_OPTIONS } from '../../apps/api/src/auth/password-hash';

describe('one-time code generation', () => {
  it('always formats to exactly six digits, including small values', () => {
    for (const value of [0, 1, 42, 999, 1_000, 32_767, 999_998, 999_999]) {
      const code = OtpService.formatCode(value);
      expect(code).toMatch(/^\d{6}$/);
      expect(Number(code)).toBe(value);
    }
  });

  it('produces codes inside the six-digit space', () => {
    for (let i = 0; i < 200; i += 1) {
      const value = OtpService.generateCode();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1_000_000);
    }
  });

  it('does not repeat itself over a realistic sample', () => {
    const sample = new Set(Array.from({ length: 100 }, () => OtpService.formatCode(OtpService.generateCode())));
    // 100 draws from 10^6 values: a collision is possible but would signal a broken generator.
    expect(sample.size).toBeGreaterThan(95);
  });
});

describe('code hashing', () => {
  it('is deterministic for the same challenge and code', () => {
    expect(OtpService.hashCode('c-1', '123456')).toBe(OtpService.hashCode('c-1', '123456'));
  });

  it('salts by challenge, so the same code hashes differently per challenge', () => {
    expect(OtpService.hashCode('c-1', '123456')).not.toBe(OtpService.hashCode('c-2', '123456'));
  });

  it('never contains the code itself', () => {
    const hash = OtpService.hashCode('c-1', '123456');
    expect(hash).not.toContain('123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies only the exact code, and rejects malformed hashes without throwing', () => {
    const hash = OtpService.hashCode('c-1', '123456');
    expect(OtpService.verifyHash('c-1', '123456', hash)).toBe(true);
    expect(OtpService.verifyHash('c-1', '123457', hash)).toBe(false);
    expect(OtpService.verifyHash('c-2', '123456', hash)).toBe(false);
    expect(OtpService.verifyHash('c-1', '123456', 'not-hex')).toBe(false);
  });
});

describe('masking', () => {
  it('keeps the domain and hides the local part', () => {
    expect(maskAddress('someone@example.com')).toBe('s•••e@example.com');
    expect(maskAddress('admin@clipforge.local')).toBe('a•••n@clipforge.local');
  });

  it('degrades gracefully on short and malformed input', () => {
    expect(maskAddress('a@b.co')).toBe('a@b.co');
    expect(maskAddress('no-at-sign')).toBe('•••');
    expect(maskAddress('')).toBe('•••');
  });
});

describe('SMTP configuration', () => {
  const original = { ...process.env };
  const restore = () => {
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  };

  it('reports itself unconfigured without a host or a sender', () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    expect(EmailService.configFromEnv()).toBeNull();
    const service = new EmailService({ config: null });
    expect(service.configured).toBe(false);
    // `describe()` is what the security overview and the diagnostics page report: no secrets, just
    // whether the channel can deliver and where from.
    expect(service.describe()).toMatchObject({ configured: false, host: null, from: null });
  });

  it('reads host, port, TLS and sender from the environment', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    process.env.SMTP_FROM = 'ClipForge <no-reply@example.com>';
    const config = EmailService.configFromEnv();
    restore();
    expect(config).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true, user: 'user', from: 'ClipForge <no-reply@example.com>' });
  });

  it('defaults to port 587 without TLS, which is what starttls relays expect', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'no-reply@example.com';
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURE;
    const config = EmailService.configFromEnv();
    restore();
    expect(config).toMatchObject({ port: 587, secure: false });
  });

  it('refuses to pretend it delivered when it has no transport', async () => {
    const service = new EmailService({ config: null });
    const result = await service.send({ to: 'someone@example.com', subject: 'x', text: 'y' });
    expect(result.delivered).toBe(false);
    expect(result.notConfigured).toBe(true);
  });

  it('reports transport failures instead of throwing into the caller', async () => {
    const service = new EmailService({
      config: { host: 'smtp.example.com', port: 587, secure: false, from: 'no-reply@example.com', user: null, pass: null },
      transport: {
        sendMail: async () => {
          throw new Error('553 relay access denied');
        },
      } as never,
    });
    const result = await service.send({ to: 'someone@example.com', subject: 'x', text: 'y' });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('relay access denied');
  });
});

describe('device labels', () => {
  it('names the browser and platform a login came from', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0 Safari/537.36')).toContain('Chrome');
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64) Firefox/133.0')).toContain('Firefox');
    expect(describeDevice('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1')).toMatch(/Safari|iOS/);
    expect(describeDevice('python-urllib/3.13')).toBe('Python client');
  });

  it('says so when there is no user agent', () => {
    expect(describeDevice(null)).toBe('Unknown device');
    expect(describeDevice('')).toBe('Unknown device');
  });
});

describe('password hashing parameters', () => {
  it('uses argon2id at or above the OWASP minimum', () => {
    expect(PASSWORD_HASH_OPTIONS.type).toBe(2); // argon2id
    expect(PASSWORD_HASH_OPTIONS.memoryCost ?? 0).toBeGreaterThanOrEqual(19_456);
    expect(PASSWORD_HASH_OPTIONS.timeCost ?? 0).toBeGreaterThanOrEqual(2);
  });
});
