// ============================================================
// CodeMorph — StartFromGithubDto
// FIX: DTO avec décorateurs class-validator pour ValidationPipe
// Sans DTO → ValidationPipe(whitelist:true) stripe tous les champs
// → body vide → "repo is required" 400
// ============================================================
import { IsString, IsOptional, MaxLength, Matches } from 'class-validator';

export class StartFromGithubDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsString()
  sourceLanguage!: string;

  @IsString()
  targetLanguage!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, {
    message: 'repo must be in format "owner/repo"',
  })
  repo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  goalPrompt?: string;
}
