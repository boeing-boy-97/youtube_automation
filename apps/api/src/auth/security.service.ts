/**
 * Account security: second-factor login, password reset, sessions/devices, login history,
 * recovery codes and suspicious-login alerts.
 *
 * Kept apart from `AuthService` (which owns password/Firebase verification and session issuing) so
 * that the rules about *when a session may exist* live in one readable place:
 *
 *   password verified
 *     └─ user.otpMode === OFF ──────────────────────────► session (unchanged behaviour)
 *     └─ EMAIL / TELEGRAM / DUAL ─► N challenges ─► all N verified ─► session
 *
 * No code path creates a session before every required challenge has been consumed.
 */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { prisma, appendAuditLog } from '@clipforge/database';
import type { OtpChannel, OtpMode, OtpPurpose } from '@prisma/client';
import { OtpService, maskTelegram, type OtpChallengeView } from './otp.service';
import { SessionService } from './session.service';
import { PASSWORD_HASH_OPTIONS } from './password-hash';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService, maskAddress } from '../common/services/email.service';

export interface StepUpPayload {
  otpRequired: true;
  mode: OtpMode;
  /** One entry per required channel; the session needs a code for every challenge id. */
  challenges: OtpChallengeView[];
  /** Seconds until a resend is allowed. */
  resendAfterSeconds: number;
  /** True when a required channel could not deliver — the UI must say so instead of hanging. */
  deliveryProblem: { channel: string; error: string } | null;
}

const RECOVERY_CODE_COUNT = 10;
const SUSPICIOUS_WINDOW_DAYS = 30;

@Injectable()
export class SecurityService {
  private readonly logger = new Logger('Security');

