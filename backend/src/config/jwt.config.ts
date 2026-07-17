// ============================================================
// CodeMorph — JWT Configuration
// FIX CRITIQUE : JWT_EXPIRES_IN défaut '7d' (pas '15m')
// En cross-domain (Vercel → Render), le cookie refresh est bloqué.
// L'access token doit durer suffisamment longtemps (7d minimum).
// Le refresh token dure 30d.
// SEC-09 : Rejeter au démarrage si JWT_SECRET absent en production.
// ============================================================
import { registerAs } from '@nestjs/config';

export const jwtConfig = registerAs('jwt', () => {
  const isProd = process.env['NODE_ENV'] === 'production';

  const jwtSecret     = process.env['JWT_SECRET'];
  const refreshSecret = process.env['JWT_REFRESH_SECRET'];

  // SEC-09 : En production, les secrets JWT DOIVENT être configurés
  // Un fallback hardcodé en production est une faille de sécurité critique
  if (isProd && !jwtSecret) {
    throw new Error(
      '[FATAL] JWT_SECRET is not configured. ' +
      'Set JWT_SECRET in your environment variables (Render dashboard). ' +
      'Generate one with: openssl rand -base64 64',
    );
  }
  if (isProd && !refreshSecret) {
    throw new Error(
      '[FATAL] JWT_REFRESH_SECRET is not configured. ' +
      'Set JWT_REFRESH_SECRET in your environment variables (Render dashboard). ' +
      'Generate one with: openssl rand -base64 64',
    );
  }

  return {
    secret:           jwtSecret ?? 'dev-secret-change-in-production-64-bytes-random',
    // 7 jours — OBLIGATOIRE en cross-domain (cookie refresh bloqué CORS)
    // Ne jamais mettre '15m' ici : cela crée GEN_003 après 15 minutes
    expiresIn:        process.env['JWT_EXPIRES_IN']         ?? '7d',
    refreshSecret:    refreshSecret ?? 'dev-refresh-secret-change-in-production-64-bytes',
    refreshExpiresIn: process.env['JWT_REFRESH_EXPIRES_IN'] ?? '30d',
  };
});

