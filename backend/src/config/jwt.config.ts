// ============================================================
// CodeMorph — JWT Configuration
// ============================================================
import { registerAs } from '@nestjs/config';

export const jwtConfig = registerAs('jwt', () => ({
  secret:             process.env['JWT_SECRET']          ?? 'dev-secret-change-in-production',
  expiresIn:          process.env['JWT_EXPIRES_IN']      ?? '15m',
  refreshSecret:      process.env['JWT_REFRESH_SECRET']  ?? 'dev-refresh-secret-change-in-production',
  refreshExpiresIn:   process.env['JWT_REFRESH_EXPIRES_IN'] ?? '7d',
}));
