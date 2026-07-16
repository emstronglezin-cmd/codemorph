// ============================================================
// CodeMorph — Auth Service
// ============================================================
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

import type { AuthTokens, JwtPayload, UserId } from '@codemorph/shared';
import { UsersService } from '../users/users.service';
import { CacheService } from '../../cache/cache.service';
import type { SignUpDto } from './dto/sign-up.dto';
import type { SignInDto } from './dto/sign-in.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService:   JwtService,
    private readonly config:        ConfigService,
    private readonly cacheService:  CacheService,
  ) {}

  // ── Validate credentials ─────────────────────────────
  async validateUser(email: string, password: string): Promise<unknown | null> {
    const user = await this.usersService.findByEmail(email);
    if (!user) return null;

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) return null;

    return user;
  }

  // ── Sign Up ───────────────────────────────────────────
  async signUp(dto: SignUpDto): Promise<{ user: unknown; tokens: AuthTokens }> {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already in use');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.usersService.create({
      name:         dto.name,
      email:        dto.email,
      passwordHash,
    });

    const tokens = await this.generateTokens(user);
    return { user, tokens };
  }

  // ── Sign In ───────────────────────────────────────────
  async signIn(dto: SignInDto): Promise<{ user: unknown; tokens: AuthTokens }> {
    const user = await this.usersService.findByEmail(dto.email);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status === 'suspended') {
      throw new UnauthorizedException('Account suspended. Contact support.');
    }

    const isValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.usersService.updateLastLogin(user.id as UserId);
    const tokens = await this.generateTokens(user);
    return { user, tokens };
  }

  // ── Sign Out ─────────────────────────────────────────
  // FIX PHASE 2 — SEC-08 : signOut invalide maintenant les refresh tokens via Redis
  // Format de clé : cm:revoked:user:<userId> — tous les tokens du user sont révoqués
  async signOut(userId: UserId): Promise<void> {
    try {
      const refreshExpiresIn = this.config.get<string>('jwt.refreshExpiresIn') ?? '30d';
      const ttlSecs = Math.floor(this.parseExpiry(refreshExpiresIn) / 1000);
      await this.cacheService.set(`cm:revoked:user:${userId as string}`, '1', ttlSecs);
      this.logger.log(`[signOut] User ${userId} — refresh tokens revoked (TTL ${ttlSecs}s)`);
    } catch (err) {
      // Ne pas bloquer si Redis down — signOut gracieux
      this.logger.warn(`[signOut] Redis unavailable — revocation not persisted: ${(err as Error).message}`);
    }
  }

  // ── Refresh Tokens ────────────────────────────────────
  // FIX PHASE 2 — SEC-08 : vérifier la blocklist Redis avant d'émettre de nouveaux tokens
  async refreshTokens(refreshToken: string): Promise<{ tokens: AuthTokens }> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token required');
    }

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Vérifier si l'utilisateur est révoqué (déconnecté côté serveur)
    try {
      const revoked = await this.cacheService.get<string>(`cm:revoked:user:${payload.sub}`);
      if (revoked) {
        throw new UnauthorizedException('Session revoked. Please sign in again.');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      // Redis down → ignorer (fail open pour disponibilité)
      this.logger.warn(`[refreshTokens] Redis unavailable — skipping revocation check`);
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('User not found or inactive');
    }

    const tokens = await this.generateTokens(user);
    return { tokens };
  }

  // ── Forgot Password ───────────────────────────────────
  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) return; // Silent — don't leak user existence

    const resetToken = uuidv4();
    // TODO: store reset token with expiry in Redis
    // TODO: send email via NotificationsService
    void resetToken;
  }

  // ── Reset Password ────────────────────────────────────
  async resetPassword(token: string, newPassword: string): Promise<void> {
    // TODO: validate token from Redis
    // TODO: find user by token
    void token;

    const passwordHash = await bcrypt.hash(newPassword, 12);
    void passwordHash;
    // await this.usersService.updatePassword(userId, passwordHash);
  }

  // ── Change Password (authenticated) ──────────────────
  // FIX PHASE 6 : route manquante — settings/page.tsx l'appelle
  async changePassword(userId: UserId, currentPassword: string, newPassword: string): Promise<void> {
    // 1. Charger l'utilisateur avec son hash (select: false sur passwordHash)
    const user = await this.usersService.findByIdOrFail(userId);

    // 2. Vérifier que l'utilisateur a un compte email (pas OAuth-only)
    if (!user.passwordHash) {
      throw new BadRequestException(
        'Your account uses OAuth (Google/GitHub) — password change not supported. ' +
        'Please use the OAuth provider to manage your account.',
      );
    }

    // 3. Vérifier l'ancien mot de passe
    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // 4. Hasher et sauvegarder le nouveau mot de passe
    const newHash = await bcrypt.hash(newPassword, 12);
    await this.usersService.updatePassword(userId, newHash);

    // 5. Révoquer tous les tokens existants (re-login requis)
    try {
      const refreshExpiresIn = this.config.get<string>('jwt.refreshExpiresIn') ?? '30d';
      const ttlSecs = Math.floor(this.parseExpiry(refreshExpiresIn) / 1000);
      await this.cacheService.set(`cm:revoked:user:${userId as string}`, '1', ttlSecs);
      this.logger.log(`[changePassword] User ${userId as string} — tokens revoked after password change`);
    } catch {
      this.logger.warn(`[changePassword] Redis unavailable — token revocation skipped`);
    }
  }

  // ── Get Me ───────────────────────────────────────────
  async getMe(userId: UserId): Promise<unknown> {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // ── OAuth User (Google / GitHub) ─────────────────────
  async validateOAuthUser(profile: {
    provider: string;
    providerId: string;
    email: string;
    name: string;
    avatarUrl?: string;
    accessToken?: string;
  }): Promise<unknown> {
    // Try to find existing user by OAuth provider ID or email
    let user = await this.usersService.findByOAuth(profile.provider, profile.providerId);
    if (!user) {
      user = await this.usersService.findByEmail(profile.email);
    }

    if (user) {
      // Update OAuth info & access token if needed
      await this.usersService.updateOAuth(user.id as UserId, {
        oauthProvider: profile.provider,
        oauthProviderId: profile.providerId,
        avatarUrl: user.avatarUrl ?? profile.avatarUrl ?? null,
        githubAccessToken: profile.provider === 'github' ? (profile.accessToken ?? null) : user.githubAccessToken,
        status: 'active' as const,
      });
      return user;
    }

    // Create new OAuth user (no password)
    const newUser = await this.usersService.create({
      name: profile.name,
      email: profile.email,
      passwordHash: await bcrypt.hash(uuidv4(), 12), // random unusable password
      avatarUrl: profile.avatarUrl ?? null,
      oauthProvider: profile.provider,
      oauthProviderId: profile.providerId,
      githubAccessToken: profile.provider === 'github' ? (profile.accessToken ?? null) : null,
      status: 'active' as const,
      emailVerified: true,
    });
    return newUser;
  }

  // ── Login OAuth User → issue JWT ─────────────────────
  async loginOAuthUser(user: {
    id: string;
    email: string;
    role: string;
    plan: string;
  }): Promise<AuthTokens> {
    await this.usersService.updateLastLogin(user.id as UserId);
    const tokens = await this.generateTokens(user);
    this.logger.log(`[OAuth] JWT issued for user=${user.id} email=${user.email} expiresIn=${tokens.expiresIn}s`);
    return tokens;
  }

  // ── Parse expiry string to milliseconds ─────────────
  private parseExpiry(exp: string): number {
    const match = /^(\d+)(s|m|h|d)$/.exec(exp);
    if (!match) return 7 * 24 * 3600 * 1000; // fallback 7d
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 3600 * 1000;
      case 'd': return value * 86400 * 1000;
      default:  return 7 * 24 * 3600 * 1000;
    }
  }

  // ── Generate tokens ───────────────────────────────────
  private async generateTokens(user: {
    id: string;
    email: string;
    role: string;
    plan: string;
  }): Promise<AuthTokens> {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub:   user.id as UserId,
      email: user.email,
      role:  user.role as JwtPayload['role'],
      plan:  user.plan as JwtPayload['plan'],
    };

    // ── FIX CRITIQUE : toujours lire depuis la config (jwt.config.ts)
    // jwt.config.ts lit JWT_EXPIRES_IN (env) avec défaut '7d'
    // NE PAS mettre de fallback court ('15m') ici — cela override la config
    const accessExpiresIn  = this.config.get<string>('jwt.expiresIn')  ?? '7d';
    const refreshExpiresIn = this.config.get<string>('jwt.refreshExpiresIn') ?? '30d';

    this.logger.debug(`[generateTokens] accessExpiresIn=${accessExpiresIn} refreshExpiresIn=${refreshExpiresIn}`);

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret:    this.config.get<string>('jwt.secret'),
        expiresIn: accessExpiresIn,
      }),
      this.jwtService.signAsync(payload, {
        secret:    this.config.get<string>('jwt.refreshSecret'),
        expiresIn: refreshExpiresIn,
      }),
    ]);

    // Calculer expiresIn en secondes selon la config réelle
    // Pour éviter la confusion entre la valeur retournée et la valeur réelle
    const accessExpMs = this.parseExpiry(accessExpiresIn);

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessExpMs / 1000),
      tokenType: 'Bearer',
    };
  }
}
