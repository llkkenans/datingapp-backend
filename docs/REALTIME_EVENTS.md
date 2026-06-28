# Realtime Events

Two WebSocket namespaces. Flutter clients connect to both independently.

| Namespace | Gateway file | Purpose |
|-----------|--------------|---------|
| `/match` | `src/websocket/match.gateway.ts` | Anonymous match session lifecycle |
| `/messages` | `src/websocket/messaging.gateway.ts` | Persistent conversation delivery |

Transport: Socket.IO (HTTP long-polling → WebSocket upgrade)  
Auth: JWT in `socket.handshake.auth.token`; verified server-side via `buildWsJwtMiddleware`.

---

## Connection

Client connects with:
```json
{
  "auth": {
    "userId": "<uuid>",
    "token": "<jwt>"
  }
}
```

Server disconnects the socket immediately if auth is missing or invalid.

---

## Event Inventories

### `/match` Namespace

| Direction | Event name | When |
|-----------|------------|------|
| server → client | `match.found` | Match engine pairs two users |
| server → client | `match.expired` | Session timer elapsed OR user called `/end` |
| server → client | `match.partner_liked` | Partner sent a like (before mutual) |
| server → client | `match.mutual_like` | Both users liked — session resolved |
| server → client | `conversation.created` | Permanent conversation created after mutual like |
| server → client | `session.message` | Ephemeral relay of an anonymous in-session message |
| server → client | `session.message.error` | Validation or auth rejection for `session.message` |
| client → server | `session.message` | Send a message during an active anonymous session |
| client → server | `match.send_like` | User taps Like during a session |
| client → server | `typing.start` / `typing.stop` | Typing indicator during anonymous text match |
| client → server | `heartbeat` | Presence keepalive |

### `/messages` Namespace

| Direction | Event name | When |
|-----------|------------|------|
| server → client | `message.new` | A new message arrives in a permanent conversation |
| server → client | `message.read` | Partner has read up to a given message |
| server → client | `message.typing` | Partner started or stopped typing |
| client → server | `message.typing.start` | User starts typing in a conversation |
| client → server | `message.typing.stop` | User stops typing (send, clear, or inactivity timeout) |

---

# `/match` Namespace

## Server → Client Events

### `match.found`

Emitted to **both** matched users when the engine pairs them. Each user receives their own event — for VOICE sessions `zegoToken` is user-specific and differs between recipients.

```typescript
// Always present
interface MatchFoundBase {
  sessionId: string;    // UUID of the MatchSession row
  type: 'TEXT' | 'VOICE';
  expiresAt: string;    // ISO 8601 — 3 minutes from session creation
}

// Additional fields when type === 'VOICE'
interface MatchFoundVoice extends MatchFoundBase {
  type: 'VOICE';
  roomId: string;       // ZEGOCLOUD room — always "voice-{sessionId}"
  zegoToken: string;    // ZEGOCLOUD Token04, scoped to this user and roomId, 2h lifetime
}
```

**Client behaviour (TEXT):**
- Navigate to the anonymous text chat screen
- Start the 3-minute countdown timer using `expiresAt`

**Client behaviour (VOICE):**
- Call `ZegoExpressEngine.loginRoom(roomId, ZegoUser(userId, username), config)` using the received `zegoToken`
- Start the 3-minute countdown timer using `expiresAt`
- On reconnect (network drop, app backgrounded): call `GET /api/v1/match/sessions/{sessionId}/rtc-token` for a fresh token — do NOT wait for a new `match.found` event

---

### `match.expired`

Sent on both timer expiry **and** when a user calls `POST /match/sessions/:id/end`. Client behaviour is identical in both cases.

```typescript
interface MatchExpiredPayload {
  sessionId: string;
}
```

**Client behaviour:**
- Dismiss the match screen
- Show the post-match rating UI
- Navigate back to the Match tab

---

### `match.partner_liked`

Emitted to the **other user** when one side sends a like (before mutual like is confirmed).

```typescript
interface MatchPartnerLikedPayload {
  sessionId: string;
}
```

**Client behaviour:**
- Show "Your match liked you!" indicator
- Do not reveal the partner's identity yet (anonymous session still active)

---

### `match.mutual_like`

