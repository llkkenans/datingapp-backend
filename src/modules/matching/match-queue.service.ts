import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS, TTL } from '../../redis/redis.constants';

export type MatchType = 'TEXT' | 'VOICE';

@Injectable()
export class MatchQueueService {
  constructor(private readonly redis: RedisService) {}

  async enqueueForTextMatch(userId: string): Promise<void> {
    await this.enqueue(userId, 'TEXT');
  }

  async enqueueForVoiceMatch(userId: string): Promise<void> {
    await this.enqueue(userId, 'VOICE');
  }

  private async enqueue(userId: string, type: MatchType): Promise<void> {
    const queueKey = type === 'TEXT'
      ? REDIS_KEYS.QUEUE_TEXT_WAITING
      : REDIS_KEYS.QUEUE_VOICE_WAITING;

    // Score = Unix ms → FIFO ordering within the sorted set
    await this.redis.zadd(queueKey, Date.now(), userId);
    await this.redis.set(REDIS_KEYS.userInQueue(userId), type, TTL.QUEUE_MAX_WAIT_SECONDS);
  }

  async dequeueFromQueue(userId: string, type: MatchType): Promise<void> {
    const queueKey = type === 'TEXT'
      ? REDIS_KEYS.QUEUE_TEXT_WAITING
      : REDIS_KEYS.QUEUE_VOICE_WAITING;

    await Promise.all([
      this.redis.zrem(queueKey, userId),
      this.redis.del(REDIS_KEYS.userInQueue(userId)),
    ]);
  }

  async getQueueLength(type: MatchType): Promise<number> {
    const queueKey = type === 'TEXT'
      ? REDIS_KEYS.QUEUE_TEXT_WAITING
      : REDIS_KEYS.QUEUE_VOICE_WAITING;
    return this.redis.zcard(queueKey);
  }

  /** Returns the queue type the user is currently waiting in, or null if not queued. */
  async getQueueTypeForUser(userId: string): Promise<MatchType | null> {
    const type = await this.redis.get(REDIS_KEYS.userInQueue(userId));
    return (type as MatchType) ?? null;
  }

  /** Returns the active session ID for a user, or null if not in a session. */
  async getActiveSessionId(userId: string): Promise<string | null> {
    return this.redis.get(REDIS_KEYS.userActiveSession(userId));
  }

  /** Called by the matching engine when a session is created. */
  async markUserInSession(userId: string, sessionId: string, sessionTtlSeconds: number): Promise<void> {
    await this.redis.set(
      REDIS_KEYS.userActiveSession(userId),
      sessionId,
      sessionTtlSeconds + TTL.MATCH_SESSION_BUFFER_SECONDS,
    );
  }

  /** Called when a session ends (mutual like, expire, or cancel). */
  async clearUserSession(userId: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.userActiveSession(userId));
  }
}
