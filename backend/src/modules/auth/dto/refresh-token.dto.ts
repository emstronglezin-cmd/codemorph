import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  refreshToken?: string;
}
