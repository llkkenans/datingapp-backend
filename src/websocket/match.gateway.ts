import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { MatchType } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS, TTL } from '../redis/redis.constants';

// ─── Event name constants (contract shared with Terminal C / Flutter) ─────────

export const WS_EVENTS = {
  // Server → client
  MATCH_FOUND: 'match.found',
  MATCH_EXPIRED: 'match.expired',    // timer expiry OR user-initiated end (same client behaviour)
  MATCH_MUTUAL_LIKE: 'match.mutual_like',
  MATCH_PARTNER_LIKED: 'match.partner_liked',
  CONVERSATION_CREATED: 'conversation.created',
  SESSION_MESSAGE: 'session.message',          // ephemeral relay during anonymous session
  SESSION_MESSAGE_ERROR: 'session.message.error',

  // Client → server
  HEARTBEAT: 'heartbeat',
  SEND_LIKE: 'match.send_like',
  TYPING_START: 'typing.start',
  TYPING_STOP: 'typing.stop',
} as const;

const SESSION_MESSAGE_MAX_LENGTH = 2_000;

// ─── Payload shapes (Terminal C uses these to parse incoming events) ──────────

/** Fields present in every match.found event. */
export interface MatchFoundPayloadBase {
  sessionId: string;
  type: MatchType;
  expiresAt: string; // ISO 8601
}

/** Additional fields included when type === VOICE. */
export interface VoiceMatchExtras {
  roomId: string;
  zegoToken: string; // per-recipient — each user receives their own token
}

export type MatchFoundPayload = MatchFoundPayloadBase & Partial<VoiceMatchExtras>;

export interface MatchExpiredPayload {
  sessionId: string;
}

/** Client → server: send a message during an anonymous text-match session. */
export interface SessionMessageClientPayload {
  sessionId: string;
  content: string;
}

/** Server → client: relayed anonymous message (no senderId — anonymity preserved). */
export interface SessionMessageServerPayload {
  sessionId: string;
  content: string;
  sentAt: string; // ISO 8601
}

