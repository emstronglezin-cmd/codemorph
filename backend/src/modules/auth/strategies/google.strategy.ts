// ============================================================
// CodeMorph — Google OAuth Strategy
// FIX PHASE 38 — CAUSE RACINE GEN_003 :
//   "OAuth 2.0 authentication requires session support when using state"
//
// CAUSE : state: true dans passport-google-oauth20 exige express-session.
//         Le backend est stateless (JWT) — pas de session disponible.
//
// SOLUTION (identique au fix PHASE 19 appliqué à GitHub) :
//   Désactiver state dans passport-google-oauth20.
//   Le state CSRF est géré manuellement par le AuthController :
//     1. GET /auth/google → génère un state aléatoire → le stocke
//        dans un cookie httpOnly signé (cm_oauth_state, TTL 10min)
//        → redirige vers Google avec &state=<value>
//     2. GET /auth/google/callback → vérifie state du query param
//        vs cookie → supprime le cookie → continue le flow
//   Aucune session Express requise.
// ============================================================
import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback, Profile } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    const clientID = configService.get<string>('GOOGLE_CLIENT_ID', '');
    const callbackURL = configService.get<string>(
      'GOOGLE_CALLBACK_URL',
      'http://localhost:4000/api/v1/auth/google/callback',
    );

    // FIX PHASE 38 : state: false — le state CSRF est géré manuellement
    // via cookie httpOnly dans AuthController (voir googleAuth + googleCallback).
    // state: true nécessiterait express-session (incompatible avec JWT stateless).
    super({
      clientID,
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET', ''),
      callbackURL,
      scope: ['email', 'profile'],
      state: false,
    });

    // Validate configuration at startup — log without exposing secrets
    // NOTE: these logs run AFTER super() call (TS requirement)
    const log = new Logger(GoogleStrategy.name);
    if (!clientID) {
      log.error(
        '[Google OAuth] GOOGLE_CLIENT_ID is not configured. ' +
        'Google OAuth will fail. Set GOOGLE_CLIENT_ID in environment variables.',
      );
    }
    if (!configService.get<string>('GOOGLE_CLIENT_SECRET')) {
      log.error(
        '[Google OAuth] GOOGLE_CLIENT_SECRET is not configured. ' +
        'Google OAuth will fail. Set GOOGLE_CLIENT_SECRET in environment variables.',
      );
    }

    log.log(
      `[Google OAuth] Strategy initialized — clientID=${clientID ? `${clientID.slice(0, 8)}…` : '(NOT SET)'} ` +
      `callbackURL=${callbackURL}`,
    );
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    try {
      const email = profile.emails?.[0]?.value;
      const avatarUrl = profile.photos?.[0]?.value;

      if (!email) {
        this.logger.warn('[Google OAuth] No email found in Google profile');
        return done(new Error('No email found in Google profile'), undefined);
      }

      this.logger.log(
        `[Google OAuth] validate() — provider=google providerId=${profile.id.slice(0, 8)}… email=${email}`,
      );

      const user = await this.authService.validateOAuthUser({
        provider: 'google',
        providerId: profile.id,
        email,
        name: profile.displayName ?? `${profile.name?.givenName} ${profile.name?.familyName}`,
        avatarUrl,
      });

      done(null, user as false | Express.User);
    } catch (err) {
      this.logger.error(`[Google OAuth] validate() error: ${(err as Error).message}`);
      done(err as Error, undefined);
    }
  }
}
