import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Request } from 'express';
import { appendAuditLog, prisma, timingSafeEqual } from '@clipforge/database';
import { ConfigurationService } from '@clipforge/database';
import type { BootstrapInput, LoginInput, RegisterInput } from '@clipforge/validation';
import { env } from '../common/env';
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
  constructor(private readonly sessions: SessionService) {}

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
    const ok = await argon2.verify(user.passwordHash, input.password);
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
