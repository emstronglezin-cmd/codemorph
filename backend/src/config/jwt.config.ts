// ============================================================
// CodeMorph — JWT Configuration
// FIX CRITIQUE : JWT_EXPIRES_IN défaut '7d' (pas '15m')
// En cross-domain (Vercel → Render), le cookie refresh est bloqué.
// L'access token doit durer suffisamment longtemps (7d minimum).
// Le refresh token dure 30d.
// ============================================================
import { registerAs } from '@nestjs/config';

export const jwtConfig = registerAs('jwt', () => ({
  secret:             process.env['JWT_SECRET']          ?? 'dev-secret-change-in-production-64-bytes-random',
  // 7 jours — OBLIGATOIRE en cross-domain (cookie refresh bloqué CORS)
  // Ne jamais mettre '15m' ici : cela crée GEN_003 après 15 minutes
  expiresIn:          process.env['JWT_EXPIRES_IN']      ?? '7d',
  refreshSecret:      process.env['JWT_REFRESH_SECRET']  ?? 'dev-refresh-secret-change-in-production-64-bytes',
  refreshExpiresIn:   process.env['JWT_REFRESH_EXPIRES_IN'] ?? '30d',
}));