Emitted to **both** users when both sides have liked each other. Transitions the session to `MUTUAL_LIKE` status.

```typescript
interface MatchMutualLikePayload {
  sessionId: string;
  conversationId: string;  // the newly created Conversation row
}
```

**Client behaviour:**
- For TEXT: session becomes unlimited; no longer expires
- For VOICE: call no longer subject to the 3-minute limit; continues until either party hangs up
- Show "It's a match!" celebration
- Conversation becomes available in the Messages tab

---

### `conversation.created`

Sent immediately after `match.mutual_like`. Each user receives the **other** person's profile details — anonymity is lifted at this point.

```typescript
interface ConversationCreatedPayload {
  conversationId: string;
  withUserId: string;         // the other participant's real user ID
  withUsername: string;       // the other participant's real username
  withAvatarUrl: string | null;
}
```

---

### `session.message` — server → client

Relayed to the **other** participant only. The sender does NOT receive a copy. No `senderId` is included — both users appear as "Stranger" to maintain anonymity.

```typescript
interface SessionMessageRelayPayload {
  sessionId: string;
  content: string;
  sentAt: string;   // server relay timestamp (ISO 8601) — not the client send time
}
```

There is no message ID; the client treats each event as a fire-and-forget display item. These messages are ephemeral — no history, no pagination, no replay after reconnect.

---

### `session.message.error` — server → client

Sent back to the **sender only** when their `session.message` is rejected. The partner never sees this event.

```typescript
interface SessionMessageErrorPayload {
  sessionId: string;
  reason: string;
}
```

Possible `reason` values:

| Reason | Cause |
|--------|-------|
| `Not authenticated` | Socket is not registered (internal guard) |
| `sessionId is required` | Payload missing or malformed sessionId |
| `content must be a non-empty string` | Missing or blank content |
| `content exceeds maximum length of 2000 characters` | Content too long |
| `Session not found or already ended` | Redis hash missing — session expired or ended |
| `You are not a participant in this session` | Sender userId not in userAId/userBId |
| `Session is not active (status: <STATUS>)` | Status is EXPIRED, ENDED, or MUTUAL_LIKE |

---

## Client → Server Events

### `session.message`

Send an ephemeral text message to the other anonymous participant during an ACTIVE match session.

**⚠ EPHEMERAL: NOT persisted anywhere (no DB write, no Redis write). The server is a pure relay.**

```typescript
interface SessionMessagePayload {
  sessionId: string;
  content: string;   // max 2,000 characters
}
```

**Validation rules:**
- `sessionId` must be a non-empty string.
- `content` must be a non-empty string, max 2,000 characters.
- Sender must be a participant in the session (`userAId` or `userBId` in `match:session:{sessionId}` Redis hash).
- Session `status` in Redis must be `ACTIVE`.

If any check fails, the server emits `session.message.error` back to the sender only.

---

### `match.send_like`

Signal that the user likes their current match partner.

```typescript
interface SendLikePayload {
  sessionId: string;
}
```

Server processing:
1. Validates session exists and user is a participant.
2. Sets `likeA` or `likeB` in the Redis session hash.
3. Emits `match.partner_liked` to the other user.
4. If both likes are set: transitions session to `MUTUAL_LIKE`, creates Conversation, emits `match.mutual_like` to both.

---

### `typing.start` / `typing.stop`

Typing indicator for the **anonymous text match chat** (not for permanent conversations — see `/messages` namespace below).

```typescript
interface MatchTypingPayload {
  sessionId: string;
}
```

Server forwards to the other participant. Auto-clears after 5 seconds if `typing.stop` never arrives.

---

### `heartbeat`

Client sends every **15 seconds** to maintain presence.

```typescript
{}  // no payload required
```

Server response: none (fire-and-forget). Server refreshes `presence:user:{userId}` TTL on receipt.

---

## Session Message Lifecycle

```
Client A                    Server (MatchGateway)              Client B
   |                               |                               |
   |-- session.message ----------->|                               |
   |   { sessionId, content }      |                               |
   |                               |-- hgetall match:session:id    |  (Redis lookup)
   |                               |<-- { userAId, userBId,        |
   |                               |     status: ACTIVE }          |
   |                               |                               |
   |                               |-- session.message ----------->|
   |                               |   { sessionId, content,       |
   |                               |     sentAt }                  |
   |                               |                               |
   | (no echo back to sender)      |                               |
```

