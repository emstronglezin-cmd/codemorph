// ============================================================
// CodeMorph — StartFromZipDto
// FIX: DTO avec décorateurs class-validator pour ValidationPipe
// ============================================================
import { IsString, IsOptional, MaxLength } from 'class-validator';

export class StartFromZipDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsString()
  sourceLanguage!: string;

  @IsString()
  targetLanguage!: string;

  @IsString()
  zipPath!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  goalPrompt?: string;
}