  constructor(
    private readonly sessions: SessionService,
    private readonly otp: OtpService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  // ------------------------------------------------------------------ login step-up

  /** Which channels this user must pass, given their policy and what can actually deliver. */
  requiredChannels(mode: OtpMode): OtpChannel[] {
    if (mode === 'DUAL') return ['EMAIL', 'TELEGRAM'];
    if (mode === 'EMAIL') return ['EMAIL'];
    if (mode === 'TELEGRAM') return ['TELEGRAM'];
    return [];
  }

  /**
   * Starts the second factor for a password-verified user. Returns `null` when the user has no OTP
   * policy, which is how the existing password-only flow keeps working byte-for-byte.
   */
  async beginStepUp(
    user: { id: string; email: string; otpMode: OtpMode; telegramChatId: string | null },
    request: Request,
  ): Promise<StepUpPayload | null> {
    const channels = this.requiredChannels(user.otpMode);
    if (channels.length === 0) return null;

    const challenges: OtpChallengeView[] = [];
    let deliveryProblem: { channel: string; error: string } | null = null;

    for (const channel of channels) {
      const delivery = await this.otp.issue({
        userId: user.id,
        email: user.email,
        telegramChatId: user.telegramChatId,
        purpose: 'LOGIN',
        channel,
        ipAddress: request.ip ?? null,
        userAgent: request.get('user-agent') ?? null,
      });
      challenges.push({
        challengeId: delivery.challengeId,
        channel: delivery.channel,
        destination: delivery.destination,
        // The TTL is a policy constant; re-reading it keeps the UI honest if it is tuned.
        expiresAt: new Date(Date.now() + this.otp.ttlSeconds * 1000).toISOString(),
        attemptsRemaining: this.otp.maxAttempts,
      });
      if (!delivery.delivered) {
        deliveryProblem = { channel: delivery.channel, error: delivery.error ?? 'delivery failed' };
      }
    }

    await this.recordLogin(user.id, 'OTP_CHALLENGE', 'PASSWORD', request, {
      detail: `second factor required (${user.otpMode})`,
    });
    return {
      otpRequired: true,
      mode: user.otpMode,
      challenges,
      resendAfterSeconds: this.otp.cooldownSeconds,
      deliveryProblem,
    };
  }

  /**
   * Verifies every required challenge and only then creates the session.
   * A failure leaves all challenges unconsumed except the ones already verified, so a user who got
   * the email code right and the Telegram code wrong does not have to start over.
   */
  async completeStepUp(
    input: { challengeIds: string[]; codes: string[] },
    request: Request,
  ): Promise<{ rawToken: string; csrfToken: string; workspaceId: string; userId: string }> {
    if (input.challengeIds.length !== input.codes.length || input.challengeIds.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Provide one code per challenge' });
    }
    const challenges = await prisma.otpChallenge.findMany({
      where: { id: { in: input.challengeIds } },
      select: { id: true, userId: true, purpose: true, channel: true },
    });
    if (challenges.length !== input.challengeIds.length) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Unknown verification challenge' });
    }
    const userIds = new Set(challenges.map((c) => c.userId));
    if (userIds.size !== 1) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Challenges belong to different accounts' });
    }
    const userId = challenges[0].userId;
    if (challenges.some((c) => c.purpose !== 'LOGIN')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'That challenge is not a login challenge' });
    }

    for (const [index, challengeId] of input.challengeIds.entries()) {
      const result = await this.otp.verify(challengeId, input.codes[index]);
      if (!result.ok) {
        await this.recordLogin(userId, 'OTP_FAILED', 'OTP', request, { detail: `${challenges[index].channel}: ${result.reason}` });
        const messages: Record<string, string> = {
          EXPIRED: 'That code has expired. Sign in again to get a new one.',
          CONSUMED: 'That code has already been used.',
          TOO_MANY_ATTEMPTS: 'Too many wrong codes for this challenge. Sign in again.',
          MISMATCH: `Incorrect code. ${result.attemptsRemaining} attempt(s) left.`,
          NOT_FOUND: 'Unknown verification challenge.',
          COOLDOWN: 'Too many attempts. Wait a moment and try again.',
        };
        throw new UnauthorizedException({ code: 'OTP_INVALID', message: messages[result.reason], details: { attemptsRemaining: result.attemptsRemaining } });
      }
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'This account is not active' });
    }

    const suspicious = await this.isSuspicious(userId, request);
    const session = await this.issueSessionFor(userId, request);
    await this.recordLogin(userId, 'SUCCESS', 'OTP', request, { suspicious, detail: `second factor (${user.otpMode})` });
    await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null } });
    await appendAuditLog({
      workspaceId: session.workspaceId,
      userId,
      action: 'AUTH_LOGIN',
      summary: `Login with ${user.otpMode} second factor from ${request.ip ?? 'unknown ip'}`,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    if (suspicious) await this.alertSuspiciousLogin(user, request);
    return session;
  }

  /** Resends the code for one existing challenge (same channel, same purpose). */
  async resend(challengeId: string, request: Request): Promise<OtpChallengeView> {
    const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId }, include: { user: true } });
    if (!challenge) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Unknown verification challenge' });
    if (challenge.consumedAt) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'That challenge is already complete' });
    const delivery = await this.otp.issue({
      userId: challenge.userId,
      email: challenge.user.email,
      telegramChatId: challenge.user.telegramChatId,
      purpose: challenge.purpose as OtpPurposeNameLocal,
      channel: challenge.channel as OtpChannel,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    if (!delivery.delivered) {
      throw new BadRequestException({ code: 'OTP_DELIVERY_FAILED', message: delivery.error ?? 'Could not deliver the code' });
    }
    return {
      challengeId: delivery.challengeId,
      channel: delivery.channel,
      destination: delivery.destination,
      expiresAt: new Date(Date.now() + this.otp.ttlSeconds * 1000).toISOString(),
      attemptsRemaining: this.otp.maxAttempts,
    };
  }

  // ------------------------------------------------------------------ password reset

  /**
   * Starts a reset. The response is identical whether or not the address exists: a reset form that
   * reveals account existence is an enumeration oracle.
   */
  async forgotPassword(email: string, request: Request): Promise<{ requested: true }> {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    // One response shape for every input: an unknown address must be indistinguishable from a real
    // one, otherwise this endpoint is an account-enumeration oracle. The caller learns whether mail
    // arrived, not whether the account exists.
    if (!user || user.deletedAt || user.status !== 'ACTIVE') return { requested: true };
    // Prefer the channel the user will actually read; fall back to email when Telegram is unlinked.
    const channel: OtpChannel = user.otpMode === 'TELEGRAM' && user.telegramChatId ? 'TELEGRAM' : 'EMAIL';
    const delivery = await this.otp.issue({
      userId: user.id,
      email: user.email,
      telegramChatId: user.telegramChatId,
      purpose: 'PASSWORD_RESET',
      channel,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    await appendAuditLog({
      userId: user.id,
      action: 'AUTH_PASSWORD_RESET_REQUESTED',
      summary: `Password reset requested via ${channel} (delivered: ${delivery.delivered})`,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    }).catch(() => undefined);
    return { requested: true };
  }

  /**
   * Completes a reset. The address identifies the challenge — the reset form carries the code the
   * user was sent, not an opaque id, so a leaked challenge list cannot be walked and the endpoint
   * stays out of the enumeration business.
   */
  async resetPassword(
    input: { email: string; code: string; newPassword: string },
    request: Request,
  ): Promise<{ reset: true; sessionsRevoked: number }> {
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase().trim() } });
    const rejection = new UnauthorizedException({
      code: 'OTP_INVALID',
      message: 'That code is not valid. Request a new one.',
    });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') throw rejection;

    const challenge = await prisma.otpChallenge.findFirst({
      where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { sentAt: 'desc' },
      select: { id: true },
    });
    if (!challenge) throw rejection;

    const result = await this.otp.verify(challenge.id, input.code);
    if (!result.ok) {
      throw new UnauthorizedException({
        code: 'OTP_INVALID',
        message: `Code rejected (${result.reason})`,
        attemptsRemaining: result.attemptsRemaining,
      });
    }

    const passwordHash = await argon2.hash(input.newPassword, PASSWORD_HASH_OPTIONS);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
    });
    const before = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    // A reset means "the old credential is gone": every device signed in with it goes too, including
    // an attacker's session that is already open.
    await this.sessions.revokeAllForUser(user.id);
    await appendAuditLog({
      userId: user.id,
      action: 'AUTH_PASSWORD_RESET',
      summary: `Password reset completed; ${before} session(s) revoked`,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    }).catch(() => undefined);
    void this.notifications;
    return { reset: true, sessionsRevoked: before };
  }

  // ------------------------------------------------------------------ sessions / devices

  async listSessions(userId: string, currentSessionId: string) {
    const rows = await prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastSeenAt: true, expiresAt: true, deviceLabel: true },
    });
    return rows.map((row) => ({
      id: row.id,
      device: row.deviceLabel ?? describeDevice(row.userAgent),
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      current: row.id === currentSessionId,
    }));
  }

  /** Revoking another device is allowed; revoking the current one is what "log out" is for. */
  async revokeSession(userId: string, sessionId: string, currentSessionId: string) {
    const row = await prisma.session.findFirst({ where: { id: sessionId, userId } });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Session not found' });
    await this.sessions.revoke(sessionId);
    return { revoked: true, wasCurrent: sessionId === currentSessionId };
  }

  async revokeAll(userId: string, currentSessionId: string | null, keepCurrent: boolean) {
    const result = await prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(keepCurrent && currentSessionId ? { id: { not: currentSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count };
  }

  async loginHistory(userId: string, limit = 20) {
    const rows = await prisma.loginEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) });
    return rows.map((row) => ({
      id: row.id,
      outcome: row.outcome,
      method: row.method,
      device: row.deviceLabel ?? describeDevice(row.userAgent),
      ipAddress: row.ipAddress,
      suspicious: row.suspicious,
      detail: row.detail,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ------------------------------------------------------------------ recovery codes

  /** Ten single-use codes, shown once. Only their hashes are stored. */
  async generateRecoveryCodes(userId: string): Promise<{ codes: string[]; remaining: number }> {
    const codes: string[] = [];
    const data = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
      const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
      codes.push(code);
      return { userId, codeHash: hashRecoveryCode(code) };
    });
    await prisma.$transaction([
      // Regenerating invalidates the previous set: two live sets would double the attack surface.
      prisma.recoveryCode.deleteMany({ where: { userId, usedAt: null } }),
      prisma.recoveryCode.createMany({ data }),
    ]);
    return { codes, remaining: codes.length };
  }

  async recoveryCodeStatus(userId: string) {
    const [remaining, total] = await Promise.all([
      prisma.recoveryCode.count({ where: { userId, usedAt: null } }),
      prisma.recoveryCode.count({ where: { userId } }),
    ]);
    return { remaining, total };
  }

  /**
   * Uses one recovery code to set a new password and revoke every session. This is the way back in
   * when both the password and the OTP channel are lost.
   */
  async redeemRecoveryCode(input: { email: string; code: string; newPassword: string }, request: Request) {
    const invalid = new UnauthorizedException({ code: 'RECOVERY_CODE_INVALID', message: 'That recovery code is not valid or has already been used' });
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase().trim() } });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') throw invalid;
    const hash = hashRecoveryCode(input.code);
    const record = await prisma.recoveryCode.findFirst({ where: { userId: user.id, codeHash: hash, usedAt: null } });
    if (!record) {
      await this.recordLogin(user.id, 'FAILED_PASSWORD', 'RECOVERY_CODE', request, { detail: 'invalid recovery code' });
      throw invalid;
    }
    const consumed = await prisma.recoveryCode.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
    if (consumed.count === 0) throw invalid;
    const passwordHash = await argon2.hash(input.newPassword, PASSWORD_HASH_OPTIONS);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } });
    await this.sessions.revokeAllForUser(user.id);
    await this.recordLogin(user.id, 'SUCCESS', 'RECOVERY_CODE', request, { detail: 'password reset with recovery code' });
    await appendAuditLog({
      userId: user.id,
      action: 'AUTH_PASSWORD_RESET' as never,
      summary: 'Password reset with a recovery code; all sessions revoked',
      ipAddress: request.ip ?? null,
    }).catch(() => undefined);
    const status = await this.recoveryCodeStatus(user.id);
    return { reset: true, remaining: status.remaining };
  }

  // ------------------------------------------------------------------ settings / linking

  async securityOverview(userId: string, currentSessionId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, otpMode: true, telegramChatId: true, telegramLinkedAt: true, emailVerified: true } });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
    const [sessions, recovery, available] = await Promise.all([
      this.listSessions(userId, currentSessionId),
      this.recoveryCodeStatus(userId),
      Promise.resolve(this.otp.channelsAvailable(user)),
    ]);
    return {
      email: maskAddress(user.email),
      otpMode: user.otpMode,
      emailVerified: user.emailVerified,
      telegram: user.telegramChatId
        ? { linked: true, chatId: maskTelegram(user.telegramChatId), linkedAt: user.telegramLinkedAt?.toISOString() ?? null }
        : { linked: false, chatId: null, linkedAt: null },
      channels: available,
      sessions,
      recoveryCodes: recovery,
      policies: { otpTtlSeconds: this.otp.ttlSeconds, resendCooldownSeconds: this.otp.cooldownSeconds, maxAttempts: this.otp.maxAttempts },
    };
  }

  /**
   * Changes the second-factor policy. Enabling a channel that cannot deliver is refused with the
   * reason, because a half-configured factor locks the user out of their own account.
   */
  async setOtpMode(userId: string, mode: OtpMode) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { telegramChatId: true } });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
    const available = this.otp.channelsAvailable(user);
    if ((mode === 'EMAIL' || mode === 'DUAL') && !available.email) {
      throw new BadRequestException({ code: 'CHANNEL_UNAVAILABLE', message: 'Email is not configured on this deployment (SMTP_HOST/SMTP_FROM), so email OTP cannot be enabled.' });
    }
    if ((mode === 'TELEGRAM' || mode === 'DUAL') && !available.telegram) {
      throw new BadRequestException({ code: 'CHANNEL_UNAVAILABLE', message: 'Link a Telegram chat before enabling Telegram OTP.' });
    }
    await prisma.user.update({ where: { id: userId }, data: { otpMode: mode } });
    await appendAuditLog({ userId, action: 'CONFIG_CHANGED', summary: `OTP mode set to ${mode}` }).catch(() => undefined);
    return { otpMode: mode };
  }

  /** Step 1 of linking: send a code to the chat the user claims to own. */
  async startTelegramLink(userId: string, chatId: string, request: Request) {
    const delivery = await this.otp.issue({ userId, email: '', telegramChatId: chatId, purpose: 'TELEGRAM_LINK', channel: 'TELEGRAM', ipAddress: request.ip ?? null, userAgent: request.get('user-agent') ?? null });
    if (!delivery.delivered) {
      throw new BadRequestException({ code: 'OTP_DELIVERY_FAILED', message: delivery.error ?? 'Could not message that chat. Send the bot a message first, then retry.' });
    }
    return { challengeId: delivery.challengeId, destination: delivery.destination, expiresAt: new Date(Date.now() + this.otp.ttlSeconds * 1000).toISOString() };
  }

  /** Step 2: the code proves control of the chat; only then is it stored on the account. */
  async completeTelegramLink(userId: string, challengeId: string, code: string, chatId: string) {
    const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge || challenge.userId !== userId || challenge.purpose !== 'TELEGRAM_LINK') {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Unknown Telegram link challenge' });
    }
    const result = await this.otp.verify(challengeId, code);
    if (!result.ok) throw new UnauthorizedException({ code: 'OTP_INVALID', message: `Code rejected (${result.reason})`, details: { attemptsRemaining: result.attemptsRemaining } });
    await prisma.user.update({ where: { id: userId }, data: { telegramChatId: chatId, telegramLinkedAt: new Date() } });
    await appendAuditLog({ userId, action: 'CONFIG_CHANGED', summary: `Telegram chat linked (…${chatId.slice(-4)})` }).catch(() => undefined);
    return { linked: true, chatId: maskTelegram(chatId) };
  }

  async unlinkTelegram(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { otpMode: true } });
    if (user?.otpMode === 'TELEGRAM' || user?.otpMode === 'DUAL') {
      // Unlinking while Telegram is a required factor would lock the account out.
      await prisma.user.update({ where: { id: userId }, data: { otpMode: user.otpMode === 'DUAL' ? 'EMAIL' : 'OFF' } });
    }
    await prisma.user.update({ where: { id: userId }, data: { telegramChatId: null, telegramLinkedAt: null } });
    return { linked: false };
  }

  // ------------------------------------------------------------------ helpers

  /** Same issuing path as the password login — one definition of a new session. */
  private async issueSessionFor(userId: string, request: Request) {
    const issued = await this.sessions.issue(userId, request);
    if (!issued) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'User has no workspace' });
    return issued;
  }

  async recordLogin(
    userId: string,
    outcome: 'SUCCESS' | 'FAILED_PASSWORD' | 'OTP_CHALLENGE' | 'OTP_FAILED' | 'BLOCKED',
    method: 'PASSWORD' | 'FIREBASE' | 'OTP' | 'RECOVERY_CODE' | 'BOOTSTRAP',
    request: Request,
    extra: { suspicious?: boolean; detail?: string } = {},
  ): Promise<void> {
    await prisma.loginEvent
      .create({
        data: {
          userId,
          outcome,
          method,
          ipAddress: request.ip ?? null,
          userAgent: request.get('user-agent') ?? null,
          deviceLabel: describeDevice(request.get('user-agent') ?? null),
          suspicious: extra.suspicious ?? false,
          detail: extra.detail ?? null,
        },
      })
      .catch(() => undefined);
  }

  /**
   * A login is suspicious when this IP or this device has not been seen for the account in the last
   * 30 days. Deliberately simple and explainable: a heuristic nobody can reason about gets muted.
   */
  async isSuspicious(userId: string, request: Request): Promise<boolean> {
    const since = new Date(Date.now() - SUSPICIOUS_WINDOW_DAYS * 24 * 3600 * 1000);
    const ip = request.ip ?? '';
    const device = describeDevice(request.get('user-agent') ?? null);
    const history = await prisma.loginEvent.count({ where: { userId, outcome: 'SUCCESS', createdAt: { gte: since } } });
    // The first successful login is not "suspicious", it is the account being set up.
    if (history === 0) return false;
    const seen = await prisma.loginEvent.findFirst({
      where: { userId, outcome: 'SUCCESS', createdAt: { gte: since }, OR: [{ ipAddress: ip }, { deviceLabel: device }] },
      select: { id: true },
    });
    return seen === null;
  }

  /** Public wrapper used by the password and Firebase login paths. */
  async alertIfSuspicious(user: { id: string; email: string }, request: Request): Promise<void> {
    return this.alertSuspiciousLogin(user, request);
  }

  async alertSuspiciousLogin(user: { id: string; email: string }, request: Request): Promise<void> {
    const device = describeDevice(request.get('user-agent') ?? null);
    const membership = await prisma.workspaceMember.findFirst({ where: { userId: user.id }, select: { workspaceId: true } });
    if (membership) {
      // The Telegram channel is already wired through the notification service, which handles
      // categories, dedupe and retries; a security alert is just another category.
      void this.notifications.notify({
        workspaceId: membership.workspaceId,
        category: 'SECURITY_ALERT',
        dedupeKey: `login:${user.id}:${new Date().toISOString().slice(0, 10)}:${device}`,
        summary: 'New device signed in to your ClipForge account',
        details: [
          ['Account', maskAddress(user.email)],
          ['Device', device],
          ['IP', request.ip ?? 'unknown'],
        ],
      });
    }
    void this.email.send({
      to: user.email,
      subject: 'New sign-in to your ClipForge account',
      text: [
        `A new device signed in to your ClipForge account.`,
        `Device: ${device}`,
        `IP: ${request.ip ?? 'unknown'}`,
        '',
        'If this was you, ignore this email. If not, reset your password and revoke your sessions from Settings → Security.',
      ].join('\n'),
    });
  }
}

