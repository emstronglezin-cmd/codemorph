// ============================================================
// CodeMorph — Redis Configuration
// ============================================================
import { registerAs } from '@nestjs/config';

export const redisConfig = registerAs('redis', () => ({
  url:      process.env['REDIS_URL']      ?? 'redis://localhost:6379',
  host:     process.env['REDIS_HOST']     ?? 'localhost',
  port:     parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
  password: process.env['REDIS_PASSWORD'] ?? undefined,
  db:       0,
  keyPrefix: 'cm:',
  ttl: {
    default:      3600,       // 1 hour
    session:      604800,     // 7 days
    rateLimit:    60,         // 1 minute
    featureFlags: 300,        // 5 minutes
  },
}));
