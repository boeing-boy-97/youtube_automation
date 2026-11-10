import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Request } from 'express';
import { appendAuditLog, prisma, timingSafeEqual } from '@clipforge/database';
import { ConfigurationService } from '@clipforge/database';
import type { BootstrapInput, LoginInput, RegisterInput } from '@clipforge/validation';
import { env } from '../common/env';
import { FirebaseService, type FirebaseIdentity } from './firebase.service';
import { SessionService } from './session.service';

const MAX_FAILED_ATTEMPTS = 10;
const LOCK_MINUTES = 15;

export const PASSWORD_HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB — OWASP 2024 minimum for argon2id
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class AuthService {
  constructor(
    private readonly sessions: SessionService,
    private readonly firebase: FirebaseService,
  ) {}

  /**
   * One-time administrator bootstrap. Refuses once any user exists, so there is
   * no permanently privileged public account and no default credentials.
   */
  async bootstrap(input: BootstrapInput, request: Request) {
    const expected = env.ADMIN_BOOTSTRAP_TOKEN;
    if (!expected || !timingSafeEqual(expected, input.bootstrapToken)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Invalid bootstrap token' });
    }
    const existing = await prisma.user.count();
    if (existing > 0) {
      throw new ConflictException({ code: 'CONFLICT', message: 'Bootstrap already completed — a user account exists' });
    }

    const passwordHash = await argon2.hash(input.password, PASSWORD_HASH_OPTIONS);
    const slug = slugify(input.workspaceName);

    const { user, workspace } = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: { email: input.email, passwordHash, displayName: input.displayName, role: 'OWNER', emailVerified: true },
      });
      const createdWorkspace = await tx.workspace.create({
        data: { name: input.workspaceName, slug, timezone: env.TIMEZONE },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: createdWorkspace.id, userId: createdUser.id, role: 'OWNER' },
      });
      return { user: createdUser, workspace: createdWorkspace };
    });

    await appendAuditLog({
      workspaceId: workspace.id,
      userId: user.id,
      action: 'AUTH_BOOTSTRAP',
      summary: `Administrator account bootstrapped for ${user.email}`,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? null,
    });

    return this.issueSession(user.id, request);
  }

  async register(input: RegisterInput, request: Request) {
    const email = input.email;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException({ code: 'CONFLICT', message: 'An account with this email already exists' });

    const passwordHash = await argon2.hash(input.password, PASSWORD_HASH_OPTIONS);
    const workspaceName = input.workspaceName ?? `${input.displayName}'s workspace`;
    let slug = slugify(workspaceName);
    if (await prisma.workspace.findUnique({ where: { slug } })) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;

    const { user, workspace } = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: { email, passwordHash, displayName: input.displayName, role: 'OWNER' },
      });
      const createdWorkspace = await tx.workspace.create({ data: { name: workspaceName, slug, timezone: null } });
      await tx.workspaceMember.create({ data: { workspaceId: createdWorkspace.id, userId: createdUser.id, role: 'OWNER' } });
      return { user: createdUser, workspace: createdWorkspace };
    });

    await appendAuditLog({
      workspaceId: workspace.id,
      userId: user.id,
      action: 'USER_CREATED',
      summary: `Account created for ${email}`,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? null,
    });
    return this.issueSession(user.id, request);
  }

  async login(input: LoginInput, request: Request) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    // Uniform failure message: never disclose whether the email exists.
    const invalid = new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Invalid email or password' });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') throw invalid;
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Account temporarily locked after repeated failed logins' });
    }
    // A Google-only account has no hash. Verifying argon2.verify(undefined, …) would throw a 500,
    // so treat it exactly like a wrong password — the message must not reveal which case it is.
    const ok = user.passwordHash ? await argon2.verify(user.passwordHash, input.password) : false;
    if (!ok) {
      const attempts = user.failedLoginAttempts + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      throw invalid;
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const session = await this.issueSession(user.id, request);
    await appendAuditLog({
      workspaceId: session.workspaceId,
      userId: user.id,
      action: 'AUTH_LOGIN',
      summary: `Login from ${request.ip ?? 'unknown ip'}`,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? null,
    });
    return session;
  }

  /**
   * Sign in with a Firebase ID token (Google, or any provider enabled in the Firebase project).
   *
   * The token proves identity; authorisation is still decided here:
   *  - an unknown email is refused unless FIREBASE_ALLOW_NEW_USERS=true,
   *  - a Firebase identity already linked to another row is refused (no account takeover by
   *    re-using an email at a second provider),
   *  - disabled/deleted users are refused before any session is issued.
   * The resulting session is identical to a password login: same cookie, same CSRF, same audit log.
   */
  async loginWithFirebase(idToken: string, request: Request) {
    const identity = await this.firebase.verifyIdToken(idToken);
    const user = await this.resolveFirebaseUser(identity);
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
    });
    const session = await this.issueSession(user.id, request);
    await appendAuditLog({
      workspaceId: session.workspaceId,
      userId: user.id,
      action: 'AUTH_LOGIN',
      summary: `Login via ${identity.signInProvider} from ${request.ip ?? 'unknown ip'}`,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? null,
    });
    return session;
  }

  /**
   * Maps a verified provider identity onto a ClipForge user, or refuses.
   *
   * Kept separate from token verification and from session issuing so the rules below can be
   * tested directly — they are the security-relevant part, and they must never be implied by the
   * client. Rules:
   *  - an unknown email is refused unless FIREBASE_ALLOW_NEW_USERS=true,
   *  - a Firebase identity already linked to another row is refused,
   *  - an inactive or deleted account is refused before any session exists,
   *  - an unverified provider email is refused when FIREBASE_REQUIRE_VERIFIED_EMAIL=true,
   *  - an existing password account is *linked*, never replaced: its password keeps working.
   */
  async resolveFirebaseUser(identity: FirebaseIdentity) {
    if (!identity.email) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'That Google account did not share an email address, so it cannot be matched to a ClipForge user.',
      });
    }
    if (env.FIREBASE_REQUIRE_VERIFIED_EMAIL && !identity.emailVerified) {
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'That Google account’s email is not verified. Verify it with the provider, then try again.',
      });
    }

    const email = identity.email;
    let user = await prisma.user.findFirst({ where: { OR: [{ firebaseUid: identity.uid }, { email }] } });

    if (user) {
      if (user.deletedAt || user.status !== 'ACTIVE') {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'This account is not active' });
      }
      if (user.firebaseUid && user.firebaseUid !== identity.uid) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'This email is already linked to a different Google account. Sign in with the account you used before.',
        });
      }
      if (!user.firebaseUid) {
        // First Google sign-in for an existing password account: link, never merge.
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            firebaseUid: identity.uid,
            emailVerified: identity.emailVerified || user.emailVerified,
            avatarUrl: identity.picture ?? user.avatarUrl,
          },
        });
      }
      return user;
    }

    if (!env.FIREBASE_ALLOW_NEW_USERS) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message:
          'No ClipForge account uses this Google address. Ask an administrator to create one, or enable FIREBASE_ALLOW_NEW_USERS.',
      });
    }
    return this.createFirebaseUser(identity);
  }

  /** Provisioning path for FIREBASE_ALLOW_NEW_USERS: a Google user gets their own workspace. */
  private async createFirebaseUser(identity: FirebaseIdentity) {
    const email = identity.email as string;
    const displayName = identity.name?.trim() || email.split('@')[0];
    const workspaceName = `${displayName}'s workspace`;
    let slug = slugify(workspaceName);
    if (await prisma.workspace.findUnique({ where: { slug } })) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const { user, workspace } = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            email,
            displayName,
            role: 'OWNER',
            passwordHash: null,
            firebaseUid: identity.uid,
            avatarUrl: identity.picture,
            emailVerified: identity.emailVerified,
          },
        });
        const createdWorkspace = await tx.workspace.create({ data: { name: workspaceName, slug, timezone: null } });
        await tx.workspaceMember.create({ data: { workspaceId: createdWorkspace.id, userId: createdUser.id, role: 'OWNER' } });
        return { user: createdUser, workspace: createdWorkspace };
      });
      await appendAuditLog({
        workspaceId: workspace.id,
        userId: user.id,
        action: 'USER_CREATED',
        summary: `Account provisioned by Google sign-in for ${email}`,
      });
      return user;
    } catch (error) {
      // Two simultaneous first sign-ins race on the unique email/uid; the loser adopts the winner.
      const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { firebaseUid: identity.uid }] } });
      if (existing) return existing;
      throw error;
    }
  }

  private async issueSession(userId: string, request: Request) {
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'User has no workspace' });
    const { rawToken, csrfToken, expiresAt } = await this.sessions.create(userId, request);
    void expiresAt;
    return {
      rawToken,
      csrfToken,
      workspaceId: membership.workspaceId,
      userId,
    };
  }

  /** Aggregated view for GET /api/auth/session. */
  async describeSession(context: {
    userId: string;
    workspaceId: string;
  }) {
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: context.userId, workspaceId: context.workspaceId },
      include: { user: true, workspace: true },
    });
    if (!membership) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Session workspace no longer accessible' });

    const configService = new ConfigurationService(context.workspaceId);
    // NB: a successful resolution still carries a `missing: []` property, so readiness must be
    // tracked with an explicit flag rather than by testing for the presence of the property.
    const processing = await configService
      .requireForProcessing()
      .then(() => ({ ready: true, missing: [] as string[] }))
      .catch((e: Error & { missing?: string[] }) => ({ ready: false, missing: e.missing ?? (['unknown'] as string[]) }));
    const publishing = await configService
      .requireForPublishing()
      .then(() => ({ ready: true, missing: [] as string[] }))
      .catch((e: Error & { missing?: string[] }) => ({ ready: false, missing: e.missing ?? (['unknown'] as string[]) }));
    const integration = ConfigurationService.integrationStatus();

    return {
      user: {
        id: membership.user.id,
        email: membership.user.email,
        displayName: membership.user.displayName,
        role: membership.role,
        avatarUrl: membership.user.avatarUrl,
        authMethods: [
          ...(membership.user.passwordHash ? ['PASSWORD'] : []),
          ...(membership.user.firebaseUid ? ['GOOGLE'] : []),
        ],
      },
      workspace: {
        id: membership.workspace.id,
        name: membership.workspace.name,
        slug: membership.workspace.slug,
        timezone: membership.workspace.timezone,
      },
      configuration: {
        processingReady: processing.ready,
        publishingReady: publishing.ready,
        missing: Array.from(new Set([...processing.missing, ...publishing.missing])),
      },
      integrations: integration,
    };
  }
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : `workspace-${Math.random().toString(36).slice(2, 8)}`;
}
