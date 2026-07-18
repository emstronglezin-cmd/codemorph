// ============================================================
// CodeMorph — GitHub OAuth Strategy
// FIX PHASE 19 — BUG CRITIQUE :
//   "OAuth 2.0 authentication requires session support when using state"
//
// CAUSE : state: true dans passport-github2 exige express-session.
//         Le backend est stateless (JWT) — pas de session disponible.
//
// SOLUTION : Désactiver state dans passport-github2.
//            Le state CSRF est géré manuellement par le AuthController :
//            1. GET /auth/github → génère un state aléatoire → le stocke
//               dans un cookie httpOnly signé (cm_oauth_state, TTL 10min)
//               → redirige vers GitHub avec &state=<value>
//            2. GET /auth/github/callback → vérifie state du query param
//               vs cookie → supprime le cookie → continue le flow
//            Aucune session Express requise.
// ============================================================
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

@Injectable()
export class GitHubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      clientID:     configService.get<string>('GITHUB_CLIENT_ID', ''),
      clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET', ''),
      callbackURL:  configService.get<string>(
        'GITHUB_CALLBACK_URL',
        'http://localhost:4000/api/v1/auth/github/callback',
      ),
      // Scopes minimaux nécessaires — sans 'repo' (écriture inutile)
      scope: ['user:email', 'read:user', 'read:org'],
      // FIX PHASE 19 : state: false — le state CSRF est géré manuellement
      // via cookie httpOnly dans AuthController (voir githubAuth + githubCallback)
      state: false,
    });
  }

  async validate(
    accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: (err: Error | null, user?: unknown) => void,
  ): Promise<void> {
    try {
      const email =
        profile.emails?.[0]?.value ?? `${profile.username}@github.noreply.com`;
      const avatarUrl = profile.photos?.[0]?.value;

      const user = await this.authService.validateOAuthUser({
        provider:    'github',
        providerId:  profile.id,
        email,
        name:        profile.displayName ?? profile.username ?? 'GitHub User',
        avatarUrl,
        accessToken, // stocké dans user.githubAccessToken (isolation FIX-2)
      });

      done(null, user);
    } catch (err) {
      done(err as Error, undefined);
    }
  }
}
