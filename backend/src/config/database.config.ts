// ============================================================
// CodeMorph — Database Configuration
// Compatible Render PostgreSQL + Supabase PostgreSQL
// Supabase exige SSL (sslmode=require) — rejectUnauthorized: false
// car Supabase utilise un certificat auto-signé côté pooler.
// ============================================================
import { registerAs } from '@nestjs/config';

/**
 * Détermine si SSL doit être activé.
 *
 * Règles (par ordre de priorité) :
 *  1. DATABASE_SSL=true  → SSL activé
 *  2. DATABASE_SSL=false → SSL désactivé (dev local)
 *  3. Absent + DATABASE_URL contient "supabase.com" → SSL activé automatiquement
 *  4. Absent + NODE_ENV=production → SSL activé par sécurité
 *  5. Sinon → SSL désactivé (dev local sans variable)
 */
function resolveSsl(
  sslEnv: string | undefined,
  databaseUrl: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  if (sslEnv === 'true')  return true;
  if (sslEnv === 'false') return false;
  if (databaseUrl && databaseUrl.includes('supabase.com')) return true;
  if (nodeEnv === 'production') return true;
  return false;
}

export const databaseConfig = registerAs('database', () => {
  const databaseUrl = process.env['DATABASE_URL'];
  const sslEnabled  = resolveSsl(
    process.env['DATABASE_SSL'],
    databaseUrl,
    process.env['NODE_ENV'],
  );

  return {
    url:      databaseUrl,
    host:     process.env['DATABASE_HOST']     ?? 'localhost',
    port:     parseInt(process.env['DATABASE_PORT'] ?? '5432', 10),
    user:     process.env['DATABASE_USER']     ?? 'codemorph',
    password: process.env['DATABASE_PASSWORD'] ?? 'password',
    name:     process.env['DATABASE_NAME']     ?? 'codemorph_db',
    // ssl: true active { rejectUnauthorized: false } dans TypeOrmModule (app.module.ts)
    ssl: sslEnabled,
    pool: {
      max:     20,
      min:     2,
      acquire: 30_000,
      idle:    10_000,
    },
  };
});
