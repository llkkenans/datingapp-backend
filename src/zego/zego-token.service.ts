import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { deriveRoomId, generateToken04 } from './token04';

export const DEFAULT_TOKEN_LIFETIME_SECONDS = 7_200; // 2 hours

export interface VoiceTokenBundle {
  roomId: string;
  tokenA: string;  // token scoped to userAId
  tokenB: string;  // token scoped to userBId
}

@Injectable()
export class ZegoTokenService {
  private readonly appId: number;
  private readonly serverSecret: string;

  constructor(config: ConfigService) {
    const rawAppId = config.get<string>('ZEGO_APP_ID');
    const secret = config.get<string>('ZEGO_SERVER_SECRET');

    if (!rawAppId || !secret) {
      throw new Error('ZEGO_APP_ID and ZEGO_SERVER_SECRET must be set in .env');
    }

    this.appId = parseInt(rawAppId, 10);
    this.serverSecret = secret;
  }

  /**
   * Generates a ZEGOCLOUD Token04 for the given user and room.
   *
   * The token payload is cryptographically bound to room_id by ZEGOCLOUD itself
   * (privilege 1 = login, privilege 2 = publish, both enabled). This means the
   * token is only accepted by ZEGOCLOUD for exactly this room, even if the raw
   * token were leaked. The existing REST-layer participant check (only session
   * participants receive tokens) is kept as a defence-in-depth layer.
   */
  generateToken(
    userId: string,
    sessionId: string,
    effectiveSeconds = DEFAULT_TOKEN_LIFETIME_SECONDS,
  ): string {
    const roomId = deriveRoomId(sessionId);
    const privilegePayload = JSON.stringify({
      room_id: roomId,
      privilege: { 1: 1, 2: 1 },
    });
    return generateToken04(this.appId, userId, this.serverSecret, effectiveSeconds, privilegePayload);
  }

  /** Generates tokens for both participants in one call — used by the matching engine. */
  generatePairTokens(userAId: string, userBId: string, sessionId: string): VoiceTokenBundle {
    return {
      roomId: deriveRoomId(sessionId),
      tokenA: this.generateToken(userAId, sessionId),
      tokenB: this.generateToken(userBId, sessionId),
    };
  }
}
