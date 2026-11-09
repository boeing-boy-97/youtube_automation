import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { workerLogger } from '../services/logger.service';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { requestId?: string }>();
    const response = http.getResponse<Response>();
    const requestId = request.get('x-request-id') ?? randomUUID();
    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    const started = Date.now();
    return next.handle().pipe(
      tap(() => {
        workerLogger.child({ requestId, method: request.method, path: request.originalUrl, durationMs: Date.now() - started }).info('request completed');
      }),
    );
  }
}
