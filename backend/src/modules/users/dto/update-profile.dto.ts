// ============================================================
// CodeMorph — UpdateProfileDto
// FIX PHASE 6 — SEC-15 : whitelist stricte pour PATCH /users/me
// Seuls name et avatarUrl sont autorisés.
// plan, role, status, stripeCustomerId, emailVerified → BLOQUÉS
// ============================================================
import { IsString, IsOptional, IsUrl, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: 'Display name', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name?: string;

  @ApiPropertyOptional({ description: 'Avatar URL (https only)', nullable: true })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'avatarUrl must be a valid HTTPS URL' })
  @MaxLength(2048)
  avatarUrl?: string | null;
}
