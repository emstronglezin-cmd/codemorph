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
      clientID: configService.get<string>('GITHUB_CLIENT_ID', ''),
      clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET', ''),
      callbackURL: configService.get<string>(
        'GITHUB_CALLBACK_URL',
        'http://localhost:4000/api/v1/auth/github/callback',
      ),
      // FIX PHASE 3 — SEC-03 : scopes réduits au minimum nécessaire
      // 'repo' donnait accès en écriture à tous les repos — trop permissif
      // 'read:org' ajouté pour les organisations
      scope: ['user:email', 'read:user', 'read:org'],
      // state: true active la validation CSRF du paramètre state OAuth
      // passport-github2 génère et vérifie automatiquement le state
      state: true,
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
        provider: 'github',
        providerId: profile.id,
        email,
        name: profile.displayName ?? profile.username ?? 'GitHub User',
        avatarUrl,
        accessToken, // store GitHub access token for API calls
      });

      done(null, user);
    } catch (err) {
      done(err as Error, undefined);
    }
  }
}
