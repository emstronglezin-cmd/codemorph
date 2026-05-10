// ============================================================
// CodeMorph — Sign In DTO
// ============================================================
import { IsEmail, IsString, IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignInDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongP@ss1' })
  @IsString()
  password!: string;

  @ApiProperty({ required: false, default: false })
  @IsBoolean()
  @IsOptional()
  rememberMe?: boolean;
}
