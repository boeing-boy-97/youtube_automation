import crypto from 'node:crypto';

/**
 * Cryptography helpers.
 *
 * - OAuth tokens are encrypted at rest with AES-256-GCM using
 *   CREDENTIAL_ENCRYPTION_KEY (32 bytes, base64). Ciphertext is stored as JSON
 *   `{v, iv, tag, ct}` in a JSON column so it survives schema round-trips.
 * - Session tokens and CSRF tokens are stored only as SHA-256 HMACs.
 */
export interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

function encryptionKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('CONFIGURATION_REQUIRED: CREDENTIAL_ENCRYPTION_KEY is not set');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32)');
  }
  return key;
}

export function encryptSecret(plaintext: string): EncryptedEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

export function decryptSecret(envelope: unknown): string {
  const e = envelope as EncryptedEnvelope;
  if (!e || e.v !== 1 || !e.iv || !e.tag || !e.ct) {
    throw new Error('Malformed encrypted credential envelope');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(e.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(e.ct, 'base64')), decipher.final()]).toString('utf8');
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('CONFIGURATION_REQUIRED: SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hmacToken(rawToken: string, purpose = 'session'): string {
  return crypto.createHmac('sha256', sessionSecret()).update(`${purpose}:${rawToken}`).digest('hex');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = require('node:fs').createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
