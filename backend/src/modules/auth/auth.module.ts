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
        signOptions: { expiresIn: config.get<string>('jwt.expiresIn', '15m') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers:   [AuthService, JwtStrategy, LocalStrategy, GoogleStrategy, GitHubStrategy],
  exports:     [AuthService, JwtModule, UsersModule],
})
export class AuthModule {}
