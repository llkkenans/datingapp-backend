import { IsInt, IsString, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SubmitRatingDto {
  @ApiProperty({ description: 'Match session ID to rate', format: 'uuid' })
  @IsString()
  @IsUUID()
  declare sessionId: string;

  @ApiProperty({ description: '1–5 star rating', minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  declare stars: number;
}
