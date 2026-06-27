# Database Schema

All primary keys are UUID. All timestamps are UTC. Connection URL lives in `prisma.config.ts` (Prisma v7).

---

## Enums

| Enum | Values |
|------|--------|
| `AuthProvider` | `GOOGLE`, `APPLE`, `EMAIL`, `PHONE` |
| `UserStatus` | `ACTIVE`, `SUSPENDED`, `BANNED` |
| `Gender` | `MALE`, `FEMALE`, `OTHER` |
| `PreferredGender` | `MALE`, `FEMALE`, `OTHER`, `ANY` |
| `MatchType` | `TEXT`, `VOICE` |
| `MatchStatus` | `PENDING`, `ACTIVE`, `MUTUAL_LIKE`, `ENDED`, `EXPIRED` |
| `MessageStatus` | `SENT`, `DELIVERED`, `READ` |
| `ReportTargetType` | `USER`, `MESSAGE`, `POST`, `COMMENT` |

---

## Models

### User

The root authentication record. Created when a user signs up via any provider.

- `email` and `phone` are both optional and unique — a user has one or the other (or neither for social login).
- `authProvider` records how the account was created.
- `status` is used for moderation: `SUSPENDED` means temporary restriction, `BANNED` means permanent.
- Does not store profile data — that lives in `Profile`.

**Relations:**
- One-to-one with `Profile` (profile is created during onboarding).
- One-to-many with `MatchSession` (as `userA` or `userB`).
- One-to-many with `Conversation` (as `userA` or `userB`).
- One-to-many with `Message` (as sender).
- One-to-many with `DiscoverPost`, `Comment`, `Like`.
- One-to-many with `Block` (as blocker or blocked).
- One-to-many with `Report` (as reporter).
- One-to-many with `Rating` (as rater or rated).

**Indexes:** `status`, `authProvider`

---

### Profile

Stores all user-visible identity and matching attributes. Created after onboarding is completed.

- `userId` is a unique FK to `User` (one-to-one).
- `username` is unique across the platform.
- `birthDate` is used for age-range matching. Age is computed at query time.
- `preferredGender` drives matching eligibility.
- `qualityScore` is a hidden float (0–5) derived from post-match ratings. Used in the matching algorithm to boost or penalise users.
- `onboardingCompleted` gates access to the main app — if false, the user is redirected to onboarding.
- `avatarUrl` is nullable; users may choose a default avatar instead.

**Relations:**
- Belongs to `User`.
- Many-to-many with `Interest` through `UserInterest`.

**Indexes:** `city`, `gender`, `preferredGender`, `qualityScore`, `onboardingCompleted`

---

### Interest

Lookup table of interests users can choose from (e.g. "Music", "Travel", "Gaming").

- `name` is unique.
- Seeded at app launch; users do not create interests directly.

**Relations:**
- Many-to-many with `Profile` through `UserInterest`.

---

### UserInterest

Explicit join table linking a profile to its selected interests.

- Composite primary key `(userId, interestId)`.
- `userId` references `Profile.userId` (which equals `User.id`).
- Cascades on profile deletion.

**Indexes:** `interestId` (to look up all profiles with a given interest during matching)

---

### MatchSession

Represents one anonymous match attempt between two users — either text or voice.

- `userAId` and `userBId` are the two participants. Assignment order does not imply any semantic difference.
- `type` is `TEXT` or `VOICE`.
- `status` lifecycle: `PENDING` → `ACTIVE` → `MUTUAL_LIKE` or `ENDED` or `EXPIRED`.
- `expiresAt` is set by the backend (3 minutes from `startedAt`). The backend enforces this via Redis timers — this field exists for audit and recovery.
- When status reaches `MUTUAL_LIKE`, a `Conversation` is created and linked back via `originMatchSessionId`.

**Relations:**
- Belongs to two `User` records (named `MatchUserA` / `MatchUserB` to disambiguate).
- Optional one-to-one with `Conversation` (null until mutual like).
- One-to-many with `Rating` (each user rates after the session ends).

**Indexes:** `userAId`, `userBId`, `status`, `expiresAt`

---

### Conversation

A permanent messaging thread between two users.

- Can originate from a match session (`originMatchSessionId` set) or from an approved social flow (null).
- `originMatchSessionId` is `@unique` — one match session produces at most one conversation.
- `userA` / `userB` assignment mirrors the originating match session when applicable.

**Relations:**
- Belongs to two `User` records (named `ConversationUserA` / `ConversationUserB`).
- Optional belongs-to `MatchSession` via `originMatchSessionId`.
- One-to-many with `Message`.

**Indexes:** `userAId`, `userBId`, `createdAt`

---

### Message

A single message inside a conversation.

