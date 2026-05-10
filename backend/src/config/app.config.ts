// ============================================================
// CodeMorph — App Configuration
// ============================================================
import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  name:        process.env['APP_NAME']    ?? 'CodeMorph',
  env:         process.env['NODE_ENV']    ?? 'development',
  port:        parseInt(process.env['PORT'] ?? '4000', 10),
  apiPrefix:   process.env['API_PREFIX']  ?? 'api/v1',
  appUrl:      process.env['APP_URL']     ?? 'http://localhost:3000',
  apiUrl:      process.env['API_URL']     ?? 'http://localhost:4000',
  aiEngineUrl: process.env['AI_ENGINE_URL'] ?? 'http://localhost:5000',
  logLevel:    process.env['LOG_LEVEL']   ?? 'debug',
  isProduction: (process.env['NODE_ENV'] ?? 'development') === 'production',
  isDevelopment: (process.env['NODE_ENV'] ?? 'development') === 'development',
  features: {
    aiEngine:   process.env['FEATURE_AI_ENGINE']   === 'true',
    billing:    process.env['FEATURE_BILLING']      === 'true',
    teams:      process.env['FEATURE_TEAMS']        === 'true',
    analytics:  process.env['FEATURE_ANALYTICS']   === 'true',
  },
}));