If validation fails at any step, `session.message.error` is emitted back to Client A only.

---

## Redis Lookup — Why Not Postgres?

Session message relay uses `HGETALL match:session:{sessionId}` from Redis rather than a Postgres query:

- The `match:session:{id}` hash is written atomically when the session is created and deleted immediately when the session ends or expires.
- It is the authoritative real-time source for `status`, `userAId`, and `userBId`.
- An in-memory O(1) Redis read adds negligible latency on the hot path (every message relay).
- Postgres is the audit log; Redis is the truth for "is this session ACTIVE right now?"

---

## Persistence Boundary

| Layer | Anonymous session messages | Permanent conversation messages |
|-------|---------------------------|---------------------------------|
| Redis | not written | not applicable |
| Postgres | not written | written via MessagesService |

Anonymous in-session messages are relay-only. They vanish when the connection drops or the session ends. This is intentional — the product model is "talk first, reveal later," and history before mutual like would undermine anonymity.

---

# `/messages` Namespace

## Server → Client Events

### `message.new`

Emitted to the **recipient** when the other participant sends a message.

```typescript
interface MessageNewPayload {
  conversationId: string;
  message: {
    id: string;
    senderId: string;
    content: string | null;
    photoUrl: string | null;
    status: 'SENT';
    createdAt: string;   // ISO 8601
  };
}
```

**Client behaviour:**
- If the conversation is open: append the message to the chat UI
- If not open: increment the unread badge for this conversation
- No acknowledgement needed — delivery is best-effort (offline users miss the event)

---

### `message.read`

Emitted to the **original sender** when the recipient marks messages as read.

```typescript
interface MessageReadPayload {
  conversationId: string;
  readUpToMessageId: string;   // all messages at or before this one are now READ
  readAt: string;              // ISO 8601
}
```

**Client behaviour:**
- Update the status indicator (sent/delivered/read tick) for all messages up to `readUpToMessageId`

---

### `message.typing` — server → client

Relayed to the **other** participant only. Not persisted anywhere.

```typescript
interface MessageTypingRelayPayload {
  conversationId: string;
  userId: string;     // UUID of the typing user
  isTyping: boolean;  // true for typing.start relay, false for typing.stop relay
}
```

---

## Client → Server Events

### `message.typing.start` / `message.typing.stop`

Sent when the user starts or stops typing in a **permanent conversation**. Flutter **must debounce** — `typing.start` fires once when the user begins typing, not on every keystroke; `typing.stop` fires once on send or after a short inactivity timeout.

```typescript
interface MessageTypingPayload {
  conversationId: string;
}
```

**Validation rules (server-side, silent drop on failure):**
- Sender must be authenticated (socket registered via JWT middleware).
- `conversationId` must be a non-empty string.
- Sender must be `userAId` or `userBId` in the Conversation row (Postgres lookup).

Invalid events are silently dropped — no error is emitted back (typing indicators are fire-and-forget). Auto-clears after 5 seconds if `message.typing.stop` is not received.

---

## Error Events (both namespaces)

If the server rejects a client event, it responds with an acknowledgement error:

```typescript
interface AckError {
  error: string;   // human-readable message
  code: string;    // machine-readable: 'UNAUTHORIZED' | 'SESSION_NOT_FOUND' | 'ALREADY_LIKED' | ...
}
```

The `session.message.error` event in the `/match` namespace is an exception — it is emitted as a full server→client event rather than an acknowledgement, to support fire-and-forget sends.

---

## Known Limitations (V1)

1. **Single-device only** — one socket per `userId` per namespace. Multi-device support requires `userId → Set<socketId>`.
2. **JWT middleware not yet enforced on gateways** — `userId` from handshake auth is currently trusted without full cryptographic verification. Fix before production deploy.
3. **Several handlers not yet implemented** — `match.partner_liked`, `match.mutual_like`, `conversation.created`, `typing.*`, `match.send_like`, and `message.typing.*` are defined here as contracts; WebSocket receiver implementations are pending.
4. **No offline delivery** — events are dropped silently if the user is offline. Clients should fetch missed messages via REST (`GET /conversations/:id/messages`) on reconnect.
