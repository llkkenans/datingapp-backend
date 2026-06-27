import { Module, OnModuleInit } from '@nestjs/common';
import { MatchType } from '@prisma/client';
import { PrismaModule } from '../../prisma/prisma.module';
import { WebsocketModule } from '../../websocket/websocket.module';
import { MatchGateway } from '../../websocket/match.gateway';
import { ZegoModule } from '../../zego/zego.module';
import { ZegoTokenService } from '../../zego/zego-token.service';
import { MatchQueueService } from './match-queue.service';
import { PresenceService } from './presence.service';
import { MatchingEngineService } from './matching-engine.service';
import { MatchingSchedulerService } from './matching-scheduler.service';
import { SessionExpiryService } from './session-expiry.service';

@Module({
  imports: [
    PrismaModule,
    WebsocketModule,
    ZegoModule,
  ],
  providers: [
    MatchQueueService,
    PresenceService,
    MatchingEngineService,
    SessionExpiryService,
    MatchingSchedulerService,
  ],
  exports: [
    MatchQueueService,
    PresenceService,
    MatchingEngineService,
    SessionExpiryService,
  ],
})
export class MatchingModule implements OnModuleInit {
  constructor(
    private readonly engine: MatchingEngineService,
    private readonly expiry: SessionExpiryService,
    private readonly gateway: MatchGateway,
    private readonly zegoToken: ZegoTokenService,
  ) {}

  /**
   * Wire gateway callbacks after all providers are instantiated.
   * The engine and expiry service never import the gateway or zego — this module
   * is the only place that knows about both sides, keeping the dependency graph acyclic.
   */
  onModuleInit(): void {
    this.engine.matchFoundCallback = (sessionId, userAId, userBId, type, expiresAt) => {
      // Voice matches include per-user ZEGOCLOUD tokens in the match.found payload.
      // Text matches get no voice data — the distinction is purely in the payload,
      // not in the matching algorithm itself.
      const voice = type === MatchType.VOICE
        ? this.zegoToken.generatePairTokens(userAId, userBId, sessionId)
        : undefined;

      this.gateway.emitMatchFound(sessionId, userAId, userBId, type, expiresAt, voice);
    };

    this.expiry.sessionExpiredCallback = (sessionId, userAId, userBId) => {
      this.gateway.emitMatchExpired(sessionId, userAId, userBId);
    };
  }
}
