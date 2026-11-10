/**
 * Google sign-in decides who may enter the workspace. These tests drive `resolveFirebaseUser`
 * directly — token verification and session issuing are separate — against the real database, so
 * every rule (refusal, linking, provisioning) is proven rather than asserted in a comment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function loadEnv() {
  const text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^"|"$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
loadEnv();

type Identity = {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  signInProvider: string;
};

let prisma: typeof import('@clipforge/database').prisma;
let auth: InstanceType<typeof import('../../apps/api/src/auth/auth.service').AuthService>;
let resetEnvCache: () => void;

const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];
const suffix = randomUUID().slice(0, 8);

function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    uid: `uid-${randomUUID().slice(0, 8)}`,
    email: `google-${randomUUID().slice(0, 8)}@clipforge.test`,
    emailVerified: true,
    name: 'Google Person',
    picture: 'https://example.test/avatar.png',
    signInProvider: 'google.com',
    ...overrides,
  };
}

async function makeUser(overrides: Record<string, unknown> = {}) {
  const email = (overrides.email as string) ?? `existing-${randomUUID().slice(0, 8)}@clipforge.test`;
  const user = await prisma.user.create({
    data: { email, displayName: 'Existing User', passwordHash: 'argon2-hash-placeholder', ...overrides },
  });
  createdUsers.push(user.id);
  return user;
}

beforeAll(async () => {
  const database = await import('@clipforge/database');
  prisma = database.prisma;
  const envModule = await import('../../apps/api/src/common/env');
  resetEnvCache = envModule.resetEnvCache;
  const { AuthService } = await import('../../apps/api/src/auth/auth.service');
  // Token verification is exercised separately (tests/unit/firebase-config.test.ts); here the
  // scheduler-facing rules are what matter, so the verifier is a stub.
  auth = new AuthService({} as never, {} as never);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaces } } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('Google sign-in identity mapping', () => {
  it('refuses an unknown Google account when self-provisioning is off (default)', async () => {
    process.env.FIREBASE_ALLOW_NEW_USERS = 'false';
    resetEnvCache();
    await expect(auth.resolveFirebaseUser(identity())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FORBIDDEN' }),
    });
    await expect(auth.resolveFirebaseUser(identity())).rejects.toThrow(/No ClipForge account uses this Google address/);
  });

  it('links the first Google sign-in to an existing password account without touching its password', async () => {
    const user = await makeUser();
    const google = identity({ email: user.email });
    const resolved = await auth.resolveFirebaseUser(google);
    expect(resolved.id).toBe(user.id);
    expect(resolved.firebaseUid).toBe(google.uid);
    expect(resolved.passwordHash).toBe('argon2-hash-placeholder');
    expect(resolved.avatarUrl).toBe(google.picture);
  });

  it('is idempotent: the same Firebase identity resolves to the same row every time', async () => {
    const user = await makeUser();
    const google = identity({ email: user.email });
    const first = await auth.resolveFirebaseUser(google);
    const second = await auth.resolveFirebaseUser(google);
    expect(second.id).toBe(first.id);
    expect(await prisma.user.count({ where: { firebaseUid: google.uid } })).toBe(1);
  });

  it('refuses a second, different Google account claiming an already-linked email', async () => {
    const user = await makeUser();
    const google = identity({ email: user.email });
    await auth.resolveFirebaseUser(google);
    await expect(auth.resolveFirebaseUser(identity({ email: user.email }))).rejects.toThrow(/already linked to a different Google account/);
  });

  it('refuses a suspended account before any session could exist', async () => {
    const user = await makeUser({ status: 'SUSPENDED' });
    await expect(auth.resolveFirebaseUser(identity({ email: user.email }))).rejects.toThrow(/not active/);
  });

  it('refuses an unverified provider email by default', async () => {
    const user = await makeUser();
    await expect(auth.resolveFirebaseUser(identity({ email: user.email, emailVerified: false }))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EMAIL_NOT_VERIFIED' }),
    });
  });

  it('refuses an identity that shares no email address', async () => {
    await expect(auth.resolveFirebaseUser(identity({ email: null }))).rejects.toThrow(/did not share an email address/);
  });

  it('provisions a workspace when FIREBASE_ALLOW_NEW_USERS=true', async () => {
    process.env.FIREBASE_ALLOW_NEW_USERS = 'true';
    resetEnvCache();
    try {
      const google = identity({ name: 'Fresh Google User' });
      const user = await auth.resolveFirebaseUser(google);
      createdUsers.push(user.id);
      expect(user.email).toBe(google.email);
      expect(user.passwordHash).toBeNull();
      expect(user.firebaseUid).toBe(google.uid);
      expect(user.role).toBe('OWNER');
      const membership = await prisma.workspaceMember.findFirst({ where: { userId: user.id }, include: { workspace: true } });
      if (membership) createdWorkspaces.push(membership.workspaceId);
      expect(membership).not.toBeNull();
      expect(membership?.workspace.name).toContain('Fresh Google User');
    } finally {
      process.env.FIREBASE_ALLOW_NEW_USERS = 'false';
      resetEnvCache();
    }
  });
});
