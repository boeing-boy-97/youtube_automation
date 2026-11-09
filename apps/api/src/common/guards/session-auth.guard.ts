import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PUBLIC_ROUTE, ROLES } from '../decorators/auth.decorators';
import { SessionService, type AuthenticatedSession } from '../../auth/session.service';

export interface RequestContext extends AuthenticatedSession {
  requestId: string;
  ip: string;
  userAgent: string | null;
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.cookies?.[SessionService.COOKIE_NAME] as string | undefined;
    if (!raw) {
      if (isPublic) return true;
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'No active session' });
    }
    const session = await this.sessions.validate(raw, request);
    if (!session) {
      if (isPublic) return true;
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Session expired or revoked' });
    }
    (request as Request & { context: RequestContext }).context = {
      ...session,
      requestId: (request as Request & { requestId?: string }).requestId ?? 'unknown',
      ip: request.ip ?? '',
      userAgent: request.get('user-agent') ?? null,
    };

    const requiredRoles = this.reflector.getAllAndOverride<Array<'OWNER' | 'ADMIN' | 'MEMBER'>>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredRoles?.length && !requiredRoles.includes(session.role)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: `This action requires one of: ${requiredRoles.join(', ')}. Your role is ${session.role}.`,
      });
    }
    return true;
  }
}
