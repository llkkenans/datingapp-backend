import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { MatchStatus, MatchType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { MATCH_ENGINE, REDIS_KEYS, SCORE_WEIGHTS, TTL } from '../../redis/redis.constants';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CandidateProfile {
  userId: string;
  username: string;
  gender: string;
  preferredGender: string;
  city: string;
  birthDate: Date;
  qualityScore: number;
  onboardingCompleted: boolean;
  interestIds: string[];
  userStatus: string;
  userCreatedAt: Date;
}

interface ScoredCandidate {
  profile: CandidateProfile;
  score: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class MatchingEngineService implements OnModuleDestroy {
  private readonly logger = new Logger(MatchingEngineService.name);

  // Prevent overlapping ticks on slow DB systems
  private engineRunning = false;

  // Injected by MatchingModule to avoid circular dependency on gateway
  public matchFoundCallback?: (
    sessionId: string,
    userAId: string,
    userBId: string,
    type: MatchType,
    expiresAt: Date,
  ) => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleDestroy(): void {
    this.engineRunning = false;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async runMatchingCycle(): Promise<void> {
    if (this.engineRunning) {
      this.logger.debug('Previous cycle still running — skipping tick');
      return;
    }
    this.engineRunning = true;
    try {
      await Promise.all([
        this.processQueue('TEXT'),
        this.processQueue('VOICE'),
      ]);
    } catch (err) {
      this.logger.error('Matching cycle error', err);
    } finally {
      this.engineRunning = false;
    }
  }

  // ─── Core queue processor ────────────────────────────────────────────────

  private async processQueue(type: MatchType): Promise<void> {
    const queueKey = type === 'TEXT'
      ? REDIS_KEYS.QUEUE_TEXT_WAITING
      : REDIS_KEYS.QUEUE_VOICE_WAITING;

    // Pull oldest N candidates (ascending score = FIFO)
    const candidateIds = await this.redis.zrange(queueKey, 0, MATCH_ENGINE.CANDIDATES_PER_RUN - 1);
    if (candidateIds.length < 2) return;

    // ── Step 1: batch-load everything we need to avoid N+1 ──────────────────

    const { profileMap, blockPairSet, recentMatchPairSet } =
      await this.batchLoadCandidateData(candidateIds);

    // ── Step 2: greedy pairing (oldest waiting user gets priority) ───────────

    const pairedThisRun = new Set<string>();

    for (let i = 0; i < candidateIds.length; i++) {
      const userAId = candidateIds[i];
      if (pairedThisRun.has(userAId)) continue;

      const profileA = profileMap.get(userAId);
      if (!this.isEligibleCandidate(profileA)) {
        // Stale or incomplete — clean up queue membership silently
        await this.evictStaleCandidate(userAId, queueKey);
        continue;
      }

      // ── Step 3: find best compatible partner ──────────────────────────────
      const best = await this.findBestPartner(
        userAId, profileA!, candidateIds.slice(i + 1),
        profileMap, blockPairSet, recentMatchPairSet, pairedThisRun,
      );
      if (!best) continue;

      const userBId = best.profile.userId;

      // ── Step 4: atomic claim via distributed lock ─────────────────────────
      // Acquire in lexicographic UUID order → no deadlock across instances
      const locked = await this.acquireLocks(userAId, userBId);
      if (!locked) {
        this.logger.debug(`Lock contention for pair ${userAId} / ${userBId} — skipping`);
        continue;
      }

      try {
        // Re-verify active session after acquiring lock
        // (the profile batch was a snapshot; state may have changed)
        const [aSession, bSession] = await Promise.all([
          this.redis.get(REDIS_KEYS.userActiveSession(userAId)),
          this.redis.get(REDIS_KEYS.userActiveSession(userBId)),
        ]);
        if (aSession || bSession) {
          this.logger.debug(`One or both users entered a session between scan and lock — abort pair`);
          continue;
        }

        await this.createSession(userAId, userBId, type, queueKey, profileA!, best.profile);
        pairedThisRun.add(userAId);
        pairedThisRun.add(userBId);
      } finally {
        await this.releaseLocks(userAId, userBId);
      }
    }
  }

  // ─── Partner selection ───────────────────────────────────────────────────

  private async findBestPartner(
    userAId: string,
    profileA: CandidateProfile,
    remainingIds: string[],
    profileMap: Map<string, CandidateProfile>,
    blockPairSet: Set<string>,
    recentMatchPairSet: Set<string>,
    pairedThisRun: Set<string>,
  ): Promise<ScoredCandidate | null> {
    let best: ScoredCandidate | null = null;

    for (const userBId of remainingIds) {
      if (pairedThisRun.has(userBId)) continue;

      const profileB = profileMap.get(userBId);
      if (!this.isEligibleCandidate(profileB)) continue;

      // ── Hard exclusions ──────────────────────────────────────────────────
      if (!this.isGenderCompatible(profileA, profileB!)) continue;
      if (blockPairSet.has(`${userAId}:${userBId}`) || blockPairSet.has(`${userBId}:${userAId}`)) continue;
      if (recentMatchPairSet.has(`${userAId}:${userBId}`)) continue;

      // ── Soft scoring ─────────────────────────────────────────────────────
      const score = this.computeScore(profileA, profileB!);
      if (best === null || score > best.score) {
        best = { profile: profileB!, score };
      }
    }

    return best;
  }

  // ─── Session creation (the critical path) ───────────────────────────────

  private async createSession(
    userAId: string,
    userBId: string,
    type: MatchType,
    queueKey: string,
    profileA: CandidateProfile,
    profileB: CandidateProfile,
  ): Promise<void> {
    const sessionDurationSec = TTL.MATCH_SESSION_SECONDS[type];
    const expiresAt = new Date(Date.now() + sessionDurationSec * 1_000);
    let session: { id: string; startedAt: Date; expiresAt: Date } | null = null;

    // ── Phase 1: Postgres write (guarded transaction) ────────────────────────
    try {
      session = await this.prisma.$transaction(async (tx) => {
        // Conflict guard: reject if either user already has an ACTIVE or PENDING session
        const conflict = await tx.matchSession.findFirst({
          where: {
            status: { in: [MatchStatus.ACTIVE, MatchStatus.PENDING] },
            OR: [
              { userAId }, { userBId: userAId },
              { userAId: userBId }, { userBId },
            ],
          },
          select: { id: true },
        });
        if (conflict) {
          throw new ConflictError(`Session conflict detected for users ${userAId} / ${userBId}`);
        }

        return tx.matchSession.create({
          data: { userAId, userBId, type, status: MatchStatus.ACTIVE, expiresAt },
          select: { id: true, startedAt: true, expiresAt: true },
        });
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        this.logger.debug(err.message);
      } else {
        this.logger.error('Postgres session create failed', err);
      }
      // Both users remain in queue — clean state, no Redis touched
      return;
    }

    // ── Phase 2: Redis state (after Postgres commit) ─────────────────────────
    // If this block fails → we rollback the Postgres row to restore clean state.
    const sessionTtl = sessionDurationSec + TTL.MATCH_SESSION_BUFFER_SECONDS;
    try {
      await this.redis.hset(REDIS_KEYS.matchSession(session.id), {
        userAId,
        userBId,
        type,
        status: MatchStatus.ACTIVE,
        startedAt: session.startedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        likeA: '0',
        likeB: '0',
      });
      await this.redis.expire(REDIS_KEYS.matchSession(session.id), sessionTtl);

      await Promise.all([
        this.redis.set(REDIS_KEYS.userActiveSession(userAId), session.id, sessionTtl),
        this.redis.set(REDIS_KEYS.userActiveSession(userBId), session.id, sessionTtl),
      ]);

      // Remove from sorted-set queue + in-queue membership keys
      await Promise.all([
        this.redis.zrem(queueKey, userAId),
        this.redis.zrem(queueKey, userBId),
        this.redis.del(REDIS_KEYS.userInQueue(userAId)),
        this.redis.del(REDIS_KEYS.userInQueue(userBId)),
      ]);
    } catch (redisErr) {
      // ── PARTIAL FAILURE: Postgres committed but Redis write failed ──────────
      // Recovery: delete the Postgres row so both users remain queueable.
      // The Redis state is incomplete — do not leave it; just drop everything.
      this.logger.error(
        `Redis write failed after Postgres commit for session ${session.id} — rolling back`,
        redisErr,
      );
      try {
        await this.prisma.matchSession.delete({ where: { id: session.id } });
        // Best-effort cleanup of any partial Redis writes
        await Promise.allSettled([
          this.redis.del(REDIS_KEYS.matchSession(session.id)),
          this.redis.del(REDIS_KEYS.userActiveSession(userAId)),
          this.redis.del(REDIS_KEYS.userActiveSession(userBId)),
        ]);
      } catch (rollbackErr) {
        // If the rollback itself fails we have a stuck session in Postgres.
        // The expiry worker will clean it up once expiresAt passes.
        this.logger.error(
          `Rollback also failed for session ${session.id} — expiry worker will resolve`,
          rollbackErr,
        );
      }
      return;
    }

    // ── Phase 3: Notify both users ────────────────────────────────────────────
    this.logger.log(`Matched ${userAId} ↔ ${userBId} | session ${session.id} | type ${type}`);
    this.matchFoundCallback?.(session.id, userAId, userBId, type, session.expiresAt);
  }

  // ─── Startup orphan recovery ─────────────────────────────────────────────

  /**
   * On engine start (and optionally on each run) find ACTIVE Postgres sessions
   * that have no corresponding Redis state, indicating a partial-failure crash.
   * Re-hydrate them if still within the session window; expire them if past expiresAt.
   */
  async recoverOrphanedSessions(): Promise<void> {
    const activeSessions = await this.prisma.matchSession.findMany({
      where: { status: MatchStatus.ACTIVE },
      select: { id: true, userAId: true, userBId: true, type: true, startedAt: true, expiresAt: true },
    });

    for (const s of activeSessions) {
      const hasRedis = await this.redis.exists(REDIS_KEYS.matchSession(s.id));
      if (hasRedis) continue;

      const now = new Date();
      if (s.expiresAt <= now) {
        // Past expiry — mark EXPIRED in Postgres, no Redis needed
        await this.prisma.matchSession.update({
          where: { id: s.id },
          data: { status: MatchStatus.EXPIRED },
        }).catch((e) => this.logger.error(`Orphan expiry update failed ${s.id}`, e));
        this.logger.warn(`Orphaned session ${s.id} past expiry — marked EXPIRED`);
      } else {
        // Still within window — re-hydrate Redis
        const remainingSec = Math.ceil((s.expiresAt.getTime() - now.getTime()) / 1_000);
        const bufSec = remainingSec + TTL.MATCH_SESSION_BUFFER_SECONDS;
        await Promise.allSettled([
          this.redis.hset(REDIS_KEYS.matchSession(s.id), {
            userAId: s.userAId, userBId: s.userBId,
            type: s.type, status: MatchStatus.ACTIVE,
            startedAt: s.startedAt.toISOString(),
            expiresAt: s.expiresAt.toISOString(),
            likeA: '0', likeB: '0',
          }),
          this.redis.expire(REDIS_KEYS.matchSession(s.id), bufSec),
          this.redis.set(REDIS_KEYS.userActiveSession(s.userAId), s.id, bufSec),
          this.redis.set(REDIS_KEYS.userActiveSession(s.userBId), s.id, bufSec),
        ]);
        this.logger.warn(`Re-hydrated orphaned session ${s.id} (${remainingSec}s remaining)`);
      }
    }
  }

  // ─── Lock helpers ────────────────────────────────────────────────────────

  private async acquireLocks(userA: string, userB: string): Promise<boolean> {
    const [first, second] = [userA, userB].sort(); // lexicographic order prevents deadlock
    const gotFirst = await this.redis.setnx(REDIS_KEYS.matchLock(first), '1', TTL.MATCH_LOCK_SECONDS);
    if (!gotFirst) return false;
    const gotSecond = await this.redis.setnx(REDIS_KEYS.matchLock(second), '1', TTL.MATCH_LOCK_SECONDS);
    if (!gotSecond) {
      await this.redis.del(REDIS_KEYS.matchLock(first));
      return false;
    }
    return true;
  }

  private async releaseLocks(userA: string, userB: string): Promise<void> {
    await Promise.allSettled([
      this.redis.del(REDIS_KEYS.matchLock(userA)),
      this.redis.del(REDIS_KEYS.matchLock(userB)),
    ]);
  }

  // ─── Batch data loading ──────────────────────────────────────────────────

  private async batchLoadCandidateData(candidateIds: string[]): Promise<{
    profileMap: Map<string, CandidateProfile>;
    blockPairSet: Set<string>;
    recentMatchPairSet: Set<string>;
  }> {
    const [profiles, blocks, recentMatches] = await Promise.all([
      this.prisma.profile.findMany({
        where: { userId: { in: candidateIds } },
        include: { user: { select: { status: true, createdAt: true } }, interests: { select: { interestId: true } } },
      }),
      this.prisma.block.findMany({
        where: {
          OR: [
            { blockerId: { in: candidateIds } },
            { blockedId: { in: candidateIds } },
          ],
        },
        select: { blockerId: true, blockedId: true },
      }),
      this.prisma.matchSession.findMany({
        where: {
          OR: [
            { userAId: { in: candidateIds } },
            { userBId: { in: candidateIds } },
          ],
          startedAt: { gt: new Date(Date.now() - MATCH_ENGINE.REPEAT_MATCH_COOLDOWN_MS) },
          status: { in: [MatchStatus.ACTIVE, MatchStatus.MUTUAL_LIKE, MatchStatus.ENDED] },
        },
        select: { userAId: true, userBId: true },
      }),
    ]);

    const profileMap = new Map<string, CandidateProfile>();
    for (const p of profiles) {
      profileMap.set(p.userId, {
        userId: p.userId,
        username: p.username,
        gender: p.gender,
        preferredGender: p.preferredGender,
        city: p.city,
        birthDate: p.birthDate,
        qualityScore: p.qualityScore,
        onboardingCompleted: p.onboardingCompleted,
        interestIds: p.interests.map((i) => i.interestId),
        userStatus: p.user.status,
        userCreatedAt: p.user.createdAt,
      });
    }

    const blockPairSet = new Set<string>(
      blocks.flatMap((b) => [`${b.blockerId}:${b.blockedId}`, `${b.blockedId}:${b.blockerId}`]),
    );

    const recentMatchPairSet = new Set<string>(
      recentMatches.flatMap((m) => [`${m.userAId}:${m.userBId}`, `${m.userBId}:${m.userAId}`]),
    );

    return { profileMap, blockPairSet, recentMatchPairSet };
  }

  // ─── Eligibility guard ───────────────────────────────────────────────────

  private isEligibleCandidate(profile: CandidateProfile | undefined): profile is CandidateProfile {
    if (!profile) return false;
    if (!profile.onboardingCompleted) return false;
    if (profile.userStatus !== 'ACTIVE') return false;
    return true;
  }

  private async evictStaleCandidate(userId: string, queueKey: string): Promise<void> {
    await Promise.allSettled([
      this.redis.zrem(queueKey, userId),
      this.redis.del(REDIS_KEYS.userInQueue(userId)),
    ]);
  }

  // ─── Scoring ─────────────────────────────────────────────────────────────

  private isGenderCompatible(a: CandidateProfile, b: CandidateProfile): boolean {
    const aPrefMatchesB = a.preferredGender === 'ANY' || a.preferredGender === b.gender;
    const bPrefMatchesA = b.preferredGender === 'ANY' || b.preferredGender === a.gender;
    return aPrefMatchesB && bPrefMatchesA;
  }

  private computeScore(a: CandidateProfile, b: CandidateProfile): number {
    let score = 0;

    if (a.city === b.city) {
      score += SCORE_WEIGHTS.SAME_CITY;
    }

    const jaccard = this.jaccardSimilarity(a.interestIds, b.interestIds);
    score += jaccard * SCORE_WEIGHTS.INTEREST_OVERLAP;

    const ageA = this.getAgeYears(a.birthDate);
    const ageB = this.getAgeYears(b.birthDate);
    if (Math.abs(ageA - ageB) <= 10) {
      score += SCORE_WEIGHTS.AGE_PROXIMITY;
    }

    const avgQuality = (a.qualityScore + b.qualityScore) / 2;
    score += avgQuality * SCORE_WEIGHTS.QUALITY_SCORE;

    const thresholdMs = MATCH_ENGINE.NEW_USER_THRESHOLD_DAYS * 24 * 60 * 60 * 1_000;
    if (
      Date.now() - a.userCreatedAt.getTime() < thresholdMs ||
      Date.now() - b.userCreatedAt.getTime() < thresholdMs
    ) {
      score += SCORE_WEIGHTS.NEW_USER_BOOST;
    }

    return score;
  }

  private jaccardSimilarity(setA: string[], setB: string[]): number {
    if (setA.length === 0 && setB.length === 0) return 0;
    const a = new Set(setA);
    const b = new Set(setB);
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private getAgeYears(birthDate: Date): number {
    const now = new Date();
    let age = now.getFullYear() - birthDate.getFullYear();
    const monthDiff = now.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  }
}

// Sentinel error to distinguish conflict from unexpected errors
class ConflictError extends Error {}
