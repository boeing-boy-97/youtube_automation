import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

let encryptSecret: (plaintext: string) => { v: 1; iv: string; tag: string; ct: string };
let decryptSecret: (envelope: { v: 1; iv: string; tag: string; ct: string }) => string;
let hmacToken: (value: string, purpose?: string) => string;

beforeAll(async () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const module = await import('@clipforge/database');
  encryptSecret = module.encryptSecret;
  decryptSecret = module.decryptSecret;
  hmacToken = module.hmacToken;
});

describe('credential encryption (AES-256-GCM)', () => {
  it('round-trips a refresh token', () => {
    const envelope = encryptSecret('1//refresh-token-value');
    expect(envelope.v).toBe(1);
    expect(envelope.ct).not.toContain('refresh-token-value');
    expect(decryptSecret(envelope)).toBe('1//refresh-token-value');
  });

  it('uses a fresh IV per encryption', () => {
    const a = encryptSecret('same-input');
    const b = encryptSecret('same-input');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('detects tampering with the ciphertext', () => {
    const envelope = encryptSecret('secret');
    const tampered = { ...envelope, ct: Buffer.from('tampered').toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('refuses to hash a token when the session secret is not configured', () => {
    const previous = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    expect(() => hmacToken('session-token')).toThrow();
    if (previous !== undefined) process.env.SESSION_SECRET = previous;
  });

  it('HMACs are deterministic, purpose-scoped and never contain the input', () => {
    const hash = hmacToken('session-token');
    expect(hash).toBe(hmacToken('session-token'));
    expect(hash).not.toContain('session-token');
    expect(hash).not.toBe(hmacToken('session-token', 'csrf'));
    expect(hash).not.toBe(hmacToken('session-token-2'));
  });
});