- `content` is nullable to support photo-only messages.
- `photoUrl` is nullable to support text-only messages.
- `status` tracks delivery: `SENT` → `DELIVERED` → `READ`. Updated via WebSocket events.

**Relations:**
- Belongs to `Conversation` (cascades on conversation deletion).
- Belongs to `User` as `sender`.

**Indexes:** `conversationId`, `senderId`, `status`, `createdAt`

---

### DiscoverPost

A public post in the discovery feed. Can be text, photo, or both.

- At least one of `textContent` or `photoUrl` must be non-null (enforced at the service layer, not DB level).
- Posts are soft-deletable at the service layer (no `deletedAt` in schema for Phase 1 — add if needed).

**Relations:**
- Belongs to `User` (cascades on user deletion).
- One-to-many with `Comment` and `Like`.

**Indexes:** `userId`, `createdAt`

---

### Comment

A comment on a discovery post.

- `content` is required (non-nullable text).

**Relations:**
- Belongs to `DiscoverPost` (cascades on post deletion).
- Belongs to `User`.

**Indexes:** `postId`, `userId`

---

### Like

Records that a user liked a discovery post.

- `@@unique([postId, userId])` enforces one like per user per post at the database level.

**Relations:**
- Belongs to `DiscoverPost` (cascades on post deletion).
- Belongs to `User`.

**Unique:** `(postId, userId)` — database-enforced, also used as an index.

---

### Block

Records that one user has blocked another.

- `@@unique([blockerId, blockedId])` prevents duplicate blocks.
- The matching engine and messaging layer must query both `blockerId` and `blockedId` directions before allowing a match or message.

**Relations:**
- `blocker` → `User` (named `BlockGiver`)
- `blocked` → `User` (named `BlockReceiver`)

**Unique:** `(blockerId, blockedId)`  
**Indexes:** `blockerId`, `blockedId`

---

### Report

A polymorphic report against any content type.

- `targetType` identifies what kind of entity was reported.
- `targetId` is a UUID string but **not a foreign key** — the target may be a User, Message, Post, or Comment. Referential integrity is not enforced at the DB level here; it is validated at the service layer.
- `reason` is a free-text field (may later be replaced/supplemented with an enum of preset reasons).

**Relations:**
- `reporter` → `User` (named `ReportGiver`)

**Indexes:** `reporterId`, composite `(targetType, targetId)` for admin moderation queries

---

### Rating

A private 1–5 star rating submitted after a match session ends.

- Ratings are never exposed to the rated user.
- `@@unique([matchSessionId, raterId])` prevents a user from rating the same session twice.
- `qualityScore` on `Profile` is computed from aggregated `stars` values (logic in the ratings service).
- Repeated low ratings combined with reports can trigger moderation review (business logic in NestJS, not enforced here).

**Relations:**
- Belongs to `MatchSession`.
- `rater` → `User` (named `RatingGiver`)
- `rated` → `User` (named `RatingReceiver`)

**Unique:** `(matchSessionId, raterId)`  
**Indexes:** `ratedId`, `matchSessionId`

---

## Relation Map (summary)

```
User ──────────── Profile (1:1)
Profile ─────────── UserInterest (1:many) ─── Interest (many:1)
User ──────────── MatchSession (1:many, as A or B)
MatchSession ──── Conversation (1:0..1)
User ──────────── Conversation (1:many, as A or B)
Conversation ──── Message (1:many)
User ──────────── DiscoverPost (1:many)
DiscoverPost ──── Comment (1:many)
DiscoverPost ──── Like (1:many)
User ──────────── Block (1:many, as blocker or blocked)
User ──────────── Report (1:many, as reporter)
MatchSession ──── Rating (1:many)
User ──────────── Rating (1:many, as rater or rated)
```

---

## Notes for Terminal B (Realtime / Matching Engine)

- Match eligibility queries need: `Profile.gender`, `Profile.preferredGender`, `Profile.city`, `Profile.qualityScore`, `Profile.onboardingCompleted`, and `UserInterest` overlap.
- Block checks require querying `Block` in both directions `(userAId, userBId)` and `(userBId, userAId)`.
- `MatchSession.expiresAt` is the authoritative expiry record, but session timers are enforced in Redis — use this field for audit/recovery only.
- `MatchSession.status = MUTUAL_LIKE` is the trigger for `Conversation` creation.

## Notes for Terminal C (Flutter Mobile)

- `Profile.onboardingCompleted = false` means the user must be routed to the onboarding flow after login.
- `Message.status` is the source of truth for delivery/read receipts — updated via WebSocket from Terminal B's gateway.
- `Like.@@unique([postId, userId])` means the client should handle a 409 conflict on double-like gracefully.
