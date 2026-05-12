// ============================================================
// CodeMorph — NestJS Bootstrap
// ============================================================
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    cors: false,
  });

  const config = app.get(ConfigService);
  const port    = config.get<number>('PORT', 4000);
  const nodeEnv = config.get<string>('NODE_ENV', 'development');
  const apiPrefix = config.get<string>('API_PREFIX', 'api/v1');

  // ── Security ────────────────────────────────────────────
  app.use(helmet({
    crossOriginEmbedderPolicy: nodeEnv === 'production',
    contentSecurityPolicy: nodeEnv === 'production' ? undefined : false,
  }));

  // ── CORS ─────────────────────────────────────────────────
  // Support both FRONTEND_URL (production) and APP_URL (legacy) + localhost dev
  const allowedOrigins = [
    config.get<string>('FRONTEND_URL', ''),
    config.get<string>('APP_URL', ''),
    config.get<string>('AI_ENGINE_URL', ''),
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ].filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // In development, allow all localhost origins
      if (nodeEnv !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Org-ID'],
  });

  // ── Middleware ───────────────────────────────────────────
  app.use(compression());
  app.use(cookieParser(config.get<string>('COOKIE_SECRET')));

  // ── API Versioning ───────────────────────────────────────
  app.setGlobalPrefix(apiPrefix);
  app.enableVersioning({ type: VersioningType.URI });

  // ── Validation ───────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );

  // ── Global Filters & Interceptors ────────────────────────
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TransformInterceptor(),
  );

  // ── Swagger (non-production) ─────────────────────────────
  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('CodeMorph API')
      .setDescription('CodeMorph — AI-Powered Code Conversion SaaS API')
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
      .addTag('auth',          'Authentication & Authorization')
      .addTag('users',         'User management')
      .addTag('organizations', 'Organization management')
      .addTag('projects',      'Conversion projects')
      .addTag('conversions',   'Code conversions')
      .addTag('billing',       'Billing & subscriptions')
      .addTag('analytics',     'Usage analytics')
      .addTag('health',        'Health checks')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });

    logger.log(`📚 Swagger docs available at http://localhost:${port}/api/docs`);
  }

  // ── Graceful shutdown ────────────────────────────────────
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 CodeMorph API running on http://localhost:${port}/${apiPrefix}`);
  logger.log(`🌍 Environment: ${nodeEnv}`);
}

void bootstrap();
