import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MatchStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SubmitRatingDto } from './dto/submit-rating.dto';

const ENDED_STATUSES: MatchStatus[] = [
  MatchStatus.ENDED,
  MatchStatus.EXPIRED,
  MatchStatus.MUTUAL_LIKE,
];

@Injectable()
export class RatingsService {
  constructor(private readonly prisma: PrismaService) {}

  async submitRating(
    raterId: string,
    dto: SubmitRatingDto,
  ): Promise<{ success: true }> {
    const session = await this.prisma.matchSession.findUnique({
      where: { id: dto.sessionId },
      select: { id: true, status: true, userAId: true, userBId: true },
    });

    if (!session) {
      throw new NotFoundException('Match session not found');
    }

    const isParticipant =
      session.userAId === raterId || session.userBId === raterId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this session');
    }

    if (!ENDED_STATUSES.includes(session.status)) {
      throw new BadRequestException(
        'You can only rate a session after it has ended',
      );
    }

    const ratedId =
      session.userAId === raterId ? session.userBId : session.userAId;

    try {
      await this.prisma.rating.create({
        data: {
          matchSessionId: dto.sessionId,
          raterId,
          ratedId,
          stars: dto.stars,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'You have already submitted a rating for this session',
        );
      }
      throw err;
    }

    // qualityScore update: deferred — see docs/DECISIONS.md for follow-up design question.

    return { success: true };
  }
}
