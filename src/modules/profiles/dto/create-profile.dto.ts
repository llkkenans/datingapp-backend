import {
  IsString,
  IsEnum,
  IsDateString,
  IsOptional,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, PreferredGender } from '@prisma/client';

export class CreateProfileDto {
  @ApiProperty({ example: 'john_doe', description: '3-20 chars, alphanumeric and underscores only' })
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'username may only contain letters, numbers, and underscores' })
  declare username: string;

  @ApiProperty({ example: '2000-05-15', description: 'ISO date string (YYYY-MM-DD). User must be 18+.' })
  @IsDateString()
  declare birthDate: string;

  @ApiProperty({ enum: Gender })
  @IsEnum(Gender)
  declare gender: Gender;

  @ApiProperty({ enum: PreferredGender })
  @IsEnum(PreferredGender)
  declare preferredGender: PreferredGender;

  @ApiProperty({ example: 'Istanbul' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  declare city: string;

  @ApiPropertyOptional({ example: 'Love hiking and good coffee.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiPropertyOptional({ type: [String], description: 'Array of Interest UUIDs to attach' })
  @IsOptional()
  @IsString({ each: true })
  interestIds?: string[];
}
