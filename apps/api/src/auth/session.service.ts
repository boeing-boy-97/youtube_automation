import { Injectable } from '@nestjs/common';
import { prisma, generateOpaqueToken, hmacToken, timingSafeEqual } from '@clipforge/database';
import type { Request } from 'express';

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  workspaceTimezone: string | null;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class SessionService {
  static readonly COOKIE_NAME = 'cf_session';
  static readonly CSRF_COOKIE = 'cf_csrf_presence';
  static readonly TTL_MS = SESSION_TTL_MS;

  /** Creates a session row; returns the raw token to be set as an httpOnly cookie. */
  async create(
    userId: string,
    request: Request,
  ): Promise<{ sessionId: string; rawToken: string; csrfToken: string; expiresAt: Date }> {
    const rawToken = generateOpaqueToken(32);
    const csrfToken = generateOpaqueToken(24);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const row = await prisma.session.create({
      data: {
        userId,
        tokenHash: hmacToken(rawToken),
        csrfHash: sha256(csrfToken),
        userAgent: request.get('user-agent')?.slice(0, 400) ?? null,
        ipAddress: request.ip ?? null,
        expiresAt,
      },
    });
    this.csrfCache.set(row.id, row.csrfHash);
    return { sessionId: row.id, rawToken, csrfToken, expiresAt };
  }

  async validate(rawToken: string, request: Request): Promise<AuthenticatedSession | null> {
    const tokenHash = hmacToken(rawToken);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            memberships: { include: { workspace: true }, orderBy: { createdAt: 'asc' }, take: 1 },
          },
        },
      },
    });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() < Date.now()) return null;
    if (session.user.status !== 'ACTIVE' || session.user.deletedAt) return null;
    const membership = session.user.memberships[0];
    if (!membership) return null;

    // Sliding last-seen, throttled to once per minute to avoid write amplification.
    if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
      await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    }
    void request;

    return {
      sessionId: session.id,
      userId: session.userId,
      email: session.user.email,
      displayName: session.user.displayName,
      role: membership.role,
      workspaceId: membership.workspaceId,
      workspaceName: membership.workspace.name,
      workspaceSlug: membership.workspace.slug,
      workspaceTimezone: membership.workspace.timezone,
    };
  }

  /**
   * CSRF verification is synchronous against an in-process cache of the session's
   * csrf hash; the cache is populated on session creation and validation.
   */
  private readonly csrfCache = new Map<string, string>();

  /** Rotates the CSRF secret for an existing session and returns the new raw token. */
  reissueCsrf(sessionId: string): string {
    const token = generateOpaqueToken(24);
    this.csrfCache.set(sessionId, sha256(token));
    void prisma.session
      .update({ where: { id: sessionId }, data: { csrfHash: sha256(token) } })
      .catch(() => undefined);
    return token;
  }

  rememberCsrf(sessionId: string, csrfToken: string): void {
    this.csrfCache.set(sessionId, sha256(csrfToken));
  }

  async verifyCsrf(sessionId: string, presentedToken: string): Promise<boolean> {
    const presented = sha256(presentedToken);
    const cached = this.csrfCache.get(sessionId);
    if (cached) return timingSafeEqual(cached, presented);
    // Cache miss (e.g. API restarted since the session was issued): trust the DB.
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { csrfHash: true, revokedAt: true } });
    if (!session || session.revokedAt) return false;
    this.csrfCache.set(sessionId, session.csrfHash);
    return timingSafeEqual(session.csrfHash, presented);
  }

  /**
   * Anonymous CSRF for pre-session routes (login/register/bootstrap).
   * Classic signed double-submit: GET /api/auth/csrf sets `cf_csrf` = token.signature
   * and returns the raw token; unsafe requests must echo it in `x-csrf-token`.
   */
  issueAnonymousCsrf(): { token: string; cookieValue: string } {
    const token = generateOpaqueToken(24);
    const signature = createHmac('sha256', env.SESSION_SECRET).update(token).digest('base64url');
    return { token, cookieValue: `${token}.${signature}` };
  }

  verifyAnonymousCsrf(cookieValue: string, presentedToken: string): boolean {
    const [token, signature] = cookieValue.split('.');
    if (!token || !signature) return false;
    const expected = createHmac('sha256', env.SESSION_SECRET).update(token).digest('base64url');
    if (!timingSafeEqual(expected, signature)) return false;
    return timingSafeEqual(token, presentedToken);
  }

  async revoke(sessionId: string): Promise<void> {
    await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
    this.csrfCache.delete(sessionId);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async listActive(userId: string) {
    return prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastSeenAt: true, expiresAt: true },
      orderBy: { lastSeenAt: 'desc' },
    });
  }
}

import { createHash, createHmac } from 'node:crypto';
import { env } from '../common/env';
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
