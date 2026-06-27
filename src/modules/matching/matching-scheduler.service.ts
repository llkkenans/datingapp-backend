import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MATCH_ENGINE } from '../../redis/redis.constants';
import { MatchingEngineService } from './matching-engine.service';
import { SessionExpiryService } from './session-expiry.service';

@Injectable()
export class MatchingSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(MatchingSchedulerService.name);

  constructor(
    private readonly engine: MatchingEngineService,
    private readonly expiry: SessionExpiryService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Run orphan recovery once at startup before the engine ticks begin
    this.logger.log('Running orphaned-session recovery on startup');
    await this.engine.recoverOrphanedSessions().catch((e) =>
      this.logger.error('Startup orphan recovery failed', e),
    );
  }

  @Interval(MATCH_ENGINE.ENGINE_INTERVAL_MS)
  async onEngineInterval(): Promise<void> {
    await this.engine.runMatchingCycle();
  }

  @Interval(MATCH_ENGINE.EXPIRY_INTERVAL_MS)
  async onExpiryInterval(): Promise<void> {
    await this.expiry.runExpiryCheck();
  }
}
