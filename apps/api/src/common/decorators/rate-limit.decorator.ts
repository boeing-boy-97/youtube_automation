import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'clipforge:rate-limit';
export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  scope: string;
}
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
