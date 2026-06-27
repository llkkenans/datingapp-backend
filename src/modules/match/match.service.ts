import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MatchStatus, MatchType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS } from '../../redis/redis.constants';
import { MatchQueueService } from '../matching/match-queue.service';
import { MatchGateway } from '../../websocket/match.gateway';
import { ZegoTokenService } from '../../zego/zego-token.service';
import { deriveRoomId } from '../../zego/token04';

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface QueuedResponse {
  queued: true;
  type: 'TEXT' | 'VOICE';
}

export interface SessionView {
  sessionId: string;
  type: string;
  status: string;
  expiresAt: string;
  myRole: 'A' | 'B';
  myLabel: string;
  partnerLabel: string;
  iLiked: boolean;
  partnerLiked: boolean;
}

export interface LikeResponse {
  mutualLike: boolean;
  conversationId?: string;
}

export interface EndSessionResponse {
  sessionId: string;
  status: 'ended';
}

export interface RtcTokenResponse {
  sessionId: string;
  roomId: string;
  zegoToken: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class MatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queue: MatchQueueService,
    private readonly gateway: MatchGateway,
    private readonly zegoToken: ZegoTokenService,
  ) {}

  // ─── Queue entry ────────────────────────────────────────────────────────────

  async enqueue(userId: string, type: 'TEXT' | 'VOICE'): Promise<QueuedResponse> {
    const [currentQueueType, activeSessionId] = await Promise.all([
      this.queue.getQueueTypeForUser(userId),
      this.queue.getActiveSessionId(userId),
    ]);

    if (activeSessionId) {
      throw new ConflictException('You are already in an active match session');
    }
    if (currentQueueType) {
      throw new ConflictException(`You are already waiting in the ${currentQueueType} match queue`);
    }

    if (type === 'TEXT') {
      await this.queue.enqueueForTextMatch(userId);
    } else {
      await this.queue.enqueueForVoiceMatch(userId);
    }

    return { queued: true, type };
  }

  // ─── Queue exit ─────────────────────────────────────────────────────────────

  async leaveQueue(userId: string, type: 'TEXT' | 'VOICE'): Promise<void> {
    const currentQueueType = await this.queue.getQueueTypeForUser(userId);
    // No-op if not in a queue (or in a different queue — don't cross-remove)
    if (!currentQueueType || currentQueueType !== type) return;
    await this.queue.dequeueFromQueue(userId, type);
  }

  // ─── Session view (anonymous) ────────────────────────────────────────────────

  async getSession(sessionId: string, requestingUserId: string): Promise<SessionView> {
    const session = await this.prisma.matchSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        type: true,
        status: true,
        expiresAt: true,
        userAId: true,
        userBId: true,
        userALiked: true,
        userBLiked: true,
      },
    });

    if (!session) throw new NotFoundException('Match session not found');

    const myRole = this.resolveRole(session, requestingUserId);

    return {
      sessionId: session.id,
      type: session.type,
      status: session.status,
      expiresAt: session.expiresAt.toISOString(),
      myRole,
      myLabel: 'You',
      partnerLabel: 'Stranger',
      iLiked: myRole === 'A' ? session.userALiked : session.userBLiked,
      // Do NOT reveal whether the partner liked — only expose once mutual like resolves
      partnerLiked: false,
    };
  }

  // ─── Like ───────────────────────────────────────────────────────────────────

  async recordLike(sessionId: string, requestingUserId: string): Promise<LikeResponse> {
    return this.prisma.$transaction(async (tx) => {
      // Row-lock the session before reading it. This serializes concurrent
      // transactions on the same session (e.g. same user double-tapping like,
      // or both participants liking at exactly the same time), so the
      // iAlreadyLiked guard and the mutual-like check are always consistent.
      await tx.$queryRaw`SELECT id FROM "MatchSession" WHERE id = ${sessionId} FOR UPDATE`;

      const session = await tx.matchSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          userAId: true,
          userBId: true,
          status: true,
          expiresAt: true,
          userALiked: true,
          userBLiked: true,
        },
      });

      if (!session) throw new NotFoundException('Match session not found');

      const myRole = this.resolveRole(session, requestingUserId);

      // Check wall-clock expiry first — the background worker may not have
      // flipped the status field yet, so expiresAt is the authoritative source.
      if (session.expiresAt < new Date()) {
        throw new GoneException('This match session has expired');
      }

      if (session.status !== MatchStatus.ACTIVE) {
        throw new GoneException(
          `Session is no longer active (status: ${session.status})`,
        );
      }

      const iAlreadyLiked = myRole === 'A' ? session.userALiked : session.userBLiked;
      if (iAlreadyLiked) {
        throw new ConflictException('You have already liked this session');
      }

      // Record this user's like and re-read both fields in one update
      const updated = await tx.matchSession.update({
        where: { id: sessionId },
        data: myRole === 'A' ? { userALiked: true } : { userBLiked: true },
        select: { userALiked: true, userBLiked: true },
      });

      const partnerAlsoLiked = myRole === 'A' ? updated.userBLiked : updated.userALiked;

      if (!partnerAlsoLiked) {
        // First like — notify partner that the other side liked
        const partnerId = myRole === 'A' ? session.userBId : session.userAId;
        this.gateway.emitPartnerLiked(sessionId, partnerId);
        return { mutualLike: false };
      }

      // ── Mutual like ──────────────────────────────────────────────────────────
      // Transition session → MUTUAL_LIKE and create permanent conversation
      await tx.matchSession.update({
        where: { id: sessionId },
        data: { status: MatchStatus.MUTUAL_LIKE },
      });

      const [conversation, profileA, profileB] = await Promise.all([
        tx.conversation.create({
          data: {
            userAId: session.userAId,
            userBId: session.userBId,
            originMatchSessionId: sessionId,
          },
          select: { id: true },
        }),
        tx.profile.findUnique({
          where: { userId: session.userAId },
          select: { username: true, avatarUrl: true },
        }),
        tx.profile.findUnique({
          where: { userId: session.userBId },
          select: { username: true, avatarUrl: true },
        }),
      ]);

      // Clear Redis active-session markers so both users can re-queue
      await Promise.allSettled([
        this.redis.del(REDIS_KEYS.matchSession(sessionId)),
        this.redis.del(REDIS_KEYS.userActiveSession(session.userAId)),
        this.redis.del(REDIS_KEYS.userActiveSession(session.userBId)),
      ]);

      this.gateway.emitMutualLike(
        sessionId,
        conversation.id,
        session.userAId,
        session.userBId,
        { username: profileA?.username ?? '', avatarUrl: profileA?.avatarUrl ?? null },
        { username: profileB?.username ?? '', avatarUrl: profileB?.avatarUrl ?? null },
      );

      return { mutualLike: true, conversationId: conversation.id };
    });
  }

  // ─── End session (user-initiated) ───────────────────────────────────────────

  async endSession(sessionId: string, requestingUserId: string): Promise<EndSessionResponse> {
    const session = await this.prisma.matchSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userAId: true, userBId: true, status: true, expiresAt: true },
    });

    if (!session) throw new NotFoundException('Match session not found');

    this.resolveRole(session, requestingUserId); // throws 403 if not a participant

    // Check wall-clock expiry first — the background worker may not have
    // flipped the status field yet, so expiresAt is the authoritative source.
    if (session.expiresAt < new Date()) {
      throw new GoneException('This match session has expired');
    }

    // Idempotent — already resolved sessions return success without side-effects
    if (session.status !== MatchStatus.ACTIVE) {
      return { sessionId, status: 'ended' };
    }

    await this.prisma.matchSession.update({
      where: { id: sessionId },
      data: { status: MatchStatus.ENDED },
    });

    await Promise.allSettled([
      this.redis.del(REDIS_KEYS.matchSession(sessionId)),
      this.redis.del(REDIS_KEYS.userActiveSession(session.userAId)),
      this.redis.del(REDIS_KEYS.userActiveSession(session.userBId)),
    ]);

    // Reuse MATCH_EXPIRED — client behaviour (show rating screen, close chat) is identical
    this.gateway.emitMatchExpired(sessionId, session.userAId, session.userBId);

    return { sessionId, status: 'ended' };
  }

  // ─── RTC token (reconnect) ────────────────────────────────────────────────────

  /**
   * Issues a fresh ZEGOCLOUD token for the requesting user on the voice match room.
   * Only callable by a session participant. Only valid for VOICE sessions.
   *
   * Use case: app backgrounded, network drop, or token close to expiry.
   * The client calls this to rejoin the ZEGOCLOUD room without re-matching.
   */
  async getRtcToken(sessionId: string, requestingUserId: string): Promise<RtcTokenResponse> {
    const session = await this.prisma.matchSession.findUnique({
      where: { id: sessionId },
      select: { id: true, type: true, status: true, userAId: true, userBId: true },
    });

    if (!session) throw new NotFoundException('Match session not found');

    this.resolveRole(session, requestingUserId); // throws 403 if not a participant

    if (session.type !== MatchType.VOICE) {
      throw new BadRequestException('RTC tokens are only available for voice match sessions');
    }

    if (session.status !== MatchStatus.ACTIVE && session.status !== MatchStatus.MUTUAL_LIKE) {
      throw new GoneException(`Session is not active (status: ${session.status})`);
    }

    const roomId = deriveRoomId(sessionId);
    const zegoToken = this.zegoToken.generateToken(requestingUserId, sessionId);

    return { sessionId, roomId, zegoToken };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private resolveRole(
    session: { userAId: string; userBId: string },
    userId: string,
  ): 'A' | 'B' {
    if (session.userAId === userId) return 'A';
    if (session.userBId === userId) return 'B';
    throw new ForbiddenException('You are not a participant in this session');
  }
}
