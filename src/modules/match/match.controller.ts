import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { MatchService } from './match.service';

@ApiTags('Match')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('match')
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  // ─── Queue entry ─────────────────────────────────────────────────────────────

  @Post('text')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Enter the text match queue' })
  @ApiResponse({ status: 202, description: 'Queued successfully' })
  @ApiResponse({ status: 409, description: 'Already in a queue or active session' })
  enqueueText(@CurrentUser() userId: string) {
    return this.matchService.enqueue(userId, 'TEXT');
  }

  @Post('voice')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Enter the voice match queue' })
  @ApiResponse({ status: 202, description: 'Queued successfully' })
  @ApiResponse({ status: 409, description: 'Already in a queue or active session' })
  enqueueVoice(@CurrentUser() userId: string) {
    return this.matchService.enqueue(userId, 'VOICE');
  }

  // ─── Queue exit ──────────────────────────────────────────────────────────────

  @Delete('text')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave the text match queue' })
  @ApiResponse({ status: 204, description: 'Left queue (or was not in it)' })
  async leaveTextQueue(@CurrentUser() userId: string): Promise<void> {
    await this.matchService.leaveQueue(userId, 'TEXT');
  }

  @Delete('voice')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave the voice match queue' })
  @ApiResponse({ status: 204, description: 'Left queue (or was not in it)' })
  async leaveVoiceQueue(@CurrentUser() userId: string): Promise<void> {
    await this.matchService.leaveQueue(userId, 'VOICE');
  }

  // ─── Session endpoints ───────────────────────────────────────────────────────

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get anonymous session state' })
  @ApiResponse({ status: 200, description: 'Session view (no real profile data)' })
  @ApiResponse({ status: 403, description: 'Not a participant' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  getSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser() userId: string,
  ) {
    return this.matchService.getSession(sessionId, userId);
  }

  @Post('sessions/:sessionId/like')
  @ApiOperation({ summary: 'Like the other party in an active session' })
  @ApiResponse({ status: 200, description: 'Like recorded; mutualLike indicates outcome' })
  @ApiResponse({ status: 403, description: 'Not a participant' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 409, description: 'Already liked' })
  @ApiResponse({ status: 410, description: 'Session is no longer active' })
  recordLike(
    @Param('sessionId') sessionId: string,
    @CurrentUser() userId: string,
  ) {
    return this.matchService.recordLike(sessionId, userId);
  }

  @Post('sessions/:sessionId/end')
  @ApiOperation({ summary: 'End the session early (skip / not interested)' })
  @ApiResponse({ status: 200, description: 'Session ended; rating screen should appear' })
  @ApiResponse({ status: 403, description: 'Not a participant' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  endSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser() userId: string,
  ) {
    return this.matchService.endSession(sessionId, userId);
  }

  @Get('sessions/:sessionId/rtc-token')
  @ApiOperation({ summary: 'Get a fresh ZEGOCLOUD token for a voice match room (reconnect)' })
  @ApiResponse({ status: 200, description: 'Token issued' })
  @ApiResponse({ status: 400, description: 'Session is not a voice session' })
  @ApiResponse({ status: 403, description: 'Not a participant' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 410, description: 'Session is no longer active' })
  getRtcToken(
    @Param('sessionId') sessionId: string,
    @CurrentUser() userId: string,
  ) {
    return this.matchService.getRtcToken(sessionId, userId);
  }
}
