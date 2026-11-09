import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { RequestContext } from '../guards/session-auth.guard';

export const PUBLIC_ROUTE = 'clipforge:public';
export const SKIP_CSRF = 'clipforge:skip-csrf';
export const ROLES = 'clipforge:roles';

/** Marks a route as reachable without a session (login/register/health/callbacks). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/** Used only for machine-to-machine callbacks authenticated by signature instead. */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

/**
 * Restricts a route to specific workspace roles. The role model existed in the schema from the
 * start but was never enforced, so operator-only surfaces were reachable by every member.
 */
export const Roles = (...roles: Array<'OWNER' | 'ADMIN' | 'MEMBER'>) => SetMetadata(ROLES, roles);

export const CurrentContext = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const request = ctx.switchToHttp().getRequest();
  return request.context as RequestContext;
});
