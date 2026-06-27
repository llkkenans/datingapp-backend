import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RatingsService } from './ratings.service';
import { SubmitRatingDto } from './dto/submit-rating.dto';

@ApiTags('Ratings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ratings')
export class RatingsController {
  constructor(private readonly ratingsService: RatingsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a 1–5 star rating after a match session ends' })
  @ApiResponse({ status: 201, description: 'Rating submitted' })
  @ApiResponse({ status: 400, description: 'Session is still in progress' })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Not a participant in this session' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 409, description: 'Already rated this session' })
  submitRating(
    @CurrentUser() userId: string,
    @Body() dto: SubmitRatingDto,
  ) {
    return this.ratingsService.submitRating(userId, dto);
  }
}
