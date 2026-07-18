// ============================================================
// CodeMorph — Auth Controller (Email + Google + GitHub OAuth)
// FIX PHASE 19 : GitHub OAuth state géré manuellement via cookie signé
// ============================================================
import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  Query,
  UseGuards,
  Res,
  Req,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { randomBytes, createHmac } from 'crypto';
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
import { UsersService }       from '../users/users.service';

interface OAuthRequest extends Request {
  user: UserEntity;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  // Durée de vie du cookie state OAuth : 10 minutes
  private static readonly OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  // ── Helper : signer/vérifier le state CSRF OAuth via HMAC ──
  // Permet de valider le state sans session Express
  private signState(state: string): string {
    const secret = process.env['COOKIE_SECRET'] ?? process.env['JWT_SECRET'] ?? 'fallback-state-secret';
    return createHmac('sha256', secret).update(state).digest('hex');
  }

  private verifyState(state: string, signature: string): boolean {
    const expected = this.signState(state);
    // Comparaison en temps constant pour éviter les timing attacks
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  }

  // ── POST /auth/sign-up ───────────────────────────────
  @Public()
  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  // SEC : limiter les inscriptions à 5/min pour éviter les créations massives
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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
  // SEC : limiter les tentatives de connexion à 10/min par IP (anti brute-force)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
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
    res.clearCookie('cm_refresh_token', { path: '/' });
    return { message: 'Signed out successfully' };
  }

  // ── POST /auth/change-password ────────────────────────
  // FIX PHASE 6 : route manquante — settings/page.tsx l'appelle mais elle n'existait pas
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Change password (requires current password)' })
  async changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() body: { currentPassword: string; newPassword: string },
  ): Promise<{ message: string }> {
    if (!body.currentPassword?.trim() || !body.newPassword?.trim()) {
      throw new BadRequestException('currentPassword and newPassword are required');
    }
    if (body.newPassword.length < 8) {
      throw new BadRequestException('newPassword must be at least 8 characters');
    }
    await this.authService.changePassword(user.sub, body.currentPassword, body.newPassword);
    return { message: 'Password changed successfully' };
  }

  // ── POST /auth/refresh ───────────────────────────────
  // Supporte : cookie httpOnly OU body.refreshToken
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token (cookie or body)' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req()  req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    // Priorité : cookie → body
    const token =
      (req.cookies as Record<string, string>)?.['cm_refresh_token'] ??
      dto.refreshToken;

    if (!token) {
      return res.status(HttpStatus.UNAUTHORIZED).json({
        statusCode: 401,
        message:    'No refresh token provided',
      });
    }

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
  @Public()
  @Get('google')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Initiate Google OAuth2 login' })
  googleAuth(): void {
    // Passport redirects
  }

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
    const frontendUrl = process.env['FRONTEND_URL'] ?? 'https://codemorph-coral.vercel.app';
    // FIX PHASE 3 — SEC-02 : token via cookie (httpOnly) uniquement
    // Avant : ?token= dans l'URL → exposé dans les logs Vercel/Render/Referer
    // Fix : le token est déjà dans le cookie httpOnly — on redirige sans token dans l'URL
    // La page oauth-success lira le token depuis un second appel sécurisé /auth/me via cookie
    res.redirect(`${frontendUrl}/auth/oauth-success`);
  }

  // ── GitHub OAuth ──────────────────────────────────────
  // FIX PHASE 19 : state CSRF géré manuellement via cookie signé httpOnly
  // (state: true dans passport-github2 nécessite express-session — incompatible JWT stateless)
  @Public()
  @Get('github')
  @ApiOperation({ summary: 'Initiate GitHub OAuth login (stateless state via signed cookie)' })
  async githubAuth(
    @Res() res: Response,
  ): Promise<void> {
    // 1. Générer un state aléatoire sécurisé
    const state  = randomBytes(32).toString('hex');
    const sig    = this.signState(state);
    const isProd = process.env['NODE_ENV'] === 'production';

    // 2. Stocker le state dans un cookie httpOnly signé (TTL 10min)
    res.cookie('cm_oauth_state', `${state}.${sig}`, {
      httpOnly: true,
      secure:   isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge:   AuthController.OAUTH_STATE_TTL_MS,
      path:     '/',
    });

    // 3. Construire l'URL GitHub OAuth avec le state
    const clientId    = process.env['GITHUB_CLIENT_ID'] ?? '';
    const callbackUrl = process.env['GITHUB_CALLBACK_URL']
      ?? 'http://localhost:4000/api/v1/auth/github/callback';

    const githubUrl = new URL('https://github.com/login/oauth/authorize');
    githubUrl.searchParams.set('client_id',    clientId);
    githubUrl.searchParams.set('redirect_uri', callbackUrl);
    githubUrl.searchParams.set('scope',        'user:email read:user read:org');
    githubUrl.searchParams.set('state',        state);

    this.logger.log(`[GitHub OAuth] Redirecting → GitHub state=${state.slice(0, 8)}…`);
    res.redirect(githubUrl.toString());
  }

  @Public()
  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  @ApiOperation({ summary: 'GitHub OAuth callback — validates state cookie' })
  async githubCallback(
    @Req()   req: OAuthRequest,
    @Res()   res: Response,
    @Query('state') queryState: string,
  ): Promise<void> {
    const frontendUrl = process.env['FRONTEND_URL'] ?? 'https://codemorph-coral.vercel.app';

    // 4. Valider le state depuis le cookie
    const cookies   = req.cookies as Record<string, string> | undefined;
    const cookieVal = cookies?.['cm_oauth_state'] ?? '';
    const dotIdx    = cookieVal.lastIndexOf('.');
    const cookieState = dotIdx > 0 ? cookieVal.slice(0, dotIdx) : '';
    const cookieSig   = dotIdx > 0 ? cookieVal.slice(dotIdx + 1) : '';

    const stateOk =
      cookieState.length > 0 &&
      cookieSig.length  > 0 &&
      cookieState === queryState &&
      this.verifyState(cookieState, cookieSig);

    if (!stateOk) {
      this.logger.warn(`[GitHub OAuth] State mismatch — cookie="${cookieVal.slice(0, 16)}…" query="${queryState?.slice(0, 8)}…"`);
      res.redirect(`${frontendUrl}/auth/sign-in?error=oauth_state_invalid`);
      return;
    }

    // 5. Supprimer le cookie state (usage unique)
    res.clearCookie('cm_oauth_state', { path: '/' });

    // 6. Émettre les JWT et rediriger
    const tokens = await this.authService.loginOAuthUser(req.user);
    this.setRefreshTokenCookie(res, tokens.refreshToken);
    this.logger.log(`[GitHub OAuth] Success → ${frontendUrl}/auth/oauth-success`);
    res.redirect(`${frontendUrl}/auth/oauth-success`);
  }

  // ── GET /auth/github-repos ────────────────────────────
  // Liste les repos GitHub de l'utilisateur (publics + privés)
  // via son GitHub access token stocké lors du OAuth flow
  @Get('github-repos')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'List user GitHub repositories' })
  async getGithubRepos(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = '1',
    @Query('per_page') perPage = '30',
    @Query('search') search = '',
    @Query('type') type = 'all',
  ): Promise<unknown> {
    const userWithToken = await this.usersService.findByIdWithGithubToken(user.sub);

    if (!userWithToken?.githubAccessToken) {
      throw new BadRequestException({
        code: 'GITHUB_NOT_CONNECTED',
        message: 'GitHub account not connected. Please sign in with GitHub first.',
        authUrl: '/api/v1/auth/github',
      });
    }

    const token = userWithToken.githubAccessToken;
    const pageNum    = Math.max(1, parseInt(page, 10) || 1);
    const perPageNum = Math.min(100, Math.max(1, parseInt(perPage, 10) || 30));

    try {
      // FIX PHASE 10 — CAUSE RACINE BUG 2A : fetch sans timeout
      // Si GitHub API met >30s → le frontend AbortController (30s) se déclenche avant
      // que le backend reçoive la réponse → frontend affiche "Load failed".
      // Fix: AbortController de 20s sur tous les appels GitHub API.
      const ghAbortController = new AbortController();
      const ghTimeoutId = setTimeout(() => ghAbortController.abort(), 20_000);

      let apiUrl: URL;
      let isSearch = false;

      if (search && search.trim()) {
        // FIX PHASE 10 — CAUSE RACINE BUG 2B : user:@me invalide dans GitHub Search API
        // L'API https://api.github.com/search/repositories ne supporte PAS user:@me.
        // Elle retourne une erreur 422 "Validation Failed" → "Load failed" côté frontend.
        //
        // Fix: utiliser /user/repos pour tous les cas (listing + search).
        // La recherche est faite côté serveur par filtrage JS sur le nom/description.
        // Cela garantit que seuls les repos ACCESSIBLES par le token sont retournés.
        //
        // Note: on charge plus de résultats (per_page max 100) pour filtrer efficacement.
        apiUrl = new URL('https://api.github.com/user/repos');
        apiUrl.searchParams.set('page', String(pageNum));
        apiUrl.searchParams.set('per_page', '100');  // Max pour optimiser le filtrage
        apiUrl.searchParams.set('sort', 'updated');
        apiUrl.searchParams.set('direction', 'desc');
        apiUrl.searchParams.set('affiliation', 'owner,collaborator,organization_member');
        if (type === 'public')  apiUrl.searchParams.set('visibility', 'public');
        if (type === 'private') apiUrl.searchParams.set('visibility', 'private');
        isSearch = true;  // indique qu'on doit filtrer les résultats
      } else {
        // Listing complet : utilise /user/repos avec affiliation pour couvrir
        // repos personnels + orgs + collaborations (publics ET privés)
        apiUrl = new URL('https://api.github.com/user/repos');
        apiUrl.searchParams.set('page', String(pageNum));
        apiUrl.searchParams.set('per_page', String(perPageNum));
        apiUrl.searchParams.set('sort', 'updated');
        apiUrl.searchParams.set('direction', 'desc');
        // affiliation=owner,collaborator,organization_member donne TOUS les repos
        // y compris les repos privés des organisations
        apiUrl.searchParams.set('affiliation', 'owner,collaborator,organization_member');
        // Filtrage visibility si demandé
        if (type === 'public')  apiUrl.searchParams.set('visibility', 'public');
        if (type === 'private') apiUrl.searchParams.set('visibility', 'private');
      }

      const ghRes = await fetch(apiUrl.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept:        'application/vnd.github.v3+json',
          'User-Agent':  'CodeMorph/1.0',
        },
        signal: ghAbortController.signal,
      });
      clearTimeout(ghTimeoutId);

      if (!ghRes.ok) {
        const errBody = await ghRes.text().catch(() => '');
        // Token expiré ou révoqué → forcer reconnexion
        if (ghRes.status === 401) {
          throw new BadRequestException({
            code:    'GITHUB_TOKEN_EXPIRED',
            message: 'GitHub token expired or revoked. Please reconnect your GitHub account.',
            authUrl: '/api/v1/auth/github',
          });
        }
        throw new BadRequestException(`GitHub API error: ${ghRes.status} — ${errBody}`);
      }

      // FIX PHASE 10 : /user/repos retourne toujours un tableau direct
      // (on n'utilise plus l'API search qui ne supportait pas user:@me)
      type GHRepo = {
        id: number; name: string; full_name: string; private: boolean;
        html_url: string; description: string | null; language: string | null;
        updated_at: string; stargazers_count: number; forks_count: number;
        default_branch: string; topics?: string[];
      };

      let repos: GHRepo[] = await ghRes.json() as GHRepo[];
      let totalCount: number;

      if (isSearch && search.trim()) {
        // Filtrage serveur-side : nom ou description contient le terme de recherche
        const q = search.trim().toLowerCase();
        repos = repos.filter(r =>
          r.name.toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q) ||
          r.full_name.toLowerCase().includes(q),
        );
        totalCount = repos.length;
        // Appliquer la pagination sur les résultats filtrés
        repos = repos.slice((pageNum - 1) * perPageNum, pageNum * perPageNum);
      } else {
        // Extraire le total depuis le header Link si disponible
        const linkHeader = ghRes.headers.get('link') ?? '';
        const lastPageMatch = linkHeader.match(/page=(\d+)>; rel="last"/);
        totalCount = lastPageMatch
          ? parseInt(lastPageMatch[1], 10) * perPageNum
          : repos.length + (pageNum - 1) * perPageNum;
      }

      // Filtre côté serveur par visibility si type spécifié
      const filtered = (type !== 'all')
        ? repos.filter(r => type === 'private' ? r.private : !r.private)
        : repos;

      return {
        repos: filtered.map(r => ({
          id:            r.id,
          name:          r.name,
          fullName:      r.full_name,
          private:       r.private,
          url:           r.html_url,
          description:   r.description,
          language:      r.language,
          updatedAt:     r.updated_at,
          stars:         r.stargazers_count,
          forks:         r.forks_count,
          defaultBranch: r.default_branch,
          topics:        r.topics ?? [],
        })),
        page:     pageNum,
        perPage:  perPageNum,
        total:    totalCount,
        hasMore:  filtered.length === perPageNum,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // FIX PHASE 10 : détecter le timeout AbortController (20s) et retourner un message clair
      const errName = (err as { name?: string })?.name ?? '';
      if (errName === 'AbortError') {
        throw new BadRequestException({
          code:    'GITHUB_API_TIMEOUT',
          message: 'GitHub API did not respond within 20 seconds. Please try again in a moment.',
        });
      }
      throw new BadRequestException(`Failed to fetch GitHub repos: ${String(err)}`);
    }
  }

  // ── GET /auth/github-status ───────────────────────────
  @Get('github-status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Check GitHub connection status' })
  async getGithubStatus(@CurrentUser() user: JwtPayload): Promise<unknown> {
    const userWithToken = await this.usersService.findByIdWithGithubToken(user.sub);
    return {
      connected: !!(userWithToken?.githubAccessToken),
      authUrl: '/api/v1/auth/github',
    };
  }

  // ── Private helpers ───────────────────────────────────
  private setRefreshTokenCookie(res: Response, token: string): void {
    const isProd = process.env['NODE_ENV'] === 'production';
    res.cookie('cm_refresh_token', token, {
      httpOnly: true,
      secure:   isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 jours
      path:     '/',
    });
  }
}
