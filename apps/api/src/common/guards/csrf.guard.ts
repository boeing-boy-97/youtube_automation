import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SKIP_CSRF } from '../decorators/auth.decorators';
import { SessionService } from '../../auth/session.service';
import type { RequestContext } from './session-auth.guard';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection. The token is delivered in the session-info
 * payload (never in a cookie readable by JS), and must be echoed in the
 * `x-csrf-token` header on every unsafe request.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [context.getHandler(), context.getClass()]);
    if (skip) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    const ctx = (request as Request & { context?: RequestContext }).context;
    if (!ctx) {
      // Public POST routes (login/register) still require a CSRF token tied to a
      // pre-session cookie, which the client obtains from GET /api/auth/csrf.
      const cookieValue = request.cookies?.['cf_csrf'] as string | undefined;
      const header = request.get('x-csrf-token');
      if (!cookieValue || !header) {
        throw new ForbiddenException({
          code: 'CSRF_FAILED',
          message: 'Missing CSRF token. Call GET /api/auth/csrf first and echo the token in the x-csrf-token header.',
        });
      }
      const ok = this.sessions.verifyAnonymousCsrf(cookieValue, header);
      if (!ok) throw new ForbiddenException({ code: 'CSRF_FAILED', message: 'Invalid CSRF token' });
      return true;
    }
    const header = request.get('x-csrf-token');
    if (!header || !(await this.sessions.verifyCsrf(ctx.sessionId, header))) {
      throw new ForbiddenException({ code: 'CSRF_FAILED', message: 'Invalid CSRF token' });
    }
    return true;
  }
}
