// ============================================================
// CodeMorph — JWT Strategy
// FIX: logs détaillés pour diagnostiquer les rejets de token
// ============================================================
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

import type { JwtPayload } from '@codemorph/shared';
import { UsersService } from '../../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:      config.get<string>('jwt.secret') ?? 'fallback-secret',
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    this.logger.debug(
      `[validate] sub=${payload.sub} email=${payload.email} ` +
      `exp=${payload.exp ? new Date(payload.exp * 1000).toISOString() : 'none'}`
    );

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      this.logger.warn(`[validate] User not found: sub=${payload.sub}`);
      throw new UnauthorizedException('Account not found or suspended');
    }
    if (user.status !== 'active') {
      this.logger.warn(`[validate] User suspended: sub=${payload.sub} status=${user.status}`);
      throw new UnauthorizedException('Account not found or suspended');
    }
    return payload;
  }
}
