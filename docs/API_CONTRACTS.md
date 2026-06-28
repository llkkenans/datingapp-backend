# API Contracts

Base URL: `http://localhost:3000/api/v1` (dev) | `https://api.yourdomain.com/api/v1` (prod)  
Swagger UI: `http://localhost:3000/api/docs` (dev only)

All error responses follow the NestJS default shape: `{ statusCode, message, error }`.

---

## Authentication

### How clients authenticate

All protected endpoints require a **Supabase session JWT** sent as a Bearer token:

```
Authorization: Bearer <supabase_access_token>
```

**Client-side flow (Flutter / Terminal C):**

1. User signs in via Supabase Auth SDK (Google, Apple, email, phone).
2. Supabase SDK returns a session object containing `access_token`.
3. Flutter attaches this token as `Authorization: Bearer <access_token>` on every API request.
4. NestJS verifies the token signature using `SUPABASE_JWT_SECRET`.
5. On first valid request from a new user, NestJS creates a local `User` row (syncUser).
6. The controller receives the verified `userId` (Supabase UID) via `@CurrentUser()`.

**Token refresh:** Supabase tokens expire (default 1 hour). The Flutter SDK handles silent refresh automatically via `supabase.auth.onAuthStateChange`. Always use the current `session.accessToken` from the SDK — do not cache it manually.

---

### Protecting a route (NestJS pattern)

```typescript
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Get('me')
getMe(@CurrentUser() userId: string) {
  return this.usersService.findById(userId);
}
```

`JwtAuthGuard` and `CurrentUser` are exported from `AuthModule`. Any module that needs them must import `AuthModule`:

```typescript
@Module({
  imports: [AuthModule],
  controllers: [ProfilesController],
  providers: [ProfilesService],
})
export class ProfilesModule {}
```

---

### What `@CurrentUser()` returns

`@CurrentUser()` extracts `request.user.userId` — the **Supabase user UUID** — which is also the primary key of our `User` table (`User.id`). It is a string UUID.

---

### Error responses for auth failures

| Scenario | HTTP status | Body |
|----------|-------------|------|
| Missing `Authorization` header | `401 Unauthorized` | `{ "statusCode": 401, "message": "Unauthorized" }` |
| Expired token | `401 Unauthorized` | `{ "statusCode": 401, "message": "Unauthorized" }` |
| Invalid signature | `401 Unauthorized` | `{ "statusCode": 401, "message": "Unauthorized" }` |
| Service-role token used as user token | `401 Unauthorized` | `{ "statusCode": 401, "message": "Service role tokens are not accepted" }` |

---

## Global Conventions

### Request headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | On protected routes | `Bearer <supabase_access_token>` |
| `Content-Type` | On POST/PATCH/PUT | `application/json` |

### Standard error envelope

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request"
}
```

Validation errors (class-validator) return an array in `message`:

```json
{
  "statusCode": 400,
  "message": ["username must be a string", "city should not be empty"],
  "error": "Bad Request"
}
```

### Pagination

Implemented list endpoints use cursor-based pagination. Example:

```
GET /api/v1/conversations/:id/messages?before=<uuid>
```

Response includes `nextCursor` (UUID of oldest item in page, or `null`) and `hasMore` (boolean). See individual endpoint docs for exact shapes.

---

## Endpoints

### Health

#### `GET /health`

No auth required. Returns server status.

```json
{ "status": "ok", "timestamp": "2026-06-25T18:00:00.000Z" }
```

---

### Auth

NestJS has **no login or registration endpoints**. All auth flows happen client-side via the Supabase Auth SDK.

**syncUser** (internal — not an HTTP endpoint)  
Triggered by `JwtStrategy.validate()` on every valid JWT. Upserts a `User` row using the Supabase UID as `User.id`. If the user already exists, this is a no-op. Safe under concurrent requests.

---

### Users

#### `GET /api/v1/users/me`

**Auth:** Required

Returns the current authenticated user with their profile. If onboarding has not been completed, `profile` is `null` and `onboardingCompleted` is `false` — the client should redirect to the onboarding flow in this case.

**Response 200:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "phone": null,
  "authProvider": "GOOGLE",
  "status": "ACTIVE",
  "createdAt": "2026-06-25T00:00:00.000Z",
  "onboardingCompleted": true,
  "profile": {
    "id": "uuid",
    "userId": "uuid",
    "username": "john_doe",
    "birthDate": "2000-05-15T00:00:00.000Z",
    "gender": "MALE",
    "preferredGender": "FEMALE",
    "city": "Istanbul",
    "avatarUrl": null,
    "bio": "Love hiking and good coffee.",
    "qualityScore": 0,
    "onboardingCompleted": true,
    "updatedAt": "2026-06-25T00:00:00.000Z",
    "interests": [
      { "userId": "uuid", "interestId": "uuid", "interest": { "id": "uuid", "name": "Music" } }
    ]
  }
}
```

