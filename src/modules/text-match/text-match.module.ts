import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';

/**
 * Text match session lifecycle — implementation starts in the next phase.
 * Will own: queue entry/exit, 3-min timer, mutual-like state, conversation creation.
 * Depends on MatchingModule for queue/presence primitives.
 */
@Module({
  imports: [MatchingModule],
})
export class TextMatchModule {}
