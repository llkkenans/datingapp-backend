import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OnboardingService } from './onboarding.service';
import { CreateProfileDto } from '../profiles/dto/create-profile.dto';

@ApiTags('onboarding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Post('complete')
  @ApiCreatedResponse({ description: 'Profile created, onboarding complete' })
  @ApiConflictResponse({ description: 'Onboarding already completed or username taken' })
  complete(@CurrentUser() userId: string, @Body() dto: CreateProfileDto) {
    return this.onboardingService.complete(userId, dto);
  }

  @Get('check-username')
  @ApiQuery({ name: 'username', required: true, example: 'john_doe' })
  @ApiOkResponse({ description: 'Username availability check' })
  checkUsername(@Query('username') username: string) {
    return this.onboardingService.checkUsername(username);
  }
}