**Status codes:**
- `200` — success
- `401` — missing or invalid JWT
- `404` — User row not found (should not happen if JWT is valid — syncUser guarantees it exists)

---

### Onboarding

#### `POST /api/v1/onboarding/complete`

**Auth:** Required

Completes onboarding for the current user. Creates a `Profile` row and sets `onboardingCompleted: true`. Must be called exactly once — subsequent calls return 409.

**Request body:**
```json
{
  "username": "john_doe",
  "birthDate": "2000-05-15",
  "gender": "MALE",
  "preferredGender": "FEMALE",
  "city": "Istanbul",
  "bio": "Love hiking and good coffee.",
  "interestIds": ["uuid-1", "uuid-2"]
}
```

Field rules:
- `username`: 3–20 chars, alphanumeric + underscore only, case-insensitive unique check
- `birthDate`: ISO date string (YYYY-MM-DD), user must be ≥ 18 years old at time of request
- `gender`: `MALE` | `FEMALE` | `OTHER`
- `preferredGender`: `MALE` | `FEMALE` | `OTHER` | `ANY`
- `city`: 1–100 chars, required
- `bio`: optional, max 500 chars
- `interestIds`: optional array of Interest UUIDs from `GET /interests`

**Response 201:** Created profile object (same shape as `profile` in `GET /users/me`)

**Status codes:**

| Code | Meaning |
|------|---------|
| 201  | Profile created |
| 400  | Validation failure (age < 18, invalid username format, etc.) |
| 401  | Missing or invalid JWT |
| 409  | Onboarding already completed, or username already taken |

**Error examples:**
```json
{ "statusCode": 400, "message": "You must be at least 18 years old to use this app", "error": "Bad Request" }
{ "statusCode": 409, "message": "Onboarding already completed for this user", "error": "Conflict" }
{ "statusCode": 409, "message": "Username is already taken", "error": "Conflict" }
```

---

#### `GET /api/v1/onboarding/check-username?username=xyz`

**Auth:** Required

Quick availability check for a username. Used for live validation in the Flutter UI (client should debounce before calling). Does not reserve the username — a 409 can still occur on `POST /onboarding/complete` if there is a race.

**Query params:**
- `username` (required) — the username to check

**Response 200:**
```json
{ "available": true }
```
or
```json
{ "available": false }
```

**Status codes:** `200`, `401`

---

### Interests

#### `GET /api/v1/interests`

**Auth:** Not required (public endpoint)

Returns the full list of available interests. Call this before or during onboarding to render interest selection UI. UUIDs from this list are used as `interestIds` in `POST /onboarding/complete`.

**Response 200:**
```json
[
  { "id": "uuid", "name": "Art" },
  { "id": "uuid", "name": "Coffee" },
  { "id": "uuid", "name": "Cooking" }
]
```

Results are ordered alphabetically by name.

**Notes:**
- The initial interest list (20 items) is seeded via `prisma/seed.ts`. Run `npm run prisma:seed` after first migration.
- The list is a placeholder and may be revised before or after launch. See `docs/DECISIONS.md`.

---

### Profiles

#### `PATCH /api/v1/profiles/me`

**Auth:** Required

Update the current user's profile fields. All fields are optional — send only what needs to change. `birthDate` is not editable after onboarding (see DECISIONS.md D-022).

**Request body:**
```json
{
  "username": "new_handle",
  "gender": "FEMALE",
  "preferredGender": "ANY",
  "city": "Ankara",
  "bio": "Updated bio.",
  "interestIds": ["uuid-1", "uuid-2"]
}
```

