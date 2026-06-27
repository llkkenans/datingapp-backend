export const REDIS_KEYS = {
  // Sorted sets — score = Unix ms timestamp (joined), member = userId
  QUEUE_TEXT_WAITING: 'queue:text:waiting',
  QUEUE_VOICE_WAITING: 'queue:voice:waiting',

  // String — value = MatchType ('TEXT'|'VOICE'), TTL = QUEUE_MAX_WAIT_TTL
  userInQueue: (userId: string) => `queue:user:${userId}:in_queue`,

  // Hash — fields: userAId, userBId, type, status, startedAt, expiresAt
  matchSession: (sessionId: string) => `match:session:${sessionId}`,

  // String — value = sessionId, TTL mirrors session expiry
  userActiveSession: (userId: string) => `match:user:${userId}:active_session`,

  // String — value = '1', TTL = PRESENCE_TTL (refreshed by heartbeat)
  presenceUser: (userId: string) => `presence:user:${userId}`,

  // String — value = userId (next candidate), used by matcher worker
  matchLock: (userId: string) => `match:lock:${userId}`,
} as const;

export const TTL = {
  PRESENCE_SECONDS: 30,
  QUEUE_MAX_WAIT_SECONDS: 300,       // 5 minutes
  MATCH_SESSION_BUFFER_SECONDS: 30,  // extra TTL beyond session expiresAt
  MATCH_LOCK_SECONDS: 15,            // must outlast Postgres write + Redis write
  MATCH_SESSION_SECONDS: {
    TEXT:  180,  // 3 minutes
    VOICE: 300,  // 5 minutes
  },
} as const;

export const MATCH_ENGINE = {
  CANDIDATES_PER_RUN: 50,            // max users pulled from each queue per tick
  ENGINE_INTERVAL_MS: 3_000,         // how often the engine ticks
  EXPIRY_INTERVAL_MS: 30_000,        // how often the expiry worker ticks
  REPEAT_MATCH_COOLDOWN_MS: 24 * 60 * 60 * 1_000,  // 24h before same pair can re-match
  NEW_USER_THRESHOLD_DAYS: 7,        // accounts younger than this get a boost
} as const;

// Scoring weights — all tunable, document any changes in docs/DECISIONS.md
export const SCORE_WEIGHTS = {
  SAME_CITY: 30,
  INTEREST_OVERLAP: 20,   // multiplied by Jaccard similarity (0-1)
  AGE_PROXIMITY: 15,      // awarded if age difference ≤ 10 years
  QUALITY_SCORE: 4,       // multiplied by avg qualityScore (0-5 scale)
  NEW_USER_BOOST: 10,
} as const;
