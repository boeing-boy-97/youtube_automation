import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { bootstrapSchema, loginSchema, registerSchema } from '@clipforge/validation';
import { CurrentContext, Public, SkipCsrf } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { env } from '../common/env';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
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

  @Get('csrf')
  @Public()
  @SkipCsrf()
  @ApiOperation({ summary: 'Obtain an anonymous CSRF token (signed double-submit cookie)' })
  csrf(@Res({ passthrough: true }) res: Response) {
    const { token, cookieValue } = this.sessions.issueAnonymousCsrf();
    res.cookie('cf_csrf', cookieValue, {
      httpOnly: false,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60_000,
    });
    return { csrfToken: token };
  }

  @Post('bootstrap')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'auth-bootstrap' })
  @ApiOperation({ summary: 'One-time administrator bootstrap (requires ADMIN_BOOTSTRAP_TOKEN; refuses once a user exists)' })
  async bootstrap(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.bootstrap(bootstrapSchema.parse(body), req);
    this.setSessionCookies(res, result.rawToken);
    return { csrfToken: result.csrfToken, userId: result.userId, workspaceId: result.workspaceId };
  }

  @Post('register')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'auth-register' })
  async register(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.register(registerSchema.parse(body), req);
    this.setSessionCookies(res, result.rawToken);
    return { csrfToken: result.csrfToken, userId: result.userId, workspaceId: result.workspaceId };
  }

  @Post('login')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 10, windowSeconds: 300, scope: 'auth-login' })
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(loginSchema.parse(body), req);
    this.setSessionCookies(res, result.rawToken);
    return { csrfToken: result.csrfToken, userId: result.userId, workspaceId: result.workspaceId };
  }

  @Post('logout')
  async logout(@CurrentContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(ctx.sessionId);
    res.clearCookie(SessionService.COOKIE_NAME, { path: '/' });
    return { loggedOut: true };
  }

  @Get('session')
  @Public()
  @ApiOperation({ summary: 'Current session, workspace, configuration readiness and integration status' })
  async session(@Req() req: Request) {
    const raw = req.cookies?.[SessionService.COOKIE_NAME] as string | undefined;
    if (!raw) return { authenticated: false };
    const session = await this.sessions.validate(raw, req);
    if (!session) return { authenticated: false };
    const description = await this.auth.describeSession({ userId: session.userId, workspaceId: session.workspaceId });
    const csrf = this.sessions.reissueCsrf(session.sessionId);
    return { authenticated: true, ...description, csrfToken: csrf };
  }
}