Field rules:
- `username`: 3–20 chars, alphanumeric + underscore only; uniqueness checked excluding current user
- `gender`: `MALE` | `FEMALE` | `OTHER`
- `preferredGender`: `MALE` | `FEMALE` | `OTHER` | `ANY`
- `city`: 1–100 chars
- `bio`: max 500 chars
- `interestIds`: when present, **replaces** the full interest list atomically

**Response 200:** Updated profile object (same shape as `profile` in `GET /users/me`)

**Status codes:**

| Code | Meaning |
|------|---------|
| 200  | Profile updated |
| 400  | Validation failure or invalid interest IDs |
| 401  | Missing or invalid JWT |
| 404  | Profile not found |
| 409  | Username already taken |

---

### Match

#### `POST /api/v1/match/text`

Enter the text match queue.

**Auth:** Required

| Code | Meaning |
|------|---------|
| 202  | Accepted — user is now queued |
| 401  | Missing or invalid JWT |
| 409  | Already in a queue or already in an active session |

**Response 202:**
```json
{ "queued": true, "type": "TEXT" }
```

**Response 409:**
```json
{ "statusCode": 409, "message": "You are already waiting in the TEXT match queue", "error": "Conflict" }
```

---

#### `POST /api/v1/match/voice`

Enter the voice match queue. Identical behaviour to `/match/text`.

**Auth:** Required  
**Status codes:** Same as text.

**Response 202:**
```json
{ "queued": true, "type": "VOICE" }
```

---

#### `DELETE /api/v1/match/text`

Leave the text match queue. No-op (204) if not currently queued.

**Auth:** Required

| Code | Meaning |
|------|---------|
| 204  | Left queue, or was not in it |
| 401  | Missing or invalid JWT |

**Response:** empty body

---

#### `DELETE /api/v1/match/voice`

Leave the voice match queue. Same behaviour as `DELETE /match/text`.

**Auth:** Required  
**Status codes:** Same as text DELETE.

---

#### `GET /api/v1/match/sessions/:sessionId`

Get the current state of a match session.

**Anonymity guarantee:** This endpoint never returns the other participant's real username, display name, profile photo URL, or any other identity-revealing field. It returns only a positional role (`A` or `B`), `"You"` for the requester, and `"Stranger"` for the partner.

**Auth:** Required

| Code | Meaning |
|------|---------|
| 200  | Session view returned |
| 401  | Missing or invalid JWT |
| 403  | Requester is not a participant |
| 404  | Session does not exist |

**Response 200:**
```json
{
  "sessionId": "uuid",
  "type": "TEXT",
  "status": "ACTIVE",
  "expiresAt": "2026-06-25T18:26:45.000Z",
  "myRole": "A",
  "myLabel": "You",
  "partnerLabel": "Stranger",
  "iLiked": false,
  "partnerLiked": false
}
```

**Field notes:**
- `type`: `"TEXT"` or `"VOICE"`
- `status`: one of `PENDING`, `ACTIVE`, `MUTUAL_LIKE`, `ENDED`, `EXPIRED`
- `myRole`: positional — `"A"` or `"B"` (order in `MatchSession.userAId / userBId`)
- `iLiked`: whether the requesting user has sent a like in this session
- `partnerLiked`: always `false` — never revealed until mutual like resolves

---

#### `POST /api/v1/match/sessions/:sessionId/like`

Record that the requesting user liked the other party.

**Auth:** Required

| Code | Meaning |
|------|---------|
| 200  | Like recorded |
| 401  | Missing or invalid JWT |
| 403  | Not a participant |
| 404  | Session not found |
| 409  | Already liked this session |
| 410  | Session is no longer active |

**Response 200 — first like (waiting for partner):**
```json
{ "mutualLike": false }
```

**Response 200 — mutual like:**
```json
{ "mutualLike": true, "conversationId": "uuid" }
```

When `mutualLike: true`, navigate to the conversation. Both participants also receive `match.mutual_like` and `conversation.created` WebSocket events (see REALTIME_EVENTS.md).

---

#### `POST /api/v1/match/sessions/:sessionId/end`

End the session early. Both participants receive a `match.expired` WebSocket event and should show the 5-star rating screen. If the session is already in a terminal state (`ENDED`, `EXPIRED`, `MUTUAL_LIKE`), this is a no-op and returns 200.

**Auth:** Required

| Code | Meaning |
|------|---------|
| 200  | Session ended (or already in terminal state) |
| 401  | Missing or invalid JWT |
| 403  | Not a participant |
| 404  | Session not found |

