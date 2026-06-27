import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { InterestsService } from './interests.service';

@ApiTags('interests')
@Controller('interests')
export class InterestsController {
  constructor(private readonly interestsService: InterestsService) {}

  @Get()
  @ApiOkResponse({ description: 'Full list of available interests' })
  findAll() {
    return this.interestsService.findAll();
  }
}
