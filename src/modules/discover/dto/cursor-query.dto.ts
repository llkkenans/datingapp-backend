import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CursorQueryDto {
  @ApiPropertyOptional({ description: 'Opaque pagination cursor (ISO timestamp of last item)' })
  @IsOptional()
  @IsString()
  before?: string;
}
