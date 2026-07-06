// ============================================================
// CodeMorph — StartFromUrlDto
// FIX: DTO avec décorateurs class-validator pour ValidationPipe
// ============================================================
import { IsString, IsOptional, IsUrl, MaxLength } from 'class-validator';

export class StartFromUrlDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsString()
  sourceLanguage!: string;

  @IsString()
  targetLanguage!: string;

  @IsUrl({}, { message: 'sourceUrl must be a valid URL (http/https)' })
  sourceUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  goalPrompt?: string;
}
