import { Injectable, LoggerService, Scope } from '@nestjs/common';
import pino, { Logger } from 'pino';
import { env } from '../env';

/** Structured JSON logs (pino) — one line per event, machine-parseable. */
@Injectable({ scope: Scope.DEFAULT })
export class AppLogger implements LoggerService {
  private readonly logger: Logger;

  constructor(context?: string) {
    this.logger = pino({
      level: env.LOG_LEVEL,
      base: { service: 'clipforge-api', env: env.NODE_ENV },
      timestamp: pino.stdTimeFunctions.isoTime,
    }).child(context ? { context } : {});
  }

  log(message: unknown, context?: string) {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }

  child(bindings: Record<string, unknown>) {
    return this.logger.child(bindings);
  }
}

export const workerLogger = new AppLogger('worker');
