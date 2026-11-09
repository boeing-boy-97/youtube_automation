import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../decorators/rate-limit.decorator';
import { RedisService } from '../services/redis.service';

/** Redis-backed fixed-window limiter. Per-user when authenticated, per-IP otherwise. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { context?: { userId: string } }>();
    const response = http.getResponse<Response>();
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
      throw new HttpException({ code: 'RATE_LIMITED', message: `Rate limit exceeded (${options.limit} per ${options.windowSeconds}s)` }, 429);
    }
    return true;
  }
}
