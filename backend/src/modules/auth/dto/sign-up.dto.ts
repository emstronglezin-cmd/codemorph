// ============================================================
// CodeMorph — Sign Up DTO
// ============================================================
import { IsEmail, IsString, MinLength, MaxLength, IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignUpDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongP@ss1', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  // Optionnel — le frontend peut ne pas l'envoyer (V1 sans checkbox obligatoire)
  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  acceptTerms?: boolean;
}
