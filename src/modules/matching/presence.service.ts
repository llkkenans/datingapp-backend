import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS, TTL } from '../../redis/redis.constants';

@Injectable()
export class PresenceService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Refreshes (or sets) the presence heartbeat for a user.
   * Called by the client on a ~15s interval; key expires after 30s of silence.
   */
  async setPresence(userId: string): Promise<void> {
    await this.redis.set(REDIS_KEYS.presenceUser(userId), '1', TTL.PRESENCE_SECONDS);
  }

  async isOnline(userId: string): Promise<boolean> {
    return this.redis.exists(REDIS_KEYS.presenceUser(userId));
  }

  async clearPresence(userId: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.presenceUser(userId));
  }
}
