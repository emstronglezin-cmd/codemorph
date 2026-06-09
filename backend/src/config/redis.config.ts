// ============================================================
// CodeMorph — Redis Configuration
// Normalise l'URL Redis pour supporter Upstash (rediss://)
// et rend la connexion optionnelle si REDIS_URL est absent.
// ============================================================
import { registerAs } from '@nestjs/config';

/**
 * Normalise une URL Redis brute.
 * Upstash fournit parfois l'URL sans protocole → Node.js tente un socket Unix.
 * On force rediss:// pour Upstash (TLS obligatoire).
 */
function normalizeRedisUrl(raw: string | undefined): string {
  const fallback = 'redis://localhost:6379';
  if (!raw || !raw.trim()) return fallback;
  const trimmed = raw.trim();
  if (trimmed.startsWith('redis://') || trimmed.startsWith('rediss://')) {
    return trimmed;
  }
  // Supprimer les // en tête si présents (cas "//hostname:port")
  const withoutSlashes = trimmed.replace(/^\/\//, '');
  // Upstash requiert TLS → rediss://
  return `rediss://${withoutSlashes}`;
}

export const redisConfig = registerAs('redis', () => ({
  url:      normalizeRedisUrl(process.env['REDIS_URL']),
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
