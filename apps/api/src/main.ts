import 'reflect-metadata';
import './load-env';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { AppLogger, workerLogger } from './common/services/logger.service';
import { env, loadEnv } from './common/env';

async function bootstrap() {
  loadEnv();
  const logger = new AppLogger('bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });

  app.use(cookieParser());
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // JSON compresses; media does not (compression's own filter consults `compressible`, which
  // rejects video/audio/image types, and byte ranges must never be re-encoded).
  app.use(compression({ threshold: 1024 }));
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { limit: '2mb', extended: true });

  // ALLOWED_ORIGINS is an explicit allow-list. Entries may contain a single '*' wildcard
  // (e.g. https://*.preview.example.com) so an operator can permit a preview host deliberately —
  // there is no implicit "allow anything" mode.
  const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  const originAllowed = (origin: string) =>
    allowedOrigins.some((entry) => {
      if (!entry.includes('*')) return entry === origin;
      const [entryScheme, entryHost] = entry.split('://');
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        return false;
      }
      if (entryScheme !== parsed.protocol.replace(':', '')) return false;
      const [hostPrefix, hostSuffix] = (entryHost ?? '').split('*');
      return parsed.host.startsWith(hostPrefix) && parsed.host.endsWith(hostSuffix);
    });
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || originAllowed(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed by CORS policy`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ClipForge AI API')
    .setDescription(
      'AI video repurposing and automatic social publishing API. Session cookie authentication with CSRF double-submit. ' +
        'Configuration-dependent endpoints return 428 CONFIGURATION_REQUIRED with the exact missing keys.',
    )
    .setVersion('1.0.0')
    .addCookieAuth('cf_session')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs/openapi.json' });

  await app.listen(env.API_PORT, '0.0.0.0');
  workerLogger.child({ port: env.API_PORT, env: env.NODE_ENV }).info('ClipForge API listening');
}

bootstrap().catch((error) => {
  // Fail loudly: a misconfigured environment must never start a half-working API.
  console.error('[fatal] API failed to start:', error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
