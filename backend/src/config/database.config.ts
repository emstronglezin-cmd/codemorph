// ============================================================
// CodeMorph — Database Configuration
// ============================================================
import { registerAs } from '@nestjs/config';

export const databaseConfig = registerAs('database', () => ({
  url:      process.env['DATABASE_URL'],
  host:     process.env['DATABASE_HOST']     ?? 'localhost',
  port:     parseInt(process.env['DATABASE_PORT'] ?? '5432', 10),
  user:     process.env['DATABASE_USER']     ?? 'codemorph',
  password: process.env['DATABASE_PASSWORD'] ?? 'password',
  name:     process.env['DATABASE_NAME']     ?? 'codemorph_db',
  ssl:      process.env['DATABASE_SSL']      === 'true',
  pool: {
    max:              20,
    min:              2,
    acquire:          30_000,
    idle:             10_000,
  },
}));
