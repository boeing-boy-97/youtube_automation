import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { RequestContext } from '../guards/session-auth.guard';

export const PUBLIC_ROUTE = 'clipforge:public';
export const SKIP_CSRF = 'clipforge:skip-csrf';

/** Marks a route as reachable without a session (login/register/health/callbacks). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/** Used only for machine-to-machine callbacks authenticated by signature instead. */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

export const CurrentContext = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const request = ctx.switchToHttp().getRequest();
  return request.context as RequestContext;
});
