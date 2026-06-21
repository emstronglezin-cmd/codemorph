// ============================================================
// CodeMorph — JWT Configuration
// ============================================================
import { registerAs } from '@nestjs/config';

export const jwtConfig = registerAs('jwt', () => ({
  secret:             process.env['JWT_SECRET']          ?? 'dev-secret-change-in-production',
  // 7 jours — évite les boucles de redirection dues aux JWT courts (15m)
  // En cross-domain Vercel↔Render, le refresh cookie est bloqué → on rallonge l'access token
  expiresIn:          process.env['JWT_EXPIRES_IN']      ?? '7d',
  refreshSecret:      process.env['JWT_REFRESH_SECRET']  ?? 'dev-refresh-secret-change-in-production',
  refreshExpiresIn:   process.env['JWT_REFRESH_EXPIRES_IN'] ?? '30d',
}));