**Response 200:**
```json
{ "sessionId": "uuid", "status": "ended" }
```

---

### Messaging

#### `GET /api/v1/conversations`

List all conversations the current user participates in, ordered by most recent message first (conversations with no messages sort by `createdAt` descending).

**Auth:** Required  
**Status codes:** `200`, `401`

**Response 200:**
```json
[
  {
    "id": "uuid",
    "otherUser": {
      "id": "uuid",
      "username": "alice",
      "avatarUrl": "https://..."
    },
    "lastMessage": {
      "id": "uuid",
      "content": "Hey there!",
      "photoUrl": null,
      "senderId": "uuid",
      "status": "READ",
      "createdAt": "2026-06-25T18:30:00.000Z"
    },
    "lastMessageAt": "2026-06-25T18:30:00.000Z",
    "createdAt": "2026-06-25T18:00:00.000Z"
  }
]
```

`lastMessage` and `lastMessageAt` are `null` if no messages have been sent yet.

---

#### `GET /api/v1/conversations/:id/messages`

Get a paginated page of messages (30 per page), ordered oldest-to-newest within the page.

**Auth:** Required

**Query params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `before` | string (UUID) | No | Cursor — returns messages older than this message ID |

| Code | Meaning |
|------|---------|
| 200  | Page returned |
| 403  | Not a participant |
| 404  | Conversation not found, or `before` cursor not found |

**Response 200:**
```json
{
  "messages": [
    {
      "id": "uuid",
      "conversationId": "uuid",
      "senderId": "uuid",
      "content": "Hello!",
      "photoUrl": null,
      "status": "READ",
      "createdAt": "2026-06-25T18:10:00.000Z"
    }
  ],
  "nextCursor": "uuid-of-oldest-message-in-page",
  "hasMore": true
}
```

**Pagination direction:** First call (no `before`) returns the 30 most recent messages. Pass `nextCursor` as `before` to fetch the next 30 older messages. `nextCursor` is `null` and `hasMore` is `false` on the last page.

---

#### `POST /api/v1/conversations/:id/messages`

Send a message. At least one of `content` or `photoUrl` must be present.

**Auth:** Required

**Request body:**
```json
{ "content": "Hello!", "photoUrl": null }
```

| Code | Meaning |
|------|---------|
| 201  | Message created |
| 400  | Neither `content` nor `photoUrl` provided |
| 403  | Not a participant, or either party has blocked the other |
| 404  | Conversation not found |

**Response 201:**
```json
{
  "id": "uuid",
  "conversationId": "uuid",
  "senderId": "uuid",
  "content": "Hello!",
  "photoUrl": null,
  "status": "SENT",
  "createdAt": "2026-06-25T18:30:00.000Z"
}
```

On success, a `message.new` WebSocket event is emitted to the recipient.

---

#### `POST /api/v1/conversations/:id/messages/:messageId/read`

Mark all messages from the other participant up to and including `messageId` as `READ`. Only the recipient (non-sender) may call this.

**Auth:** Required

| Code | Meaning |
|------|---------|
| 200  | Read receipts updated |
| 403  | Requester is the sender, or not a participant |
| 404  | Conversation or message not found |

**Response 200:**
```json
{ "readUpToMessageId": "uuid", "updatedCount": 3 }
```

`updatedCount` may be 0 if all were already READ. On any update > 0, a `message.read` WebSocket event is emitted to the original sender.

---

### Storage Uploads

#### `POST /api/v1/profiles/me/avatar`

Upload or replace the current user's profile avatar.

**Auth:** Required  
**Content-Type:** `multipart/form-data`  
**Field name:** `file`  
**Accepted types:** `image/jpeg`, `image/png`, `image/webp`  
**Max size:** 5 MB

| Code | Meaning |
|------|---------|
| 200  | Avatar uploaded |
| 400  | No file provided |
| 401  | Missing or invalid JWT |
| 413  | File exceeds 5 MB |
| 415  | Unsupported MIME type |
| 500  | Supabase Storage upload error |

**Response 200:**
```json
{ "avatarUrl": "https://<project>.supabase.co/storage/v1/object/public/avatars/{userId}/{timestamp}.jpg" }
```

