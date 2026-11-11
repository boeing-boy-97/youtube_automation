import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../decorators/rate-limit.decorator';
import { RedisService } from '../services/redis.service';

/**
 * Redis-backed fixed-window limiter, per-user when authenticated and per-IP otherwise.
 *
 * Two budgets exist, on purpose:
 *
 *  - **The default.** Any *unsafe* request (anything but GET/HEAD/OPTIONS) is limited even when the
 *    route declares nothing. Previously a missing decorator meant "unlimited", which left 16 mutating
 *    routes — retry, publish, configuration writes, telegram linking — open to a stolen cookie
 *    looping expensive work. A route that legitimately needs more simply declares it.
 *  - **The declared budget.** `@RateLimit({...})` overrides the default for auth, uploads and other
 *    abuse-prone surfaces.
 *
 * Safe methods are only limited when they explicitly declare a budget (no route does today), so
 * polling dashboards and media streaming are unaffected.
 */
const DEFAULT_BUDGET: RateLimitOptions = {
  limit: 120,
  windowSeconds: 60,
  scope: 'default-unsafe',
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { context?: { userId: string } }>();
    if (!declared && SAFE_METHODS.has(request.method)) return true;
    const options = declared ?? DEFAULT_BUDGET;
    const response = http.getResponse<Response>();
    // `request.context` is populated by the session guard, which runs after this one on some routes;
    // falling back to the IP keeps a defence in depth even when the user is not known yet.
    const identity = request.context?.userId ?? request.ip ?? 'unknown';
    const { allowed, remaining, resetSeconds } = await this.redis.hit(
      `${options.scope}:${identity}`,
      options.limit,
      options.windowSeconds,
    );
    response.setHeader('x-ratelimit-limit', String(options.limit));
    response.setHeader('x-ratelimit-remaining', String(remaining));
    response.setHeader('x-ratelimit-reset', String(resetSeconds));
    if (!allowed) {
      response.setHeader('retry-after', String(resetSeconds));
      throw new HttpException(
        { code: 'RATE_LIMITED', message: `Rate limit exceeded (${options.limit} per ${options.windowSeconds}s)` },
        429,
      );
    }
    return true;
  }
}
