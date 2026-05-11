// ============================================================
// CodeMorph — Auth Service
// ============================================================
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

import type { AuthTokens, JwtPayload, UserId } from '@codemorph/shared';
import { UsersService } from '../users/users.service';
import type { SignUpDto } from './dto/sign-up.dto';
import type { SignInDto } from './dto/sign-in.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService:   JwtService,
    private readonly config:        ConfigService,
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
  async signOut(_userId: UserId): Promise<void> {
    // In production: invalidate refresh token in Redis
    // await this.redis.del(`cm:session:${userId}`);
  }

  // ── Refresh Tokens ────────────────────────────────────
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
    return this.generateTokens(user);
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

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret:    this.config.get<string>('jwt.secret'),
        expiresIn: this.config.get<string>('jwt.expiresIn', '15m'),
      }),
      this.jwtService.signAsync(payload, {
        secret:    this.config.get<string>('jwt.refreshSecret'),
        expiresIn: this.config.get<string>('jwt.refreshExpiresIn', '7d'),
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutes in seconds
      tokenType: 'Bearer',
    };
  }
}
