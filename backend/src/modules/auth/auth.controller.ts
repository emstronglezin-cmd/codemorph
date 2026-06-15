// ============================================================
// CodeMorph — Auth Controller (Email + Google + GitHub OAuth)
// ============================================================
import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  UseGuards,
  Res,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import type { Response, Request } from 'express';

import { AuthService }        from './auth.service';
import { SignUpDto }          from './dto/sign-up.dto';
import { SignInDto }          from './dto/sign-in.dto';
import { ForgotPasswordDto }  from './dto/forgot-password.dto';
import { ResetPasswordDto }   from './dto/reset-password.dto';
import { RefreshTokenDto }    from './dto/refresh-token.dto';
import { Public }             from '../../common/decorators/public.decorator';
import { JwtAuthGuard }       from '../../common/guards/jwt-auth.guard';
import { CurrentUser }        from '../../common/decorators/current-user.decorator';
import type { JwtPayload }    from '@codemorph/shared';
import type { UserEntity }    from '../users/entities/user.entity';

// ── Typed OAuth request ──────────────────────────────────
interface OAuthRequest extends Request {
  user: UserEntity;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── POST /auth/sign-up ───────────────────────────────
  @Public()
  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async signUp(
    @Body() dto: SignUpDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.authService.signUp(dto);
    this.setRefreshTokenCookie(res, result.tokens.refreshToken);
    return result;
  }

  // ── POST /auth/sign-in ───────────────────────────────
  @Public()
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email & password' })
  @ApiResponse({ status: 200, description: 'Sign in successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async signIn(
    @Body() dto: SignInDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.authService.signIn(dto);
    this.setRefreshTokenCookie(res, result.tokens.refreshToken);
    return result;
  }

  // ── POST /auth/sign-out ──────────────────────────────
  @Post('sign-out')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Sign out and revoke tokens' })
  async signOut(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    await this.authService.signOut(user.sub);
    res.clearCookie('cm_refresh_token');
    return { message: 'Signed out successfully' };
  }

  // ── POST /auth/refresh ───────────────────────────────
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req()  req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const token  = dto.refreshToken ?? (req.cookies as Record<string, string>)['cm_refresh_token'];
    const result = await this.authService.refreshTokens(token);
    this.setRefreshTokenCookie(res, result.tokens.refreshToken);
    return result;
  }

  // ── POST /auth/forgot-password ───────────────────────
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.authService.forgotPassword(dto.email);
    return { message: 'If the email exists, a reset link has been sent' };
  }

  // ── POST /auth/reset-password ────────────────────────
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.authService.resetPassword(dto.token, dto.password);
    return { message: 'Password reset successfully' };
  }

  // ── GET /auth/me ─────────────────────────────────────
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get current authenticated user' })
  async getMe(@CurrentUser() user: JwtPayload): Promise<unknown> {
    return this.authService.getMe(user.sub);
  }

  // ── Google OAuth ──────────────────────────────────────
  // GET /auth/google  → redirects to Google consent screen
  @Public()
  @Get('google')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Initiate Google OAuth2 login' })
  googleAuth(): void {
    // Passport redirects — nothing to do here
  }

  // GET /auth/google/callback  → receives Google token → issues JWT
  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Google OAuth2 callback' })
  async googleCallback(
    @Req()  req: OAuthRequest,
    @Res()  res: Response,
  ): Promise<void> {
    const tokens = await this.authService.loginOAuthUser(req.user);
    this.setRefreshTokenCookie(res, tokens.refreshToken);
    const frontendUrl = process.env['FRONTEND_URL'] ?? 'http://localhost:3000';
    res.redirect(`${frontendUrl}/auth/oauth-success?token=${tokens.accessToken}`);
  }

  // ── GitHub OAuth ──────────────────────────────────────
  // GET /auth/github  → redirects to GitHub consent screen
  @Public()
  @Get('github')
  @UseGuards(AuthGuard('github'))
  @ApiOperation({ summary: 'Initiate GitHub OAuth login' })
  githubAuth(): void {
    // Passport redirects
  }

  // GET /auth/github/callback → receives GitHub token → issues JWT
  @Public()
  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  @ApiOperation({ summary: 'GitHub OAuth callback' })
  async githubCallback(
    @Req()  req: OAuthRequest,
    @Res()  res: Response,
  ): Promise<void> {
    const tokens = await this.authService.loginOAuthUser(req.user);
    this.setRefreshTokenCookie(res, tokens.refreshToken);
    const frontendUrl = process.env['FRONTEND_URL'] ?? 'http://localhost:3000';
    res.redirect(`${frontendUrl}/auth/oauth-success?token=${tokens.accessToken}`);
  }

  // ── Private helpers ───────────────────────────────────
  private setRefreshTokenCookie(res: Response, token: string): void {
    const isProd = process.env['NODE_ENV'] === 'production';
    res.cookie('cm_refresh_token', token, {
      httpOnly: true,
      // Cross-domain (Vercel frontend ↔ Render backend) :
      // sameSite DOIT être 'none' + secure: true en production
      secure:   isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge:   7 * 24 * 60 * 60 * 1000,
      path:     '/',  // '/' au lieu de '/api/v1/auth/refresh' pour que le cookie
                      // soit envoyé sur toutes les routes (cross-origin en prod)
    });
  }
}
