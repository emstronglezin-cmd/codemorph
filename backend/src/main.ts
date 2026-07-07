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

  // ── DIAG: middleware brut pour logger TOUTES les requêtes jobs/start/* ──
  // Ce log apparaît AVANT NestJS, AVANT ValidationPipe, AVANT tout guard
  // Si ce log n'apparaît PAS dans Render → la requête n'arrive pas au backend
  // Si ce log apparaît → le problème est dans le handler ou la connexion est coupée après
  app.use('/api/v1/jobs/start', (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    logger.log(
      `[RAW MIDDLEWARE] ${req.method} ${req.path} ` +
      `origin="${req.headers['origin'] ?? 'none'}" ` +
      `content-type="${req.headers['content-type'] ?? 'none'}" ` +
      `auth="${req.headers['authorization'] ? 'Bearer ***' : 'ABSENT'}"`,
    );
    next();
  });

  // ── CORS ─────────────────────────────────────────────────
  // Support Vercel (*.vercel.app), custom domain, localhost dev
  const allowedOrigins = [
    config.get<string>('FRONTEND_URL', ''),
    config.get<string>('APP_URL', ''),
    config.get<string>('AI_ENGINE_URL', ''),
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ].filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, Render health checks)
      if (!origin) return callback(null, true);
      // Exact match (FRONTEND_URL etc.)
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Allow any *.vercel.app subdomain — preview slugs can contain underscores, dots, uppercase
      // FIX: [a-z0-9-] ne couvre pas les underscores des preview URLs Vercel
      if (/^https:\/\/[\w.-]+\.vercel\.app$/.test(origin)) return callback(null, true);
      // Allow any *.onrender.com (services inter-Render)
      if (/^https:\/\/[\w.-]+\.onrender\.com$/.test(origin)) return callback(null, true);
      // In development, allow all localhost origins
      if (nodeEnv !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      logger.warn(`CORS blocked: origin="${origin}" | allowedOrigins=[${allowedOrigins.join(', ')}]`);
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

  // ── Root endpoint — confirmation service en ligne ────────
  // Visible sur https://codemorph-backend.onrender.com/
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/', (_req: unknown, res: { json: (d: unknown) => void }) => {
    res.json({
      name:    'CodeMorph API',
      version: '1.0.0',
      status:  'online',
      docs:    `http://localhost:${port}/api/docs`,
      health:  `/api/v1/health`,
    });
  });

  // ── Graceful shutdown ────────────────────────────────────
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 CodeMorph API running on http://localhost:${port}/${apiPrefix}`);
  logger.log(`🌍 Environment: ${nodeEnv}`);
}

// ── Global process error handlers ──────────────────────────────────
// Empêche Node.js de crasher silencieusement sur les UnhandledPromiseRejection
// (ex: Bull queue disconnected, Redis timeout, DB connection drop)
// Sans ces handlers, Render reçoit un SIGTERM, ferme toutes les connexions actives
// → les clients reçoivent "Load failed" sans aucune réponse HTTP
process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
  logger.error(
    `[FATAL] UnhandledPromiseRejection — this would crash the process without this handler\n` +
    `  reason: ${reason instanceof Error ? reason.message : String(reason)}\n` +
    `  stack:  ${reason instanceof Error ? (reason.stack ?? '(no stack)') : '(not an Error)'}`,
  );
  // NE PAS process.exit() — on laisse Render gérer le restart si nécessaire
  // Un crash silencieux est pire qu'un process qui continue
});

process.on('uncaughtException', (error: Error) => {
  logger.error(
    `[FATAL] UncaughtException — logging and continuing\n` +
    `  message: ${error.message}\n` +
    `  stack:   ${error.stack ?? '(no stack)'}`,
  );
  // NE PAS crasher sur les exceptions récupérables
  // Le process Render sera restarté automatiquement si le health check échoue
});

void bootstrap();
