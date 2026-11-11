/**
 * Account security surface: second-factor step-up, password recovery, sessions, login history,
 * recovery codes and Telegram linking.
 *
 * Authorisation rules that hold for every route here:
 *  - `@Public()` routes are only the ones a user must reach *before* they have a session
 *    (step-up completion, resend, forgot/reset password). Everything else requires a session and,
 *    because the guard is global, they inherit CSRF protection automatically.
 *  - A user can only ever act on their own account: the user id always comes from the session
 *    context, never from the request body.
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentContext, Public, SkipCsrf } from '../common/decorators/auth.decorators';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { env } from '../common/env';
import { passwordSchema as sharedPasswordSchema } from '@clipforge/validation';
import { SessionService } from './session.service';
import { SecurityService } from './security.service';

const codeSchema = z.string().trim().regex(/^\d{6}$/, 'Code must be 6 digits');
// Same policy as registration. A recovery path must never be a way to weaken an account.
const passwordSchema = sharedPasswordSchema;

const stepUpCompleteSchema = z.object({
  challengeIds: z.array(z.string().min(1)).min(1).max(2),
  codes: z.array(codeSchema).min(1).max(2),
});
const resendSchema = z.object({ challengeId: z.string().min(1) });
const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({ email: z.string().email(), code: codeSchema, newPassword: passwordSchema });
const otpModeSchema = z.object({ mode: z.enum(['OFF', 'EMAIL', 'TELEGRAM', 'DUAL']) });
const telegramLinkStartSchema = z.object({ chatId: z.string().trim().regex(/^-?\d{3,20}$/, 'Chat id must be numeric') });
const telegramLinkCompleteSchema = z.object({
  challengeId: z.string().min(1),
  code: codeSchema,
  chatId: z.string().trim().regex(/^-?\d{3,20}$/),
});
const recoveryRedeemSchema = z.object({
  email: z.string().email(),
  code: z.string().trim().min(8).max(20),
  newPassword: passwordSchema,
});

@ApiTags('security')
@Controller('api/auth/security')
export class SecurityController {
  constructor(
    private readonly security: SecurityService,
    private readonly sessions: SessionService,
  ) {}

  private setSessionCookies(res: Response, rawToken: string): void {
    res.cookie(SessionService.COOKIE_NAME, rawToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SessionService.TTL_MS,
    });
  }

  // ------------------------------------------------------------------ step-up (public)

  @Post('otp/step-up/complete')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 20, windowSeconds: 300, scope: 'otp-verify' })
  @ApiOperation({ summary: 'Verify every required one-time code and open the session' })
  async completeStepUp(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = stepUpCompleteSchema.parse(body);
    const session = await this.security.completeStepUp(input, req);
    this.setSessionCookies(res, session.rawToken);
    return { csrfToken: session.csrfToken, userId: session.userId, workspaceId: session.workspaceId };
  }

  @Post('otp/resend')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'otp-resend' })
  @ApiOperation({ summary: 'Resend one challenge code (cooldown enforced server-side)' })
  async resend(@Body() body: unknown, @Req() req: Request) {
    const { challengeId } = resendSchema.parse(body);
    return { challenge: await this.security.resend(challengeId, req) };
  }

  // ------------------------------------------------------------------ password recovery (public)

  @Post('forgot-password')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 5, windowSeconds: 900, scope: 'forgot-password' })
  @ApiOperation({ summary: 'Start password reset — same response whether or not the account exists' })
  async forgotPassword(@Body() body: unknown, @Req() req: Request) {
    const { email } = forgotSchema.parse(body);
    return this.security.forgotPassword(email, req);
  }

  @Post('reset-password')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 10, windowSeconds: 900, scope: 'reset-password' })
  @ApiOperation({ summary: 'Finish a password reset with the emailed/Telegram code' })
  async resetPassword(@Body() body: unknown, @Req() req: Request) {
    return this.security.resetPassword(resetSchema.parse(body), req);
  }

  @Post('recovery-codes/redeem')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 5, windowSeconds: 900, scope: 'recovery-redeem' })
  @ApiOperation({ summary: 'Use a recovery code to reset a password when email and Telegram are lost' })
  async redeemRecoveryCode(@Body() body: unknown, @Req() req: Request) {
    return this.security.redeemRecoveryCode(recoveryRedeemSchema.parse(body), req);
  }

  // ------------------------------------------------------------------ authenticated surface

  @Get('overview')
  @ApiOperation({ summary: 'Security posture: OTP mode, linked Telegram, sessions, recovery codes' })
  overview(@CurrentContext() ctx: RequestContext) {
    return this.security.securityOverview(ctx.userId, ctx.sessionId);
  }

  @Put('otp-mode')
  @ApiOperation({ summary: 'Choose the second-factor policy; refuses a channel that cannot deliver' })
  setOtpMode(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    return this.security.setOtpMode(ctx.userId, otpModeSchema.parse(body).mode);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Active sessions with device labels and the current one flagged' })
  sessions_(@CurrentContext() ctx: RequestContext) {
    return this.security.listSessions(ctx.userId, ctx.sessionId);
  }

  @Delete('sessions/:id')
  @ApiOperation({ summary: 'Revoke one session' })
  revokeSession(@CurrentContext() ctx: RequestContext, @Param('id') id: string) {
    return this.security.revokeSession(ctx.userId, id, ctx.sessionId);
  }

  @Post('sessions/revoke-all')
  @ApiOperation({ summary: 'Log out everywhere (optionally keeping this session)' })
  revokeAll(@CurrentContext() ctx: RequestContext, @Body() body: { keepCurrent?: boolean }) {
    return this.security.revokeAll(ctx.userId, ctx.sessionId, body?.keepCurrent !== false);
  }

  @Get('login-history')
  @ApiOperation({ summary: 'Recent sign-in attempts for this account' })
  loginHistory(@CurrentContext() ctx: RequestContext) {
    return this.security.loginHistory(ctx.userId);
  }

  @Get('recovery-codes')
  @ApiOperation({ summary: 'How many unused recovery codes remain' })
  recoveryCodes(@CurrentContext() ctx: RequestContext) {
    return this.security.recoveryCodeStatus(ctx.userId);
  }

  @Post('recovery-codes')
  @RateLimit({ limit: 3, windowSeconds: 3600, scope: 'recovery-generate' })
  @ApiOperation({ summary: 'Generate a new set of ten recovery codes (returned once, stored hashed)' })
  generateRecoveryCodes(@CurrentContext() ctx: RequestContext) {
    return this.security.generateRecoveryCodes(ctx.userId);
  }

  @Post('telegram/link/start')
  @ApiOperation({ summary: 'Send a linking code to a Telegram chat' })
  startTelegramLink(@CurrentContext() ctx: RequestContext, @Body() body: unknown, @Req() req: Request) {
    return this.security.startTelegramLink(ctx.userId, telegramLinkStartSchema.parse(body).chatId, req);
  }

  @Post('telegram/link/complete')
  @ApiOperation({ summary: 'Confirm the linking code and store the chat id' })
  completeTelegramLink(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    const input = telegramLinkCompleteSchema.parse(body);
    return this.security.completeTelegramLink(ctx.userId, input.challengeId, input.code, input.chatId);
  }

  @Post('telegram/unlink')
  @ApiOperation({ summary: 'Forget the linked chat and downgrade a DUAL policy' })
  unlinkTelegram(@CurrentContext() ctx: RequestContext) {
    return this.security.unlinkTelegram(ctx.userId);
  }

  @Delete('sessions')
  @ApiOperation({ summary: 'Alias for revoking every other session' })
  revokeOthers(@CurrentContext() ctx: RequestContext) {
    return this.security.revokeAll(ctx.userId, ctx.sessionId, true);
  }
}