**Notes:**
- Each upload uses a new timestamped path. Old files are **not deleted** — see D-019 in DECISIONS.md.
- The returned URL is written to `Profile.avatarUrl` atomically before the response is sent.
- Bucket: `avatars` (public read).

---

#### `POST /api/v1/conversations/:id/messages/photo`

Upload a photo and create a message in one step — no separate upload-then-reference flow required.

**Auth:** Required  
**Content-Type:** `multipart/form-data`  
**Field name:** `file`  
**Accepted types:** `image/jpeg`, `image/png`, `image/webp`  
**Max size:** 5 MB

| Code | Meaning |
|------|---------|
| 201  | Message created with `photoUrl` set |
| 400  | No file provided |
| 401  | Missing or invalid JWT |
| 403  | Not a participant, or a block exists |
| 413  | File exceeds 5 MB |
| 415  | Unsupported MIME type |
| 500  | Supabase Storage upload error |

**Response 201:**
```json
{
  "id": "uuid",
  "conversationId": "uuid",
  "senderId": "uuid",
  "content": null,
  "photoUrl": "https://<project>.supabase.co/storage/v1/object/public/message-photos/{conversationId}/{timestamp}-{senderId}.jpg",
  "status": "SENT",
  "createdAt": "2026-06-26T00:00:00.000Z"
}
```

**Notes:**
- Upload succeeds first, then the message row is created. If message creation fails after upload, the orphaned file remains in storage (acceptable for V1).
- Bucket: `message-photos` (public read). See D-019.
- The `message.new` WebSocket event is emitted to the recipient after creation.

---

### Ratings

#### `POST /api/v1/ratings`

**Auth:** Required

Submit a private 1–5 star rating after a match session ends. The rating is never shown to the rated user — it feeds the internal quality score used by the matching algorithm.

**Request body:**
```json
{ "sessionId": "uuid", "stars": 4 }
```

Field rules:
- `sessionId`: UUID of an ended `MatchSession` the requesting user participated in
- `stars`: integer, 1–5 inclusive

**Response 201:**
```json
{ "success": true }
```

| Code | Meaning |
|------|---------|
| 201  | Rating submitted |
| 400  | Session is still in progress |
| 401  | Missing or invalid JWT |
| 403  | Requesting user was not a participant |
| 404  | Session not found |
| 409  | Rating already submitted for this session |

**Error examples:**
```json
{ "statusCode": 400, "message": "You can only rate a session after it has ended", "error": "Bad Request" }
{ "statusCode": 403, "message": "You are not a participant in this session", "error": "Forbidden" }
{ "statusCode": 404, "message": "Match session not found", "error": "Not Found" }
{ "statusCode": 409, "message": "You have already submitted a rating for this session", "error": "Conflict" }
```

**Notes:**
- Callable for sessions with status `ENDED`, `EXPIRED`, or `MUTUAL_LIKE`.
- The `ratedId` is derived server-side — the client never specifies who is being rated.
- Ratings are strictly private; the client must never display another user's rating to them.

---

## WebSocket Event Reference (Summary)

Full contract in `docs/REALTIME_EVENTS.md`.

| Event | Namespace | Direction | Trigger |
|-------|-----------|-----------|---------|
| `match.found` | `/match` | S→C | Engine pairs two users |
| `match.expired` | `/match` | S→C | 3-minute timer fires **or** user calls `/end` |
| `match.partner_liked` | `/match` | S→C | Other participant sends a like (first like only) |
| `match.mutual_like` | `/match` | S→C | Both participants liked |
| `conversation.created` | `/match` | S→C | Permanent conversation created after mutual like |
| `message.new` | `/messages` | S→C | Other participant sends a message |
| `message.read` | `/messages` | S→C | Recipient marks messages as read |

---

## Integration Notes

### Backend (NestJS)

- All WebSocket connections must present the same Supabase JWT in the handshake (via `auth` object or query param `token`).
- The WebSocket gateway should call `AuthService.syncUser()` on connect to guarantee a local User row.
- Full WebSocket contract is in `docs/REALTIME_EVENTS.md`.

### Flutter (Terminal C)

- Never hardcode the JWT. Always read from `supabase.auth.currentSession?.accessToken`.
- Handle `401` responses by calling `supabase.auth.refreshSession()` then retrying once. If retry fails, redirect to login.
- `User.id` in all API responses equals the Supabase Auth UID — no mapping needed.
