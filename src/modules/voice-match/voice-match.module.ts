import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';

/**
 * Voice match session lifecycle — implementation starts in the next phase.
 * Will own: voice queue, RTC token generation, 3-min anonymous session,
 * mutual-like → unlimited extension, conversation creation on end.
 * Depends on MatchingModule for queue/presence primitives.
 */
@Module({
  imports: [MatchingModule],
})
export class VoiceMatchModule {}
