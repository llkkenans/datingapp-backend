# API Contracts

Base URL: `http://localhost:3000/api/v1` (dev) | `https://api.yourdomain.com/api/v1` (prod)  
Swagger UI: `http://localhost:3000/api/docs` (dev only)

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

### Protecting a route (Terminal A / B pattern)

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

## Global conventions

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

### Pagination (planned — not yet implemented)

Future list endpoints will use cursor-based pagination:

```
GET /api/v1/discover/posts?cursor=<uuid>&limit=20
```

Response will include `{ data: [...], nextCursor: "<uuid> | null" }`.

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

NestJS does expose one implicit operation triggered on every authenticated request:

**syncUser** (internal — not an HTTP endpoint)  
Triggered by `JwtStrategy.validate()` on every valid JWT. Upserts a `User` row using the Supabase UID as `User.id`. If the user already exists, this is a no-op. Safe under concurrent requests.

---

### Users

#### `GET /api/v1/users/me`

**Auth:** Required (Bearer token)

Returns the current authenticated user with their profile. If onboarding has not been completed, `profile` is `null` and `onboardingCompleted` is `false` — Terminal C should redirect to the onboarding flow in this case.

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

**Errors:**
- `401` — missing or invalid JWT
- `404` — User row not found (should not happen if JWT is valid — syncUser guarantees it exists)

---

### Profiles

> ProfilesService is internal. No public endpoints in Phase 1. Methods are consumed by OnboardingModule.
> Future: `PATCH /api/v1/profiles/me` and `POST /api/v1/profiles/me/avatar` — to be defined.

---

### Onboarding

#### `POST /api/v1/onboarding/complete`

**Auth:** Required (Bearer token)

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

**Errors:**
- `400` — validation failure (e.g., age < 18, invalid username format)
  ```json
  { "statusCode": 400, "message": "You must be at least 18 years old to use this app", "error": "Bad Request" }
  ```
- `401` — missing or invalid JWT
- `409` — onboarding already completed for this user
  ```json
  { "statusCode": 409, "message": "Onboarding already completed for this user", "error": "Conflict" }
  ```
- `409` — username already taken
  ```json
  { "statusCode": 409, "message": "Username is already taken", "error": "Conflict" }
  ```

---

#### `GET /api/v1/onboarding/check-username?username=xyz`

**Auth:** Required (Bearer token)

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

**Errors:**
- `401` — missing or invalid JWT

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

### Match (Text + Voice)

> To be defined by Terminal B in Phase 3/4.

---

### Messages / Conversations

> To be defined in Phase 6.

---

### Discover Feed

> To be defined in Phase 6.

---

### Reports

> To be defined in Phase 1 — reports module implementation.

---

### Blocks

> To be defined in Phase 1 — blocks module implementation.

---

### Ratings

#### `POST /api/v1/ratings`

**Auth:** Required (Bearer token)

Submit a private 1–5 star rating for the other participant after a match session ends. The rating is never shown to the rated user — it feeds the internal quality score used by the matching algorithm.

**Request body:**
```json
{
  "sessionId": "uuid",
  "stars": 4
}
```

Field rules:
- `sessionId`: UUID of an ended `MatchSession` the requesting user participated in
- `stars`: integer, 1–5 inclusive

**Response 201:**
```json
{ "success": true }
```

**Errors:**
- `400` — session is still in progress (`PENDING` or `ACTIVE`)
  ```json
  { "statusCode": 400, "message": "You can only rate a session after it has ended", "error": "Bad Request" }
  ```
- `401` — missing or invalid JWT
- `403` — requesting user was not a participant in the session
  ```json
  { "statusCode": 403, "message": "You are not a participant in this session", "error": "Forbidden" }
  ```
- `404` — session not found
  ```json
  { "statusCode": 404, "message": "Match session not found", "error": "Not Found" }
  ```
- `409` — user already submitted a rating for this session (duplicate tap / retry)
  ```json
  { "statusCode": 409, "message": "You have already submitted a rating for this session", "error": "Conflict" }
  ```

**Notes:**
- Callable for sessions with status `ENDED`, `EXPIRED`, or `MUTUAL_LIKE`.
- The `ratedId` is derived server-side — the client never specifies who is being rated.
- Ratings are strictly private; Terminal C must never display another user's rating to them.

---

## Notes for Terminal B (Realtime)

- All WebSocket connections must present the same Supabase JWT in the handshake (via `auth` header or query param `token`).
- The WebSocket gateway should call `AuthService.syncUser()` on connect to guarantee a local User row.
- WebSocket event contracts are documented in `docs/REALTIME_EVENTS.md`.

## Notes for Terminal C (Flutter)

- Never hardcode the JWT. Always read from `supabase.auth.currentSession?.accessToken`.
- Handle `401` responses by calling `supabase.auth.refreshSession()` then retrying once. If retry fails, redirect to login.
- `User.id` in all API responses equals the Supabase Auth UID — no mapping needed.
