import { Injectable, Logger } from '@nestjs/common';
import { MatchStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS } from '../../redis/redis.constants';

@Injectable()
export class SessionExpiryService {
  private readonly logger = new Logger(SessionExpiryService.name);

  // Set by MatchingModule to avoid circular dependency on gateway
  public sessionExpiredCallback?: (sessionId: string, userAId: string, userBId: string) => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async runExpiryCheck(): Promise<void> {
    try {
      await this.expireStaleActiveSessions();
    } catch (err) {
      this.logger.error('Session expiry check error', err);
    }
  }

  /**
   * Find all ACTIVE sessions past their expiresAt with no mutual like recorded,
   * transition them to EXPIRED, clean Redis state, and notify users.
   *
   * MUTUAL_LIKE sessions are explicitly excluded — they were already resolved
   * by the mutual-like handler and should not be auto-expired here.
   */
  async expireStaleActiveSessions(): Promise<void> {
    const staleSessions = await this.prisma.matchSession.findMany({
      where: {
        status: MatchStatus.ACTIVE,
        expiresAt: { lt: new Date() },
      },
      select: { id: true, userAId: true, userBId: true },
    });

    if (staleSessions.length === 0) return;
    this.logger.log(`Expiring ${staleSessions.length} stale session(s)`);

    await Promise.allSettled(
      staleSessions.map((s) => this.expireSession(s.id, s.userAId, s.userBId)),
    );
  }

  /**
   * Expire a single session.
   * Called by expiry worker and also directly from the mutual-like resolver
   * when a session ends early (e.g. one side declines, or timer fires mid-like).
   *
   * NOTE: This does NOT create the Conversation — that belongs to Terminal A's
   * mutual-like-to-conversation flow. It only transitions status and clears Redis.
   */
  async expireSession(sessionId: string, userAId: string, userBId: string): Promise<void> {
    try {
      // Mark EXPIRED in Postgres
      const updated = await this.prisma.matchSession.updateMany({
        where: {
          id: sessionId,
          // Guard: only update if still ACTIVE — prevents double-expiry race
          status: MatchStatus.ACTIVE,
        },
        data: { status: MatchStatus.EXPIRED },
      });

      if (updated.count === 0) {
        // Another worker already expired it (or it was resolved by mutual-like)
        this.logger.debug(`Session ${sessionId} was already transitioned — skipping expiry cleanup`);
        return;
      }

      // Clear Redis state — users are now free to re-queue
      await Promise.allSettled([
        this.redis.del(REDIS_KEYS.matchSession(sessionId)),
        this.redis.del(REDIS_KEYS.userActiveSession(userAId)),
        this.redis.del(REDIS_KEYS.userActiveSession(userBId)),
      ]);

      this.logger.log(`Session ${sessionId} expired — users ${userAId} / ${userBId} released`);
      this.sessionExpiredCallback?.(sessionId, userAId, userBId);
    } catch (err) {
      this.logger.error(`Failed to expire session ${sessionId}`, err);
      // Will retry on next expiry check tick
    }
  }
}
