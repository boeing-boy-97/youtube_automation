import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __clipforgePrisma: PrismaClient | undefined;
}

/**
 * Single Prisma client per process. Workers and API both use this.
 * Connection pooling is handled by pg via the DATABASE_URL parameters.
 */
export const prisma: PrismaClient =
  global.__clipforgePrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__clipforgePrisma = prisma;
}

export type { Prisma } from '@prisma/client';
export * from '@prisma/client';
