// ============================================================
// CodeMorph — CreateProjectDto
// FIX: DTO avec décorateurs class-validator pour que
// ValidationPipe(whitelist:true, forbidNonWhitelisted:true)
// accepte le body sans stripper les champs.
// ============================================================
import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';
import type { SourceLanguage, TargetLanguage } from '../entities/project.entity';

export class CreateProjectDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsString()
  @IsIn([
    'javascript', 'typescript', 'python', 'java', 'csharp',
    'php', 'ruby', 'go', 'flutter', 'dart', 'react',
  ], {
    message: 'sourceLanguage must be one of: javascript, typescript, python, java, csharp, php, ruby, go, flutter, dart, react',
  })
  sourceLanguage!: SourceLanguage;

  @IsString()
  @IsIn([
    'typescript', 'rust', 'kotlin', 'swift', 'dart',
    'flutter', 'react', 'react-native', 'reactnative',
  ], {
    message: 'targetLanguage must be one of: typescript, rust, kotlin, swift, dart, flutter, react, react-native, reactnative',
  })
  targetLanguage!: TargetLanguage;

  @IsOptional()
  @IsString()
  orgId?: string;
}