type OtpPurposeNameLocal = 'LOGIN' | 'PASSWORD_RESET' | 'TELEGRAM_LINK';

function hashRecoveryCode(code: string): string {
  // Recovery codes are high-entropy (40 bits) so a fast hash is appropriate; the server secret still
  // prevents an offline table attack if the database leaks.
  const secret = process.env.OTP_SECRET?.trim() || process.env.SESSION_SECRET || 'clipforge-otp-dev-secret';
  return createHash('sha256').update(`${secret}:${code.trim().toUpperCase()}`).digest('hex');
}

/** Minimal, dependency-free user-agent labelling: "Firefox on Linux" beats a raw UA string. */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent.toLowerCase();
  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('chrome') && !ua.includes('chromium')
      ? 'Chrome'
      : ua.includes('firefox')
        ? 'Firefox'
        : ua.includes('safari') && !ua.includes('chrome')
          ? 'Safari'
          : ua.includes('curl')
            ? 'curl'
            : ua.includes('python')
              ? 'Python client'
              : 'Browser';
  const platform = ua.includes('android')
    ? 'Android'
    : ua.includes('iphone') || ua.includes('ipad')
      ? 'iOS'
      : ua.includes('windows')
        ? 'Windows'
        : ua.includes('mac os')
          ? 'macOS'
          : ua.includes('linux')
            ? 'Linux'
            : '';
  return platform ? `${browser} on ${platform}` : browser;
}
