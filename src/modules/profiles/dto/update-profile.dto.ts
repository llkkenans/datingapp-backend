import {
  IsString,
  IsEnum,
  IsOptional,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, PreferredGender } from '@prisma/client';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'john_doe', description: '3-20 chars, alphanumeric and underscores only' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'username may only contain letters, numbers, and underscores' })
  username?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ enum: PreferredGender })
  @IsOptional()
  @IsEnum(PreferredGender)
  preferredGender?: PreferredGender;

  @ApiPropertyOptional({ example: 'Istanbul' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ example: 'Love hiking and good coffee.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiPropertyOptional({ type: [String], description: 'Array of Interest UUIDs — replaces the full interest list' })
  @IsOptional()
  @IsString({ each: true })
  interestIds?: string[];
}
