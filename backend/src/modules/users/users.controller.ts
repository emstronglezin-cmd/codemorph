// ============================================================
// CodeMorph — Users Controller
// FIX PHASE 19 : +DELETE /users/me/github (disconnect GitHub)
// ============================================================
import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { UsersService }    from './users.service';
import { JwtAuthGuard }   from '../../common/guards/jwt-auth.guard';
import { CurrentUser }    from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '@codemorph/shared';
// FIX PHASE 6 — SEC-15 : DTO whitelist stricte (bloque plan/role/status)
import { UpdateProfileDto } from './dto/update-profile.dto';

@ApiTags('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@CurrentUser() user: JwtPayload): Promise<unknown> {
    return this.usersService.findByIdOrFail(user.sub);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update current user profile (name and avatarUrl only)' })
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() body: UpdateProfileDto,
  ): Promise<unknown> {
    // FIX SEC-15 : UpdateProfileDto est validé par ValidationPipe global
    // Seuls name et avatarUrl peuvent être modifiés — plan/role/status ignorés
    return this.usersService.update(user.sub, {
      name:      body.name,
      avatarUrl: body.avatarUrl,
    });
  }

  // FIX PHASE 19 — FIX-2 : déconnecter GitHub (supprime le token)
  // Après déconnexion, /auth/github-repos retourne GITHUB_NOT_CONNECTED
  // → frontend ne peut plus afficher de repos (isolation garantie)
  @Delete('me/github')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect GitHub account (removes stored access token)' })
  async disconnectGithub(@CurrentUser() user: JwtPayload): Promise<void> {
    await this.usersService.disconnectGithub(user.sub);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deactivate current user account' })
  async deactivate(@CurrentUser() user: JwtPayload): Promise<void> {
    await this.usersService.deactivate(user.sub);
  }
}

