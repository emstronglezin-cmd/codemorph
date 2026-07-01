// ============================================================
// CodeMorph — Auth Module (with Google + GitHub OAuth)
// ============================================================
import { Module }        from '@nestjs/common';
import { JwtModule }     from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthController }  from './auth.controller';
import { AuthService }     from './auth.service';
import { JwtStrategy }     from './strategies/jwt.strategy';
import { LocalStrategy }   from './strategies/local.strategy';
import { GoogleStrategy }  from './strategies/google.strategy';
import { GitHubStrategy }  from './strategies/github.strategy';
import { UsersModule }     from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports:    [ConfigModule],
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:      config.get<string>('jwt.secret'),
        // FIX PHASE 10 — CAUSE RACINE BUG 2C :
        // Le fallback était '15m' → tokens expiraient en 15min si JWT_EXPIRES_IN absent de Render.
        // JwtAuthGuard renvoyait 401 → checkGithub() frontend lisait AUTH_002 → setGithubConnected(false).
        // Fix: fallback '7d' cohérent avec jwt.config.ts et .env.example.
        signOptions: { expiresIn: config.get<string>('jwt.expiresIn', '7d') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers:   [AuthService, JwtStrategy, LocalStrategy, GoogleStrategy, GitHubStrategy],
  exports:     [AuthService, JwtModule, UsersModule],
})
export class AuthModule {}
