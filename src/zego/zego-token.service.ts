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
   * The token is room-scoped: it is only valid for this sessionId's room.
   *
   * Using an empty payload (no privilege restrictions in the token itself).
   * Access control is enforced at the REST layer — only session participants
   * receive tokens, so an explicit in-token room restriction is redundant for V1.
   */
  generateToken(
    userId: string,
    sessionId: string,
    effectiveSeconds = DEFAULT_TOKEN_LIFETIME_SECONDS,
  ): string {
    const roomId = deriveRoomId(sessionId);
    return generateToken04(this.appId, userId, this.serverSecret, effectiveSeconds, roomId);
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