/** Server → client: error response for a rejected session.message. */
export interface SessionMessageErrorPayload {
  sessionId: string;
  reason: string;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

@WebSocketGateway({
  cors: { origin: '*' },  // tighten in production
  namespace: '/match',
})
export class MatchGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MatchGateway.name);

  @WebSocketServer()
  private server!: Server;

  // userId → socketId mapping — single-device assumption for V1
  // Multi-device support: replace with userId → Set<socketId>
  private readonly userSocketMap = new Map<string, string>();
  private readonly socketUserMap = new Map<string, string>();

  constructor(private readonly redis: RedisService) {}

  afterInit(): void {
    this.logger.log('MatchGateway initialised on namespace /match');
  }

  handleConnection(socket: Socket): void {
    // Auth is validated via JWT middleware in the full WebSocket module.
    // For now, client sends userId in handshake auth as a placeholder.
    const userId = socket.handshake.auth?.userId as string | undefined;
    if (!userId) {
      socket.disconnect(true);
      return;
    }
    this.userSocketMap.set(userId, socket.id);
    this.socketUserMap.set(socket.id, userId);
    this.logger.debug(`User ${userId} connected (socket ${socket.id})`);
  }

  handleDisconnect(socket: Socket): void {
    const userId = this.socketUserMap.get(socket.id);
    if (userId) {
      this.userSocketMap.delete(userId);
      this.socketUserMap.delete(socket.id);
      this.logger.debug(`User ${userId} disconnected`);
    }
  }

  // ─── Emit helpers (called by engine/expiry service) ───────────────────────

  emitMatchFound(
    sessionId: string,
    userAId: string,
    userBId: string,
    type: MatchType,
    expiresAt: Date,
    voice?: { roomId: string; tokenA: string; tokenB: string },
  ): void {
    const base: MatchFoundPayloadBase = {
      sessionId,
      type,
      expiresAt: expiresAt.toISOString(),
    };

    if (voice) {
      // Each user gets their own token — do NOT send the same payload to both
      this.emitToUser(userAId, WS_EVENTS.MATCH_FOUND, { ...base, roomId: voice.roomId, zegoToken: voice.tokenA });
      this.emitToUser(userBId, WS_EVENTS.MATCH_FOUND, { ...base, roomId: voice.roomId, zegoToken: voice.tokenB });
    } else {
      this.emitToUser(userAId, WS_EVENTS.MATCH_FOUND, base);
      this.emitToUser(userBId, WS_EVENTS.MATCH_FOUND, base);
    }
  }

  emitMatchExpired(sessionId: string, userAId: string, userBId: string): void {
    const payload: MatchExpiredPayload = { sessionId };
    this.emitToUser(userAId, WS_EVENTS.MATCH_EXPIRED, payload);
    this.emitToUser(userBId, WS_EVENTS.MATCH_EXPIRED, payload);
  }

  emitPartnerLiked(sessionId: string, toUserId: string): void {
    this.emitToUser(toUserId, WS_EVENTS.MATCH_PARTNER_LIKED, { sessionId });
  }

  emitMutualLike(
    sessionId: string,
    conversationId: string,
    userAId: string,
    userBId: string,
    profileA: { username: string; avatarUrl: string | null },
    profileB: { username: string; avatarUrl: string | null },
  ): void {
    const mutualPayload = { sessionId, conversationId };
    this.emitToUser(userAId, WS_EVENTS.MATCH_MUTUAL_LIKE, mutualPayload);
    this.emitToUser(userBId, WS_EVENTS.MATCH_MUTUAL_LIKE, mutualPayload);

    // Each user sees the OTHER person's profile — anonymity is lifted at this point
    this.emitToUser(userAId, WS_EVENTS.CONVERSATION_CREATED, {
      conversationId,
      withUserId: userBId,
      withUsername: profileB.username,
      withAvatarUrl: profileB.avatarUrl,
    });
    this.emitToUser(userBId, WS_EVENTS.CONVERSATION_CREATED, {
      conversationId,
      withUserId: userAId,
      withUsername: profileA.username,
      withAvatarUrl: profileA.avatarUrl,
    });
  }

  // ─── Client → server: anonymous session message relay ────────────────────

  @SubscribeMessage(WS_EVENTS.SESSION_MESSAGE)
  async handleSessionMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: SessionMessageClientPayload,
  ): Promise<void> {
    const senderId = this.socketUserMap.get(socket.id);
    if (!senderId) {
      // Socket not registered — shouldn't happen, but guard anyway
      socket.emit(WS_EVENTS.SESSION_MESSAGE_ERROR, {
        sessionId: payload?.sessionId,
        reason: 'Not authenticated',
      } satisfies SessionMessageErrorPayload);
      return;
    }

    const { sessionId, content } = payload ?? {};

    // ── Payload validation ────────────────────────────────────────────────────
    if (!sessionId || typeof sessionId !== 'string') {
      socket.emit(WS_EVENTS.SESSION_MESSAGE_ERROR, {
        sessionId: sessionId ?? null,
        reason: 'sessionId is required',
      } satisfies SessionMessageErrorPayload);
      return;
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      socket.emit(WS_EVENTS.SESSION_MESSAGE_ERROR, {
        sessionId,
        reason: 'content must be a non-empty string',
      } satisfies SessionMessageErrorPayload);
      return;
    }
    if (content.length > SESSION_MESSAGE_MAX_LENGTH) {
      socket.emit(WS_EVENTS.SESSION_MESSAGE_ERROR, {
        sessionId,
        reason: `content exceeds maximum length of ${SESSION_MESSAGE_MAX_LENGTH} characters`,
      } satisfies SessionMessageErrorPayload);
      return;
    }

    // ── Session state lookup (Redis — O(1), authoritative for active sessions) ─
    // Design choice: Redis over Postgres because match:session:{id} is written on
    // session create and deleted on session end/expiry, making it the single source
    // of truth for whether a session is currently ACTIVE. Postgres is the audit log.
    const sessionState = await this.redis.hgetall(REDIS_KEYS.matchSession(sessionId));

    if (!sessionState) {
      socket.emit(WS_EVENTS.SESSION_MESSAGE_ERROR, {
        sessionId,
        reason: 'Session not found or already ended',
      } satisfies SessionMessageErrorPayload);
      return;
    }

    // ── Participant check ─────────────────────────────────────────────────────
    const { userAId, userBId, status } = sessionState;
    const isParticipant = senderId === userAId || senderId === userBId;
    if (!isParticipant) {
      socket.emit(WS_EVENTS.SESSION_MESSAGE_ERROR, {
        sessionId,
        reason: 'You are not a participant in this session',
      } satisfies SessionMessageErrorPayload);
      return;
    }

    // ── Session status check ──────────────────────────────────────────────────
    if (status !== 'ACTIVE') {
      socket.emit(WS_EVENTS.SESSION_MESSAGE_ERROR, {
        sessionId,
        reason: `Session is not active (status: ${status})`,
      } satisfies SessionMessageErrorPayload);
      return;
    }

    // ── Relay to the other participant only — no persistence ──────────────────
    const recipientId = senderId === userAId ? userBId : userAId;
    const relayPayload: SessionMessageServerPayload = {
      sessionId,
      content: content.trim(),
      sentAt: new Date().toISOString(),
    };
    this.emitToUser(recipientId, WS_EVENTS.SESSION_MESSAGE, relayPayload);

    // Append to Redis list so messages can be migrated into the permanent
    // Conversation if a mutual like occurs. TTL mirrors the session key so
    // the list auto-expires with the session when no mutual like happens.
    const msgKey = REDIS_KEYS.sessionMessages(sessionId);
    const remainingSec = sessionState['expiresAt']
      ? Math.ceil(
          (new Date(sessionState['expiresAt']).getTime() - Date.now()) / 1_000,
        )
      : TTL.MATCH_SESSION_SECONDS.TEXT;
    await this.redis.rpush(
      msgKey,
      JSON.stringify({ senderId, content: content.trim(), sentAt: relayPayload.sentAt }),
    );
    await this.redis.expire(msgKey, Math.max(remainingSec + TTL.MATCH_SESSION_BUFFER_SECONDS, 60));

    this.logger.debug(
      `session.message relayed | session=${sessionId} | to=${recipientId}`,
    );
  }

  private emitToUser(userId: string, event: string, payload: unknown): void {
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) {
      this.logger.debug(`User ${userId} has no active socket — event ${event} dropped`);
      return;
    }
    this.server.to(socketId).emit(event, payload);
  }
}
