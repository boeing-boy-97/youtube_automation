import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ConfigurationRequiredError } from '@clipforge/database';
import { PlatformError } from '@clipforge/platform-connectors';
import { workerLogger } from '../services/logger.service';

/**
 * Single error shape for the whole API:
 *   { error: { code, message, details?, missingConfiguration?, requestId } }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;
    let missingConfiguration: string[] | undefined;

    if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'VALIDATION_FAILED';
      message = 'Request validation failed';
      details = exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (exception instanceof ConfigurationRequiredError) {
      status = 428; // Precondition Required — "Configuration required — processing cannot start."
      code = 'CONFIGURATION_REQUIRED';
      message = exception.message;
      missingConfiguration = exception.missing;
    } else if (exception instanceof PlatformError) {
      status = exception.classification === 'AUTH' ? HttpStatus.UNAUTHORIZED : HttpStatus.BAD_GATEWAY;
      code = 'PLATFORM_ERROR';
      message = exception.message;
      details = { platform: exception.platform, classification: exception.classification };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        code = httpCodeToErrorCode(status);
      } else {
        const obj = body as Record<string, unknown>;
        message = (obj.message as string) ?? exception.message;
        code = (obj.code as string) ?? httpCodeToErrorCode(status);
        details = obj.details;
        if (Array.isArray(obj.message)) {
          message = 'Request validation failed';
          details = obj.message;
          code = 'VALIDATION_FAILED';
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      workerLogger.child({ requestId }).error('unhandled exception', exception.stack);
    }

    const payload = { error: { code, message, ...(details ? { details } : {}), ...(missingConfiguration ? { missingConfiguration } : {}), requestId } };
    if (status >= 500) workerLogger.child({ requestId, code }).error(message);
    response.status(status).json(payload);
  }
}

function httpCodeToErrorCode(status: number): string {
  switch (status) {
    case 400: return 'VALIDATION_FAILED';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 429: return 'RATE_LIMITED';
    default: return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  }
}
