# Decisions

To be filled in — records all architectural and product decisions with rationale, alternatives considered, and date of decision.

## Decision Log

| Date | Decision | Rationale | Alternatives |
|------|----------|-----------|--------------|
| 2026-06-25 | Use Prisma ORM with PostgreSQL | Type safety, schema-first migrations, strong ecosystem | Drizzle, TypeORM |
| 2026-06-25 | Use standard prisma-client-js generator | Compatibility with NestJS ecosystem | Prisma v7 prisma-client generator |
| 2026-06-25 | Use SUPABASE_JWT_SECRET (not a custom JWT secret) to verify user tokens | Supabase Auth signs all user tokens with the project JWT secret. NestJS must verify against the same secret to trust the token. Found in: Supabase Dashboard → Settings → API → JWT Settings → JWT Secret. This is different from any internally-generated JWT_SECRET. | Verify tokens via Supabase Admin SDK on every request (too slow — network round trip per request) |
| 2026-06-25 | NestJS does not implement login/register endpoints | Supabase Auth handles all credential flows (OAuth, magic link, password, phone OTP) client-side. NestJS only verifies the resulting JWT and syncs the user into our own User table on first auth. | Build custom auth in NestJS (duplicates Supabase's work, adds attack surface) |
| 2026-06-25 | User.id == Supabase Auth UID | Supabase user UUID is used directly as our Prisma User.id. This eliminates a join/lookup layer and keeps the two systems in sync without a separate mapping table. | Store Supabase UID as a separate supabaseId column on User |
| 2026-06-25 | GET /interests is public (no auth required) | Interest list is static, non-sensitive data. Making it public lets the Flutter UI fetch it before login (e.g., during onboarding preview screens) without a JWT. | Require auth — adds friction for no security benefit |
| 2026-06-25 | InterestIds are part of the same POST /onboarding/complete DTO | Combining profile fields and interest selection into a single atomic request simplifies client logic: one round trip, one transaction. The trade-off is a larger DTO; this is acceptable for onboarding. | Separate endpoint POST /profiles/me/interests after profile creation |
| 2026-06-25 | Interest list is a placeholder (20 hardcoded names in seed.ts) | The initial list ("Music", "Travel", "Fitness"… etc.) covers common use cases for MVP. The list may be revised, expanded, or localised based on user research before or after launch. | Build an admin UI for interest management (deferred to later phase) |
| 2026-06-27 | qualityScore update after rating submission: DEFERRED — decision needed | After a Rating row is written, Profile.qualityScore should eventually reflect the accumulated signal. Implementation was deferred because the right aggregation strategy is non-trivial: a simple rolling average gives too much weight to users with few ratings (a single 1-star tanks a new user); a Bayesian average (prior mean + weighted ratings) is more robust but needs a calibrated prior mean and a weight parameter. Decision needed: simple rolling average, Bayesian average with a global prior, or something else? Until decided, qualityScore stays at its default (0) for all users. | Update qualityScore inline at rating submission time using a rolling average (risks gaming by new users with 1 early rating) |

---

## D-022 — Request-time expiresAt validation as source of truth for session liveness

**Date:** 2026-06-28
**Affected endpoints:** `POST /match/sessions/:id/like`, `POST /match/sessions/:id/end`
**Files:** `src/modules/match/match.service.ts`

### Race condition found

During live 2-user testing, the `POST /match/sessions/:id/like` endpoint accepted a like — and could trigger a mutual like — even after the session's `expiresAt` timestamp had already passed. The same window existed on the end endpoint.

### Root cause

Session expiry is enforced by a background worker (`session-expiry.service.ts`) that polls on a ~30-second tick interval. Between the moment `expiresAt` passes and the moment the worker updates the `status` column to `EXPIRED`, the DB record still reads `status = ACTIVE`. Any request arriving in that window passed the status check and was processed as valid.

### Fix

Added an explicit wall-clock check at the top of both `recordLike` and `endSession` (before the `status` field check):

```typescript
if (session.expiresAt < new Date()) {
  throw new GoneException('This match session has expired');
}
```

`expiresAt` is the authoritative, immutable timestamp written at session creation. It does not depend on the worker tick. This check eliminates the race window entirely, regardless of how long the worker tick interval is or how delayed the worker is.

The status-field check is kept beneath it to handle already-terminal sessions (EXPIRED, ENDED, MUTUAL_LIKE set by a concurrent transaction).

### Alternatives considered

- Shrink the worker tick interval (reduces the window but does not eliminate it; still a race)
- Use a DB-level trigger to auto-update status on expiry (adds infra complexity, same logical race on read)
- Request-time check (chosen): zero race window, no infra change, single line of logic
